import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { safeNextPath } from "@/lib/safe-redirect";

/**
 * SAH-115: OAuth callback for Google (and future providers).
 * Supabase Auth redirects here after the user grants consent. We exchange
 * the auth code for a session, then sync profile metadata (name + avatar)
 * from the OAuth identity into our `profiles` row — but only when the
 * fields are still empty or still hold a previously-synced Google value.
 * Custom values set by the user via /account/settings are preserved.
 */
export async function GET(req: NextRequest, ctx: { params: Promise<{ locale: string }> }) {
    const { locale } = await ctx.params;
    const url = new URL(req.url);
    const code = url.searchParams.get("code");
    // SECURITY: sanitise the client-supplied `next` to a same-origin path so the
    // OAuth callback can't be turned into an open redirect. See safe-redirect.
    const next = safeNextPath(url.searchParams.get("next"), `/${locale}`);
    const errorDescription = url.searchParams.get("error_description");

    if (errorDescription) {
        const loginUrl = new URL(`/${locale}/login`, url);
        loginUrl.searchParams.set("error", errorDescription);
        return NextResponse.redirect(loginUrl);
    }

    if (!code) {
        return NextResponse.redirect(new URL(`/${locale}/login`, url));
    }

    const supabase = await createClient();
    const { data, error } = await supabase.auth.exchangeCodeForSession(code);
    if (error || !data?.user) {
        const loginUrl = new URL(`/${locale}/login`, url);
        loginUrl.searchParams.set("error", error?.message ?? "Could not complete sign in");
        return NextResponse.redirect(loginUrl);
    }

    const user = data.user;

    // Profile metadata sync. Use the admin client so we can read+write
    // without depending on RLS during the redirect window. The trigger
    // already created a row at signup; we top it up.
    try {
        const admin = createAdminClient();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { data: profile } = await (admin as any)
            .from("profiles")
            .select("display_name, avatar_url")
            .eq("id", user.id)
            .single();

        const meta = (user.user_metadata ?? {}) as {
            full_name?: string;
            name?: string;
            avatar_url?: string;
            picture?: string;
        };
        const oauthName = meta.full_name ?? meta.name ?? null;
        const oauthAvatar = meta.avatar_url ?? meta.picture ?? null;

        // Treat existing avatars hosted on googleusercontent.com as
        // previously-synced — safe to refresh. Anything else (custom upload
        // to Supabase Storage) is the user's choice; don't overwrite.
        const existingAvatar = profile?.avatar_url ?? null;
        const isPreviouslySyncedAvatar =
            !existingAvatar ||
            /googleusercontent\.com/i.test(existingAvatar);

        const update: Record<string, string | null> = {};
        // Treat the email as the trigger's fallback display name and refresh
        // it from OAuth — owners didn't choose to use their email as a
        // display name in this flow.
        const triggerFallbackName = profile?.display_name && profile.display_name === user.email;
        if ((!profile?.display_name || triggerFallbackName) && oauthName) {
            update.display_name = oauthName;
        }
        if (isPreviouslySyncedAvatar && oauthAvatar) update.avatar_url = oauthAvatar;

        if (Object.keys(update).length > 0) {
            await (admin as never as ReturnType<typeof createAdminClient>)
                .from("profiles")
                .update(update as never)
                .eq("id", user.id);
        }
    } catch (err) {
        // Don't block sign-in on metadata-sync failure.
        console.error("[auth/callback] profile sync failed", err);
    }

    return NextResponse.redirect(new URL(next, url));
}
