/**
 * SECURITY (self-audit 2026-07-15): open-redirect guard.
 *
 * Returns `next` only when it is a safe, same-origin *path*; otherwise returns
 * `fallback`. Blocks:
 *   - absolute URLs         (https://evil.example, mailto:, javascript:, ...)
 *   - protocol-relative     (//evil.example, /\evil.example) — browsers treat
 *                            both as scheme-relative and navigate off-site
 *   - anything not starting with a single "/"
 *
 * Used on the post-login redirect and the OAuth callback, where `next` comes
 * from a client-controlled query param and was previously handed straight to
 * `redirect()` / `NextResponse.redirect()`.
 */
export function safeNextPath(next: string | null | undefined, fallback: string): string {
    if (typeof next !== "string" || next.length === 0) return fallback;
    // Must be a root-relative path.
    if (next[0] !== "/") return fallback;
    // Reject "//host" and "/\host" (protocol-relative → off-site).
    if (next[1] === "/" || next[1] === "\\") return fallback;
    return next;
}
