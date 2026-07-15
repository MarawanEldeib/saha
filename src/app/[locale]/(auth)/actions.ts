"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getLocale } from "next-intl/server";
import {
    loginSchema,
    registerSchema,
    forgotPasswordSchema,
    resetPasswordSchema,
} from "@/lib/validations";
import { rateLimit } from "@/lib/rate-limit";
import { sendPasswordResetEmail } from "@/lib/emails/password-reset-email";
import { tr } from "@/lib/i18n-errors";
import { safeNextPath } from "@/lib/safe-redirect";

// ---------------------------------------------------------------------------
// Login
// ---------------------------------------------------------------------------
export async function loginAction(formData: FormData) {
    // SAH-76: 5 attempts / 15 min / IP. Combined IP+email key so one IP
    // can't lock the same email out everywhere by hammering it.
    const rl = await rateLimit("auth_login", (formData.get("email") as string) ?? "", { failClosed: true });
    if (!rl.success) {
        return { error: `Too many attempts. Try again in ${rl.retryAfter}s.` };
    }

    const raw = {
        email: formData.get("email") as string,
        password: formData.get("password") as string,
    };

    const parsed = loginSchema.safeParse(raw);
    if (!parsed.success) {
        return { error: parsed.error.issues[0].message };
    }

    const supabase = await createClient();
    const { error } = await supabase.auth.signInWithPassword(parsed.data);

    if (error) {
        return { error: await tr("auth.invalid_credentials") };
    }

    const locale = formData.get("locale") as string ?? "en";
    const next = formData.get("next") as string | null;
    revalidatePath("/", "layout");
    // SECURITY: only redirect to a same-origin path — never an attacker-supplied
    // absolute/protocol-relative URL (open-redirect phishing). See safe-redirect.
    redirect(safeNextPath(next, `/${locale}`));
}

// ---------------------------------------------------------------------------
// Register
// ---------------------------------------------------------------------------
export async function registerAction(formData: FormData) {
    const rl = await rateLimit("auth_signup", undefined, { failClosed: true });
    if (!rl.success) {
        return { error: `Too many sign-ups from this IP. Try again in ${rl.retryAfter}s.` };
    }

    const raw = {
        display_name: formData.get("display_name") as string,
        email: formData.get("email") as string,
        password: formData.get("password") as string,
        confirm_password: formData.get("confirm_password") as string,
        role: formData.get("role") as string,
    };

    const parsed = registerSchema.safeParse(raw);
    if (!parsed.success) {
        return { error: parsed.error.issues[0].message };
    }

    const supabase = await createClient();
    const { data, error } = await supabase.auth.signUp({
        email: parsed.data.email,
        password: parsed.data.password,
        options: {
            data: {
                display_name: parsed.data.display_name,
                role: parsed.data.role,
            },
        },
    });

    if (error) {
        if (error.code === "user_already_exists") {
            return { error: await tr("auth.email_in_use") };
        }
        return { error: error.message };
    }

    // If email confirmation is disabled in Supabase, user is immediately signed in
    if (data.session) {
        const locale = formData.get("locale") as string ?? "en";
        revalidatePath("/", "layout");
        if (parsed.data.role === "business") {
            redirect(`/${locale}/dashboard/onboarding`);
        }
        redirect(`/${locale}`);
    }

    return { success: true };
}

// ---------------------------------------------------------------------------
// Forgot Password
//
// SAH-134: returns a discriminated result so the page can show specific
// UI for each case (sent, not_registered, rate_limited, etc.). The
// previous "always return generic success" guarded against email
// enumeration, but Saha's signup already leaks the same information
// (registering an existing email errors), so the trade-off doesn't help
// in practice — better UX wins.
// ---------------------------------------------------------------------------
export type ForgotPasswordResult =
    | { ok: true; code: "sent" }
    | { ok: false; code: "not_registered" }
    | { ok: false; code: "rate_limited"; retryAfter: number }
    | { ok: false; code: "invalid_email"; message: string }
    | { ok: false; code: "error"; message: string };

