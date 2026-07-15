/**
 * SAH-76: Upstash-backed rate limiting. Falls through cleanly when env
 * vars aren't set so non-prod environments aren't blocked. Each key uses a
 * sliding window — better burst behaviour than fixed-window for our load.
 *
 * Observability: every blocked request and every backend error is forwarded
 * to Sentry (as `warning` / `error` respectively). Production ops can then
 * filter on `policy` tags to spot abuse patterns.
 */

import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";
import { headers } from "next/headers";
import * as Sentry from "@sentry/nextjs";

let cachedRedis: Redis | null | undefined;
function getRedis(): Redis | null {
    if (cachedRedis !== undefined) return cachedRedis;
    const url = process.env.UPSTASH_REDIS_REST_URL;
    const token = process.env.UPSTASH_REDIS_REST_TOKEN;
    if (!url || !token) {
        cachedRedis = null;
        if (process.env.NODE_ENV === "production") {
            console.warn("[rate-limit] Upstash env vars missing — rate limiting disabled");
        }
        return null;
    }
    cachedRedis = new Redis({ url, token });
    return cachedRedis;
}

const limiters = new Map<string, Ratelimit>();
function getLimiter(name: string, points: number, windowSec: number): Ratelimit | null {
    const redis = getRedis();
    if (!redis) return null;
    let l = limiters.get(name);
    if (!l) {
        l = new Ratelimit({
            redis,
            limiter: Ratelimit.slidingWindow(points, `${windowSec} s`),
            analytics: true,
            prefix: `saha:rl:${name}`,
        });
        limiters.set(name, l);
    }
    return l;
}

async function callerKey(prefix: string, suffix?: string): Promise<string> {
    const h = await headers();
    const ip = h.get("x-forwarded-for")?.split(",")[0]?.trim()
        ?? h.get("x-real-ip")
        ?? "unknown";
    return suffix ? `${prefix}:${ip}:${suffix}` : `${prefix}:${ip}`;
}

export interface RateLimitResult {
    /** True when the call is permitted (or limiting is disabled). */
    success: boolean;
    /** Seconds until the next attempt is allowed; 0 when allowed. */
    retryAfter: number;
}

const POLICIES = {
    auth_login: { points: 5, windowSec: 15 * 60 },          // 5 / 15 min / IP
    auth_signup: { points: 3, windowSec: 60 * 60 },         // 3 / 1 h / IP
    auth_forgot: { points: 3, windowSec: 60 * 60 },         // 3 / 1 h / IP
    booking_create: { points: 20, windowSec: 60 * 60 },     // 20 / 1 h / IP
    review_submit: { points: 5, windowSec: 60 * 60 },       // 5 / 1 h / IP
    public_api: { points: 60, windowSec: 60 },              // 60 / 1 min / IP — generous for AI agents (SAH-35)
    messages_send: { points: 30, windowSec: 60 * 60 },      // 30 / 1 h / IP — matchmaking DM spam guard (SAH-96)
    matchmaking_post: { points: 10, windowSec: 60 * 60 },   // 10 / 1 h / IP — game-post spam guard (SAH-152)
    phone_otp_per_phone: { points: 3, windowSec: 60 * 60 }, // 3 / 1 h / phone — SAH-79
    phone_otp_per_user: { points: 5, windowSec: 24 * 60 * 60 }, // 5 / 24 h / user — SAH-79
} as const;

export type RatePolicy = keyof typeof POLICIES;

function reportBlocked(policy: RatePolicy, retryAfter: number, keyKind: "ip" | "owner") {
    Sentry.captureMessage(`rate-limit blocked: ${policy}`, {
        level: "warning",
        tags: { policy, key_kind: keyKind },
        extra: { retryAfter },
    });
}

function reportBackendError(policy: RatePolicy, err: unknown) {
    // Backend (Upstash) hiccup — we still allow the request to keep the
    // site working, but flag for ops so an outage doesn't go unnoticed.
    console.warn("[rate-limit] backend error, allowing request", err);
    Sentry.captureException(err, {
        level: "error",
        tags: { policy, kind: "rate_limit_backend_error" },
    });
}

/**
 * Options controlling behaviour when the limiter cannot be consulted.
 */
