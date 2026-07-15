import { NextRequest, NextResponse } from "next/server";

/**
 * SECURITY (self-audit 2026-07-15): fail-closed cron authentication.
 *
 * Cron routes run under the service-role client (RLS bypass), so they must be
 * gated by CRON_SECRET. The previous inline check compared the incoming header
 * to a template literal:
 *
 *     if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) ...
 *
 * When CRON_SECRET was unset (e.g. a preview deploy, or a mis-named env var)
 * the expected value collapsed to the literal string "Bearer undefined", so
 * ANY caller sending `Authorization: Bearer undefined` was authenticated. This
 * helper fails CLOSED: a missing/empty secret rejects every request.
 *
 * @returns a 401 NextResponse when unauthorised, or `null` when the caller is a
 *          legitimate cron invocation (so the route can proceed).
 */
export function requireCronAuth(req: NextRequest): NextResponse | null {
    const secret = process.env.CRON_SECRET;
    const authHeader = req.headers.get("authorization");
    if (!secret || authHeader !== `Bearer ${secret}`) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    return null;
}