export async function forgotPasswordAction(formData: FormData): Promise<ForgotPasswordResult> {
    const rl = await rateLimit("auth_forgot", (formData.get("email") as string) ?? "", { failClosed: true });
    if (!rl.success) {
        return { ok: false, code: "rate_limited", retryAfter: rl.retryAfter };
    }

    const raw = { email: formData.get("email") as string };
    const parsed = forgotPasswordSchema.safeParse(raw);
    if (!parsed.success) {
        return { ok: false, code: "invalid_email", message: parsed.error.issues[0].message };
    }

    const locale = (formData.get("locale") as string) ?? "en";

    // SAH-133: mint the recovery URL via the admin API (no Supabase email),
    // then send via Resend with Saha branding.
    const admin = createAdminClient();
    const redirectTo = `${process.env.NEXT_PUBLIC_APP_URL}/${locale}/reset-password`;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (admin as any).auth.admin.generateLink({
        type: "recovery",
        email: parsed.data.email,
        options: { redirectTo },
    });

    if (error) {
        // Distinguish "user not found" from other failures so the UI can
        // show the right message. Supabase's error codes for unknown
        // recovery target vary across versions; match on the common ones.
        const msg = (error.message ?? "").toLowerCase();
        const code = (error.code ?? "").toLowerCase();
        const isUnknownUser =
            msg.includes("user not found") ||
            msg.includes("not registered") ||
            msg.includes("no user") ||
            code === "user_not_found";
        if (isUnknownUser) {
            return { ok: false, code: "not_registered" };
        }
        console.warn("[forgotPassword] generateLink failed", error.message);
        return { ok: false, code: "error", message: error.message ?? "Could not start password reset." };
    }

    const recoveryUrl: string | undefined = data?.properties?.action_link ?? data?.action_link;
    const recipientEmail: string | undefined = data?.user?.email ?? parsed.data.email;
    const recipientName: string | null =
        (data?.user?.user_metadata?.display_name as string | undefined) ?? null;

    if (!recoveryUrl || !recipientEmail) {
        console.warn("[forgotPassword] generateLink returned no action_link");
        return { ok: false, code: "error", message: "Could not generate reset link." };
    }

    // SAH-133 bounce-back: bzo reported "not receiving the reset email".
    // The previous fire-and-forget pattern silently swallowed Resend errors
    // (unverified domain, missing API key, throttling), so the action
    // returned ok:sent while no email actually went out. Await + surface
    // specific errors so deployment misconfig is visible immediately.
    if (!process.env.RESEND_API_KEY) {
        console.error("[forgotPassword] RESEND_API_KEY is not set on this deployment");
        return {
            ok: false,
            code: "error",
            message: "Email delivery isn't configured on this deployment. Add RESEND_API_KEY to the environment.",
        };
    }

    const sendResult = await sendPasswordResetEmail({
        recipientEmail,
        recipientName,
        recoveryUrl,
        locale,
    });

    if (!sendResult.success) {
        console.error("[forgotPassword] Resend send failed:", sendResult.error);
        return {
            ok: false,
            code: "error",
            message: sendResult.error ?? "Could not send the reset email. Please try again later.",
        };
    }

    return { ok: true, code: "sent" };
}

// ---------------------------------------------------------------------------
// Reset Password
// ---------------------------------------------------------------------------
export async function resetPasswordAction(formData: FormData) {
    const raw = {
        password: formData.get("password") as string,
        confirm_password: formData.get("confirm_password") as string,
    };

    const parsed = resetPasswordSchema.safeParse(raw);
    if (!parsed.success) {
        return { error: parsed.error.issues[0].message };
    }

    const supabase = await createClient();
    const { error } = await supabase.auth.updateUser({ password: parsed.data.password });

    if (error) {
        return { error: error.message };
    }

    const locale = formData.get("locale") as string ?? "en";
    redirect(`/${locale}/login`);
}

// ---------------------------------------------------------------------------
// Logout
// ---------------------------------------------------------------------------
export async function logoutAction() {
    const supabase = await createClient();
    const locale = await getLocale();
    await supabase.auth.signOut();
    revalidatePath("/", "layout");
    redirect(`/${locale}`);
}