export interface RateLimitOptions {
    /**
     * When true, DENY the request if the rate-limit backend is unavailable
     * (missing Upstash env in production, or a backend error) instead of
     * allowing it. Use on auth / password-reset / OTP paths, where serving an
     * unthrottled request is worse than a brief, loud failure. Defaults to
     * false so non-security endpoints stay available.
     */
    failClosed?: boolean;
}

// Cool-off (seconds) suggested to the caller when we fail closed.
const FAIL_CLOSED_RETRY_SECONDS = 30;

/**
 * True only in REAL production. On Vercel, NODE_ENV is "production" for both
 * preview AND production builds, so we gate on VERCEL_ENV to avoid failing
 * closed on preview deploys (which frequently don't have Upstash scoped to
 * them). Falls back to NODE_ENV for non-Vercel production hosts.
 */
function isProductionRuntime(): boolean {
    const vercelEnv = process.env.VERCEL_ENV;
    if (vercelEnv) return vercelEnv === "production";
    return process.env.NODE_ENV === "production";
}

/**
 * Result to return when no limiter backend is configured. A fail-closed policy
 * DENIES in production — an auth endpoint with no rate-limit backend is a
 * misconfiguration, not a reason to serve unlimited attempts — and pages ops.
 * In dev/preview (where Upstash is often intentionally absent) it still allows
 * so local sign-in and preview testing keep working.
 */
function unavailableResult(policy: RatePolicy, opts?: RateLimitOptions): RateLimitResult {
    if (opts?.failClosed && isProductionRuntime()) {
        Sentry.captureMessage(`rate-limit backend unavailable — failing closed: ${policy}`, {
            level: "error",
            tags: { policy, kind: "rate_limit_unavailable_fail_closed" },
        });
        return { success: false, retryAfter: FAIL_CLOSED_RETRY_SECONDS };
    }
    return { success: true, retryAfter: 0 };
}

export async function rateLimit(policy: RatePolicy, suffix?: string, opts?: RateLimitOptions): Promise<RateLimitResult> {
    const cfg = POLICIES[policy];
    const limiter = getLimiter(policy, cfg.points, cfg.windowSec);
    if (!limiter) {
        return unavailableResult(policy, opts);
    }
    const key = await callerKey(policy, suffix);
    try {
        const { success, reset } = await limiter.limit(key);
        const retryAfter = success ? 0 : Math.max(0, Math.ceil((reset - Date.now()) / 1000));
        if (!success) reportBlocked(policy, retryAfter, "ip");
        return { success, retryAfter };
    } catch (err) {
        reportBackendError(policy, err);
        // Security-sensitive policies (auth, password reset, OTP) fail CLOSED so
        // an Upstash outage — or an attacker deliberately erroring it — cannot
        // silently disable throttling. Everything else fails OPEN for
        // availability (a court search shouldn't 500 because Redis blipped).
        if (opts?.failClosed) return { success: false, retryAfter: FAIL_CLOSED_RETRY_SECONDS };
        return { success: true, retryAfter: 0 };
    }
}

// SAH-79: per-phone and per-user OTP throttles need a key that ISN'T tied
// to the caller's IP — same phone from different IPs still consumes the
// same budget. This variant uses the supplied ownerKey directly.
export async function rateLimitByOwnerKey(policy: RatePolicy, ownerKey: string, opts?: RateLimitOptions): Promise<RateLimitResult> {
    const cfg = POLICIES[policy];
    const limiter = getLimiter(policy, cfg.points, cfg.windowSec);
    if (!limiter) {
        return unavailableResult(policy, opts);
    }
    try {
        const { success, reset } = await limiter.limit(`${policy}:owner:${ownerKey}`);
        const retryAfter = success ? 0 : Math.max(0, Math.ceil((reset - Date.now()) / 1000));
        if (!success) reportBlocked(policy, retryAfter, "owner");
        return { success, retryAfter };
    } catch (err) {
        reportBackendError(policy, err);
        if (opts?.failClosed) return { success: false, retryAfter: FAIL_CLOSED_RETRY_SECONDS };
        return { success: true, retryAfter: 0 };
    }
}
