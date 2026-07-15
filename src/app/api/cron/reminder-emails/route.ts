import { NextRequest, NextResponse } from "next/server";
import { FROM_ADDRESS } from "@/lib/email-config";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireCronAuth } from "@/lib/cron-auth";
import { sendWhatsApp } from "@/lib/twilio";
import { Resend } from "resend";
import { format } from "date-fns";
import { captureRouteError } from "@/lib/sentry-helpers";

const ROUTE = "cron/reminder-emails";

export async function GET(req: NextRequest) {
    const unauthorized = requireCronAuth(req);
    if (unauthorized) return unauthorized;

    const resend = new Resend(process.env.RESEND_API_KEY);

    // Use the admin (service-role) client. The cron runs without a session
    // cookie, so the regular cookie-bound server client would have no auth
    // user and RLS would hide every booking row.
    const supabase = createAdminClient();

    // Vercel Hobby caps crons at 1/day so we run at 07:00 UTC (11:00 UAE)
    // and remind for everything in the next ~24h: tomorrow's bookings get
    // ~24h notice, and today's late-day slots (booked after the previous
    // morning's cron) get a few hours' notice instead of nothing.
    const today = new Date();
    const tomorrow = new Date(today);
    tomorrow.setUTCDate(today.getUTCDate() + 1);
    const todayKey = today.toISOString().split("T")[0];
    const tomorrowKey = tomorrow.toISOString().split("T")[0];

    const { data: bookings } = await supabase
        .from("bookings")
        .select(`
            id, date, start_time, end_time, num_players, total_price, currency,
            player_id,
            courts(name, facilities(name, address, city)),
            profiles(display_name, phone, phone_verified)
        `)
        .eq("status", "confirmed")
        .in("date", [todayKey, tomorrowKey])
        .eq("reminder_sent", false);

    let sent = 0;
    let failed = 0;

    for (const booking of bookings ?? []) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const b = booking as any;
        const court = b.courts;
        const facility = court?.facilities;
        const profile = b.profiles;

        // The actual email lives on auth.users, not profiles. The previous
        // version used a PostgREST alias `email:id` that aliased the UUID
        // column AS email and tried to send mail to a UUID-shaped string.
        let playerEmail: string | null = null;
        if (b.player_id) {
            const { data: { user } } = await supabase.auth.admin.getUserById(b.player_id);
            playerEmail = user?.email ?? null;
        }

        const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "";
        const bookingUrl = `${appUrl}/en/bookings/${booking.id}`;
        const readableDate = format(new Date(booking.date), "EEEE, MMMM d, yyyy");
        const isToday = booking.date === todayKey;
        const heading = isToday ? "Your booking is today!" : "Your booking is tomorrow";
        const subjectPrefix = isToday ? "Your booking is today" : "Your booking is tomorrow";
        const whatsappLead = isToday
            ? "📅 Reminder: your booking is today!"
            : "📅 Reminder: your booking is tomorrow!";

        // Send email reminder
        if (playerEmail) {
            await resend.emails.send({
                from: FROM_ADDRESS,
                to: playerEmail,
                subject: `${subjectPrefix} – ${court?.name}`,
                html: `
                    <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:24px">
                        <h2 style="font-size:20px;font-weight:700;margin-bottom:4px">${heading}</h2>
                        <p style="color:#6b7280;margin-bottom:24px">
                            Hi ${profile?.display_name ?? "there"}, here's a reminder for your upcoming booking.
                        </p>
                        <div style="background:#f9fafb;border-radius:12px;padding:20px;margin-bottom:24px">
                            <p style="margin:0 0 8px"><strong>Court:</strong> ${court?.name}</p>
                            <p style="margin:0 0 8px"><strong>Facility:</strong> ${facility?.name}</p>
                            <p style="margin:0 0 8px"><strong>Date:</strong> ${readableDate}</p>
                            <p style="margin:0 0 8px"><strong>Time:</strong> ${booking.start_time.slice(0, 5)} – ${booking.end_time.slice(0, 5)}</p>
                            <p style="margin:0 0 8px"><strong>Players:</strong> ${booking.num_players}</p>
                            <p style="margin:0"><strong>Address:</strong> ${facility?.address}, ${facility?.city}</p>
                        </div>
                        <a href="${bookingUrl}" style="display:inline-block;background:#111827;color:#fff;text-decoration:none;padding:12px 24px;border-radius:8px;font-weight:600">
                            View Booking & QR Code
                        </a>
                    </div>
                `,
            }).catch((err) => {
                captureRouteError(err, {
                    route: ROUTE,
                    extra: { booking_id: booking.id, channel: "email", player_email: playerEmail },
                });
                failed++;
            });
        }

        // SAH-79: only send WhatsApp to verified phones — otherwise we
        // could be paging the wrong person.
        if (profile?.phone && profile?.phone_verified) {
            await sendWhatsApp(
                profile.phone,
                `${whatsappLead}\n\n` +
                `🏟 ${court?.name} at ${facility?.name}\n` +
                `📅 ${readableDate}\n` +
                `⏰ ${booking.start_time.slice(0, 5)} – ${booking.end_time.slice(0, 5)}\n` +
                `📍 ${facility?.address}, ${facility?.city}\n\n` +
                `View QR code: ${bookingUrl}`
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
            .update({ reminder_sent: true } as never)
            .eq("id", booking.id);

        sent++;
    }

    // SAH-157: non-200 when every send failed so Vercel cron monitor escalates.
    const status = sent === 0 && failed > 0 ? 500 : 200;
    return NextResponse.json({ sent, failed }, { status });
}
