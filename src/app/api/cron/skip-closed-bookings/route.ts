import { NextRequest, NextResponse } from "next/server";
import { Resend } from "resend";
import { FROM_ADDRESS } from "@/lib/email-config";
import { createAdminClient } from "@/lib/supabase/admin";
import { getStripe } from "@/lib/stripe";
import { sendPushToUser } from "@/lib/web-push";
import { sendWhatsApp } from "@/lib/twilio";
import { logAuditEvent } from "@/lib/audit";
import { captureRouteError } from "@/lib/sentry-helpers";

const ROUTE = "cron/skip-closed-bookings";

/**
 * SAH-91: nightly sweep that cancels + refunds bookings whose `date` matches
 * a row in `facility_closed_dates` for the booking's facility. Notifies the
 * player via web push, email and WhatsApp (best-effort).
 *
 * Idempotent — re-running on the same day is a no-op because the WHERE
 * clause excludes already-cancelled bookings.
 *
 * Runs daily, chained from `cron/auto-complete-matches` so we stay within
 * Vercel Hobby's max-1-cron-per-day-per-path budget.
 */
export async function GET(req: NextRequest) {
    const authHeader = req.headers.get("authorization");
    if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const supabase = createAdminClient();
    const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;

    // Pull every future closed date the platform knows about. Past dates
    // don't matter — by definition the booking has already happened (or
    // was already marked no_show by the other cron).
    const today = new Date().toISOString().slice(0, 10);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: closedRows } = await (supabase as any)
        .from("facility_closed_dates")
        .select("facility_id, closed_date, reason")
        .gte("closed_date", today);

    type ClosedRow = { facility_id: string; closed_date: string; reason: string };
    const rows = (closedRows ?? []) as ClosedRow[];
    if (rows.length === 0) {
        return NextResponse.json({ cancelled: 0, refunded: 0, notified: 0, failed: 0 }, { status: 200 });
    }

    // Bucket dates per facility — fewer round trips than one query per row.
    const byFacility = new Map<string, Set<string>>();
    const reasonByFacilityDate = new Map<string, string>();
    for (const r of rows) {
        if (!byFacility.has(r.facility_id)) byFacility.set(r.facility_id, new Set());
        byFacility.get(r.facility_id)!.add(r.closed_date);
        reasonByFacilityDate.set(`${r.facility_id}|${r.closed_date}`, r.reason);
    }

    let cancelled = 0;
    let refunded = 0;
    let notified = 0;
    let failed = 0;

    for (const [facilityId, dateSet] of byFacility) {
        const dates = Array.from(dateSet);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { data: bookings } = await (supabase as any)
            .from("bookings")
            .select(`
                id, date, start_time, end_time, status, player_id, availability_id,
                courts!inner(id, name, facility_id, facilities(name, address, city)),
                profiles(display_name, phone, phone_verified)
            `)
            .eq("courts.facility_id", facilityId)
            .in("status", ["confirmed", "pending"])
            .in("date", dates);

        for (const booking of (bookings ?? []) as Array<{
            id: string; date: string; start_time: string; end_time: string;
            status: string; player_id: string; availability_id: string;
            courts: { name: string; facilities: { name: string; address: string; city: string } | null } | null;
            profiles: { display_name: string | null; phone: string | null; phone_verified: boolean | null } | null;
        }>) {
            try {
                // Stripe refund — best-effort. We still flip the booking to
                // cancelled even if the refund fails so the slot is released.
                const { data: payment } = await supabase
                    .from("payments")
                    .select("stripe_payment_intent_id, status")
                    .eq("booking_id", booking.id)
                    .single();

                let didRefund = false;
                if (
                    payment?.stripe_payment_intent_id
                    && (payment as { status: string }).status === "succeeded"
                ) {
                    try {
                        await getStripe().refunds.create({
                            payment_intent: payment.stripe_payment_intent_id,
                        });
                        await supabase
                            .from("payments")
                            .update({ status: "refunded" } as never)
                            .eq("booking_id", booking.id);
                        didRefund = true;
                    } catch (err) {
                        captureRouteError(err, {
                            route: ROUTE,
                            level: "error",
                            extra: { booking_id: booking.id, phase: "stripe_refund" },
                        });
                    }
                }

                // Flip booking + release slot.
                await supabase
                    .from("bookings")
                    .update({ status: "cancelled" } as never)
                    .eq("id", booking.id)
                    .in("status", ["confirmed", "pending"]);
                if (booking.availability_id) {
                    await supabase
                        .from("court_availability")
                        .update({ is_booked: false } as never)
                        .eq("id", booking.availability_id);
                }

                await logAuditEvent({
                    actorId: null,
                    actorRole: "system",
                    action: "booking.cancel.facility_closed",
                    targetType: "booking",
                    targetId: booking.id,
                    metadata: {
                        facility_id: facilityId,
                        closed_date: booking.date,
                        reason: reasonByFacilityDate.get(`${facilityId}|${booking.date}`) ?? "",
                        refunded: didRefund,
                        prior_status: booking.status,
                    },
                });

                cancelled++;
                if (didRefund) refunded++;

                // Notify the player — push + email + WhatsApp, best-effort.
                const reason = reasonByFacilityDate.get(`${facilityId}|${booking.date}`) ?? "";
                const facilityName = booking.courts?.facilities?.name ?? "the facility";
                const courtName = booking.courts?.name ?? "your court";
                const readableDate = new Date(booking.date).toLocaleDateString("en-GB", {
                    weekday: "long", year: "numeric", month: "long", day: "numeric",
                });
                const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "";
                const bookingUrl = `${appUrl}/en/bookings/${booking.id}`;

                // Web push (free, no recipient PII needed).
                await sendPushToUser(booking.player_id, {
                    title: `Booking cancelled — ${facilityName}`,
                    body: reason
                        ? `${courtName} is closed on ${readableDate}: ${reason}. ${didRefund ? "We've refunded your payment." : ""}`
                        : `${courtName} is closed on ${readableDate}. ${didRefund ? "We've refunded your payment." : ""}`,
                    url: `/en/bookings/${booking.id}`,
                }).catch((err) => {
                    captureRouteError(err, { route: ROUTE, extra: { booking_id: booking.id, channel: "push" } });
                });

                // Email — needs auth.users lookup for the address.
                if (resend) {
                    const { data: { user: playerUser } } = await supabase.auth.admin.getUserById(booking.player_id);
                    const playerEmail = playerUser?.email ?? null;
                    if (playerEmail) {
                        await resend.emails.send({
                            from: FROM_ADDRESS,
                            to: playerEmail,
                            subject: `Booking cancelled — ${courtName} on ${readableDate}`,
                            html: `
                                <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:24px">
                                    <h2 style="font-size:20px;font-weight:700;margin-bottom:4px">Your booking has been cancelled</h2>
                                    <p style="color:#6b7280;margin-bottom:24px">
                                        Hi ${booking.profiles?.display_name ?? "there"}, ${facilityName} has marked ${readableDate} as closed.
                                        ${reason ? `Reason: <strong>${escapeHtml(reason)}</strong>.` : ""}
                                    </p>
                                    <div style="background:#f9fafb;border-radius:12px;padding:20px;margin-bottom:24px">
                                        <p style="margin:0 0 8px"><strong>Court:</strong> ${courtName}</p>
                                        <p style="margin:0 0 8px"><strong>Facility:</strong> ${facilityName}</p>
                                        <p style="margin:0 0 8px"><strong>Date:</strong> ${readableDate}</p>
                                        <p style="margin:0 0 8px"><strong>Time:</strong> ${booking.start_time.slice(0, 5)} – ${booking.end_time.slice(0, 5)}</p>
                                        <p style="margin:0"><strong>Refund:</strong> ${didRefund ? "Issued back to your original payment method (typically 5–10 business days)." : "If your booking was paid, our team will process the refund manually."}</p>
                                    </div>
                                    <a href="${bookingUrl}" style="display:inline-block;background:#111827;color:#fff;text-decoration:none;padding:12px 24px;border-radius:8px;font-weight:600">
                                        View booking
                                    </a>
                                </div>
                            `,
                        }).catch((err) => {
                            captureRouteError(err, { route: ROUTE, extra: { booking_id: booking.id, channel: "email" } });
                        });
                    }
                }

                // SAH-79 rule: only WhatsApp verified numbers.
                if (booking.profiles?.phone && booking.profiles?.phone_verified) {
                    await sendWhatsApp(
                        booking.profiles.phone,
                        `❌ Your booking at ${facilityName} on ${readableDate} was cancelled — the facility marked the day closed${reason ? ` (${reason})` : ""}.\n\n` +
                        `${didRefund ? "💰 We've refunded your payment to the original card." : "If your booking was paid, our team will issue a refund manually."}\n\n` +
                        `Details: ${bookingUrl}`,
                    ).catch((err) => {
                        captureRouteError(err, { route: ROUTE, extra: { booking_id: booking.id, channel: "whatsapp" } });
                    });
                }

                notified++;
            } catch (err) {
                captureRouteError(err, {
                    route: ROUTE, level: "error",
                    extra: { booking_id: booking.id, facility_id: facilityId, date: booking.date },
                });
                failed++;
            }
        }
    }

    // SAH-157: non-200 if every booking failed so Vercel monitor escalates.
    const status = cancelled === 0 && failed > 0 ? 500 : 200;
    return NextResponse.json({ cancelled, refunded, notified, failed }, { status });
}

function escapeHtml(s: string): string {
    return s
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}
