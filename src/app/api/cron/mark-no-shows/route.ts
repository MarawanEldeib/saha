import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireCronAuth } from "@/lib/cron-auth";
import { logAuditEvent } from "@/lib/audit";
import { captureRouteError } from "@/lib/sentry-helpers";
import { GET as runReviewPrompts } from "../review-prompts/route";

const ROUTE = "cron/mark-no-shows";

/**
 * SAH-86: Mark yesterday's confirmed bookings as no_show and increment the
 * player's reliability counter. Idempotent — re-running on the same day is a
 * no-op because the matching set narrows after the first run.
 *
 * Also chains the SAH-94 review-prompts pass at the end so we stay within
 * Vercel's free-tier cron-count limit. Both jobs operate on yesterday's
 * bookings, so a single nightly invocation makes sense.
 *
 * Schedule via vercel.json — runs daily at 23:00 UTC (03:00 GST).
 */
export async function GET(req: NextRequest) {
    const unauthorized = requireCronAuth(req);
    if (unauthorized) return unauthorized;

    const supabase = createAdminClient();

    // Yesterday in UTC. Bookings whose date is yesterday and status is still
    // 'confirmed' did not get checked in — they are no-shows.
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: bookings } = await (supabase as any)
        .from("bookings")
        .select("id, player_id")
        .eq("status", "confirmed")
        .eq("date", yesterday);

    let marked = 0;
    let failed = 0;
    const playerCounts = new Map<string, number>();

    for (const booking of (bookings ?? []) as Array<{ id: string; player_id: string }>) {
        const { error } = await supabase
            .from("bookings")
            .update({ status: "no_show" } as never)
            .eq("id", booking.id)
            .eq("status", "confirmed");

        if (error) {
            captureRouteError(error, {
                route: ROUTE,
                extra: { booking_id: booking.id, player_id: booking.player_id },
            });
            failed++;
            continue;
        }

        playerCounts.set(booking.player_id, (playerCounts.get(booking.player_id) ?? 0) + 1);

        await logAuditEvent({
            actorId: null,
            actorRole: "system",
            action: "booking.no_show",
            targetType: "booking",
            targetId: booking.id,
            metadata: { player_id: booking.player_id, date: yesterday },
        });
        marked++;
    }

    // Increment per-player counter once per player, not once per booking.
    for (const [playerId, count] of playerCounts) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { data: profile } = await (supabase as any)
            .from("profiles")
            .select("no_show_count")
            .eq("id", playerId)
            .single();
        const current = (profile?.no_show_count ?? 0) as number;

        await supabase
            .from("profiles")
            .update({ no_show_count: current + count } as never)
            .eq("id", playerId);
    }

    // Chain the daily review-prompts pass. Either result is fine — log on
    // failure but never block the no-show cron's success.
    let reviewPrompts: { sent?: number; skipped?: number; error?: string } = {};
    try {
        const res = await runReviewPrompts(req);
        reviewPrompts = await res.json();
    } catch (err) {
        captureRouteError(err, { route: ROUTE, extra: { phase: "chained_review_prompts" } });
        reviewPrompts = { error: "review_prompts_failed" };
    }

    // SAH-157: surface bulk failure as non-200 so Vercel cron monitor alerts.
    const status = marked === 0 && failed > 0 ? 500 : 200;
    return NextResponse.json(
        { marked, failed, players_affected: playerCounts.size, review_prompts: reviewPrompts },
        { status },
    );
}
