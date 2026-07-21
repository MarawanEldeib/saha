import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireCronAuth } from "@/lib/cron-auth";
import { captureRouteError } from "@/lib/sentry-helpers";
import { GET as runSkipClosedBookings } from "../skip-closed-bookings/route";

const ROUTE = "cron/auto-complete-matches";

/**
 * SAH-152 Phase 7: marks `matchmaking_posts` rows as completed once their
 * scheduled window has elapsed.
 *
 *   completed_at_threshold = scheduled_for + (duration_minutes minutes)
 *
 * Runs hourly. Idempotent — re-running on the same row is a no-op
 * because the WHERE clause excludes rows whose status is already
 * 'completed' or 'cancelled'.
 */
export async function GET(req: NextRequest) {
    const unauthorized = requireCronAuth(req);
    if (unauthorized) return unauthorized;

    const supabase = createAdminClient();

    try {
        // Fetch every open match whose start time is in the past — anything
        // still upcoming can't have ended yet so it's safe to skip server-side.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { data: rows } = await (supabase as any)
            .from("matchmaking_posts")
            .select("id, scheduled_for, duration_minutes")
            .eq("status", "open")
            .lte("scheduled_for", new Date().toISOString());

        let marked = 0;
        const nowMs = Date.now();
        for (const r of (rows ?? []) as Array<{
            id: string; scheduled_for: string; duration_minutes: number;
        }>) {
            const endMs = new Date(r.scheduled_for).getTime() + (r.duration_minutes ?? 60) * 60 * 1000;
            if (nowMs < endMs) continue;
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const { error: updErr } = await (supabase as any)
                .from("matchmaking_posts")
                .update({ status: "completed", is_active: false })
                .eq("id", r.id)
                .eq("status", "open");
            if (updErr) {
                captureRouteError(updErr, { route: ROUTE, extra: { match_id: r.id } });
                continue;
            }
            marked++;
        }

        // SAH-91: chain the daily closed-bookings sweep. Vercel Hobby caps
        // daily crons at one per path, so we piggyback on this nightly run
        // instead of declaring a second cron entry. Either result is fine —
        // log on failure but never block the matches cron's 200.
        let skipClosed: { cancelled?: number; refunded?: number; notified?: number; failed?: number; error?: string } = {};
        try {
            const res = await runSkipClosedBookings(req);
            skipClosed = await res.json();
        } catch (err) {
            captureRouteError(err, { route: ROUTE, extra: { phase: "chained_skip_closed_bookings" } });
            skipClosed = { error: "skip_closed_bookings_failed" };
        }

        return NextResponse.json({ marked, skip_closed: skipClosed }, { status: 200 });
    } catch (err) {
        captureRouteError(err, { route: ROUTE });
        return NextResponse.json({ error: "auto_complete_failed" }, { status: 500 });
    }
}
