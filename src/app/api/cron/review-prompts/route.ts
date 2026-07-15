import { NextRequest, NextResponse } from "next/server";
import { FROM_ADDRESS } from "@/lib/email-config";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireCronAuth } from "@/lib/cron-auth";
import { sendWhatsApp } from "@/lib/twilio";
import { Resend } from "resend";
import { format } from "date-fns";
import { captureRouteError } from "@/lib/sentry-helpers";

const ROUTE = "cron/review-prompts";

/**
 * SAH-94: Post-game review prompt. Sends a WhatsApp + email to the player
 * about an hour after their booking ends, asking them to leave a review.
 * Reviews now require a completed booking (SAH-83), so this is the natural
 * conversion moment.
 *
 * Schedule via vercel.json — runs hourly.
 */
export async function GET(req: NextRequest) {
    const unauthorized = requireCronAuth(req);
    if (unauthorized) return unauthorized;

    const resend = new Resend(process.env.RESEND_API_KEY);
    const supabase = createAdminClient();
    const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "";

    // Find completed bookings whose end_time was at least 1h ago, that haven't
    // had a prompt sent yet. We compare against (date + end_time) — bookings
    // hold them as DATE + TIME WITHOUT TIMEZONE in Asia/Dubai (assumed).
    const cutoff = new Date(Date.now() - 60 * 60 * 1000); // 1h ago, UTC
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: bookings } = await (supabase as any)
        .from("bookings")
        .select(`
            id, date, end_time, num_players, player_id,
            courts(name, facility_id, facilities(name)),
            profiles(display_name, phone)
        `)
        .eq("status", "completed")
        .is("review_prompt_sent_at", null)
        .limit(200);

    let sent = 0;
    let skipped = 0;
    let failed = 0;

    for (const booking of (bookings ?? []) as Array<{
        id: string;
        date: string;
        end_time: string;
        num_players: number;
        player_id: string;
        courts: { name: string; facility_id: string; facilities: { name: string } | null } | null;
        profiles: { display_name: string | null; phone: string | null } | null;
    }>) {
        // Build the booking-end timestamp in UTC. We treat date+end_time as
        // local-Dubai (UTC+4). 'YYYY-MM-DDTHH:MM:00+04:00' is unambiguous.
        const endIso = `${booking.date}T${booking.end_time.slice(0, 5)}:00+04:00`;
        const endTs = new Date(endIso);
        if (Number.isNaN(endTs.getTime()) || endTs > cutoff) {
            skipped++;
            continue;
        }

        const facilityName = booking.courts?.facilities?.name ?? "the facility";
        const courtName = booking.courts?.name ?? "your court";
        // SAH-113: deep-link straight to the quick-review page so the player
        // gets a 1-tap stars-only flow.
        const reviewUrl = `${appUrl}/en/review/${booking.id}`;
        const display = booking.profiles?.display_name ?? "there";
        const readableDate = format(new Date(booking.date), "EEEE, MMMM d");

        // Fetch email from auth (same pattern as reminder cron + webhook)
        const { data: { user } } = await supabase.auth.admin.getUserById(booking.player_id);
        const email = user?.email ?? null;

        if (email) {
            await resend.emails.send({
                from: FROM_ADDRESS,
                to: email,
                subject: `How was your game at ${facilityName}?`,
                html: `
                    <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:24px">
                        <h2 style="font-size:20px;font-weight:700;margin-bottom:4px">How was it?</h2>
                        <p style="color:#374151;margin-bottom:24px">
                            Hi ${display}, hope you enjoyed ${courtName} on ${readableDate}.
                            A quick review helps other players find a great court — takes 10 seconds.
                        </p>
                        <a href="${reviewUrl}" style="display:inline-block;background:#10b981;color:#fff;text-decoration:none;padding:12px 24px;border-radius:8px;font-weight:600">
                            Leave a quick review
                        </a>
                    </div>
                `,
            }).catch((err) => {
                captureRouteError(err, {
                    route: ROUTE,
                    extra: { booking_id: booking.id, channel: "email" },
                });
                failed++;
            });
        }

        if (booking.profiles?.phone) {
            await sendWhatsApp(
                booking.profiles.phone,
                `🎾 How was ${courtName} at ${facilityName}?\n\n` +
                `A quick rating helps other players. Takes 10s:\n${reviewUrl}`
            ).catch((err) => {
                captureRouteError(err, {
                    route: ROUTE,
                    extra: { booking_id: booking.id, channel: "whatsapp" },
                });
                failed++;
            });
        }

        await supabase
            .from("bookings")
            .update({ review_prompt_sent_at: new Date().toISOString() } as never)
            .eq("id", booking.id);

        sent++;
    }

    const status = sent === 0 && failed > 0 ? 500 : 200;
    return NextResponse.json({ sent, skipped, failed }, { status });
}
