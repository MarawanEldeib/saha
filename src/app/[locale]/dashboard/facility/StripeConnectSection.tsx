"use client";

import { useState } from "react";
import { CheckCircle2, AlertCircle, ExternalLink, CreditCard, ArrowDownToLine, BadgeCheck, Wallet, Loader2, Clock, FileWarning } from "lucide-react";
import { useTranslations } from "next-intl";
import { StripeTestModeBanner } from "./StripeTestModeBanner";

type Props = {
    /** Owner has linked a Stripe account (charges may still be disabled). */
    hasAccount: boolean;
    /** Stripe `charges_enabled` — true once onboarding is fully accepted. */
    chargesEnabled: boolean;
    /** Stripe `details_submitted` — owner has filled in the Connect form. */
    detailsSubmitted: boolean;
    /** Stripe `payouts_enabled` — bank/iban accepted, payouts will land. */
    payoutsEnabled: boolean;
    /**
     * Stripe `requirements.currently_due` — items Stripe is actively
     * waiting on the owner to provide (documents, bank details, etc.).
     * Empty when Stripe is reviewing on its own side. SAH-64.
     */
    currentlyDue: string[];
    /**
     * Stripe `requirements.disabled_reason` — short machine-readable code
     * explaining why the account is currently restricted. Surfaced as
     * extra context on the needs-action banner.
     */
    disabledReason: string | null;
    /** Platform-side fee, mirrored in the disclosure copy. */
    platformFeePercent: number;
    /**
     * SAH-64 bounce-back: when STRIPE_SECRET_KEY is sk_test_, render the
     * test-mode cheat-sheet banner so owners know they can use dummy data
     * during onboarding instead of real KYC documents.
     */
    testMode?: boolean;
    /** Two-letter Stripe account country, used to pick the right test bank. */
    accountCountry?: string;
};

/**
 * Translate Stripe's verbose requirement keys into user-readable labels.
 * Keys are dot-paths like `documents.bank_account_ownership_verification.files`
 * or `person_1TVN.documents.passport.files`. Match on the suffix to keep
 * the map small.
 */
function labelForRequirement(key: string): string {
    const k = key.toLowerCase();
    if (k.includes("bank_account_ownership_verification")) return "Bank-account ownership proof (statement or letter)";
    if (k.includes("company_license")) return "Company trade license";
    if (k.includes("company_memorandum_of_association")) return "Memorandum of Association";
    if (k.includes("company_registration_verification")) return "Company registration document";
    if (k.includes("proof_of_registration")) return "Proof of business registration";
    if (k.includes("passport.files") || k.endsWith(".passport")) return "Passport photo / scan";
    if (k.includes("national_id_front") || k.includes("id_document.front")) return "ID document — front";
    if (k.includes("national_id_back") || k.includes("id_document.back")) return "ID document — back";
    if (k.includes("address.line1") || k.includes("address.city") || k.includes("address.country")) return "Business address";
    if (k.includes("phone")) return "Business phone number";
    if (k.includes("dob")) return "Owner date of birth";
    if (k.includes("verification.document")) return "Identity verification document";
    if (k.includes("external_account")) return "Bank account for payouts";
    if (k.includes("tos_acceptance")) return "Accept Stripe terms of service";
    // Fallback — strip the prefix and humanise.
    return key.replace(/^person_[A-Za-z0-9]+\./, "").replace(/\./g, " · ").replace(/_/g, " ");
}

/**
 * SAH-64: Stripe Connect onboarding entry point for facility owners.
 *
 * Uses Stripe's hosted onboarding flow (account links) instead of the
 * embedded Connect Components — bzo reported the embedded approach
 * silently failed to render forms (likely CSP or platform-config issue).
 * The hosted flow is the canonical Stripe Connect path: one button →
 * full-page Stripe form → return to the dashboard with status.
 *
 * Visual states:
 *   - ready       : green badge, "your courts are bookable" line, subtle Disconnect link
 *   - incomplete  : amber badge + checklist of remaining Stripe steps + Continue Setup CTA
 *   - none        : gray badge + "not connected" guidance + Connect Stripe CTA
 *
 * The 90/10 split disclosure stays visible in every state.
 */
export function StripeConnectSection({
    hasAccount: initialHasAccount,
    chargesEnabled: initialChargesEnabled,
    detailsSubmitted: initialDetailsSubmitted,
    payoutsEnabled: initialPayoutsEnabled,
    currentlyDue,
    disabledReason,
    platformFeePercent,
    testMode,
    accountCountry,
}: Props) {
    const t = useTranslations("facility_form");
    const tStripe = useTranslations("stripe_connect");
    const [hasAccount, setHasAccount] = useState(initialHasAccount);
    const [chargesEnabled, setChargesEnabled] = useState(initialChargesEnabled);
    const [redirecting, setRedirecting] = useState(false);
    const [disconnecting, setDisconnecting] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const ownerSharePercent = 100 - platformFeePercent;

    // SAH-64: five state machine.
    //   ready        — account exists + charges_enabled (players can pay)
    //   needs_action — details submitted but Stripe is asking the owner
    //                  for more (docs, bank, ID). Specific requirements
    //                  rendered as a list so the owner can act, not guess.
    //   verifying    — details submitted, no outstanding requirements;
    //                  Stripe is reviewing on its own time (hours/days).
    //   incomplete   — owner never finished the initial Connect form.
    //   none         — no account at all.
    const hasOutstandingRequirements = currentlyDue.length > 0;
    const state: "ready" | "needs_action" | "verifying" | "incomplete" | "none" =
        !hasAccount ? "none"
        : chargesEnabled ? "ready"
        : initialDetailsSubmitted
            ? (hasOutstandingRequirements ? "needs_action" : "verifying")
            : "incomplete";

    async function startOnboarding() {
        setRedirecting(true);
        setError(null);
        try {
            const res = await fetch("/api/stripe/connect", { method: "POST" });
            const json = await res.json();
            if (json.error || !json.url) {
                setError(json.error ?? tStripe("connect_failed"));
                setRedirecting(false);
                return;
            }
            // Hand off to Stripe's hosted onboarding. They redirect back to
            // /dashboard/facility?stripe=success when done, or ?stripe=refresh
            // if the user expired the account link.
            window.location.href = json.url;
        } catch {
            setError(tStripe("connect_failed"));
            setRedirecting(false);
        }
    }

    async function handleDisconnect() {
        if (!confirm(t("stripe_disconnect_confirm"))) return;
        setDisconnecting(true);
        setError(null);
        try {
            const res = await fetch("/api/stripe/disconnect", { method: "POST" });
            const json = await res.json();
            if (json.error) setError(json.error);
            else {
                setHasAccount(false);
                setChargesEnabled(false);
            }
        } catch {
            setError(tStripe("disconnect_error"));
        } finally {
            setDisconnecting(false);
        }
    }

    return (
        <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-2xl p-6 space-y-5">
            {/* Header */}
            <div className="flex items-start justify-between gap-4">
                <div>
                    <h2 className="text-lg font-semibold text-gray-900 dark:text-white">{t("stripe_heading")}</h2>
                    <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">{t("stripe_desc")}</p>
                </div>
                {state === "ready" ? (
                    <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-semibold bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-300 shrink-0">
                        <BadgeCheck className="h-3.5 w-3.5" />
                        {tStripe("badge_ready")}
                    </span>
                ) : state === "needs_action" ? (
                    <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-semibold bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-300 shrink-0">
                        <FileWarning className="h-3.5 w-3.5" />
                        {tStripe("badge_needs_action")}
                    </span>
                ) : state === "verifying" ? (
                    <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-semibold bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 shrink-0">
                        <Clock className="h-3.5 w-3.5" />
                        {tStripe("badge_verifying")}
                    </span>
                ) : state === "incomplete" ? (
                    <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-semibold bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-300 shrink-0">
                        <AlertCircle className="h-3.5 w-3.5" />
                        {tStripe("badge_incomplete")}
                    </span>
                ) : (
                    <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-semibold bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400 shrink-0">
                        {tStripe("badge_not_connected")}
                    </span>
                )}
            </div>

            {/* SAH-64 bounce-back: test-mode banner — visible in every state when active */}
            {testMode && <StripeTestModeBanner accountCountry={accountCountry} />}

            {/* 90 / 10 / Direct disclosure card — visible in every state */}
            <div className="rounded-xl border border-emerald-200 dark:border-emerald-900/50 bg-gradient-to-br from-emerald-50 to-emerald-50/30 dark:from-emerald-900/20 dark:to-emerald-900/5 p-4 grid grid-cols-3 gap-3 text-center">
                <div>
                    <div className="flex items-center justify-center mb-1 text-emerald-600 dark:text-emerald-400">
                        <Wallet className="h-4 w-4" />
                    </div>
                    <p className="text-xl font-bold text-gray-900 dark:text-white tabular-nums">{ownerSharePercent}%</p>
                    <p className="text-[11px] text-gray-600 dark:text-gray-400 mt-0.5">{tStripe("split_owner_label")}</p>
                </div>
                <div>
                    <div className="flex items-center justify-center mb-1 text-gray-500 dark:text-gray-400">
                        <CreditCard className="h-4 w-4" />
                    </div>
                    <p className="text-xl font-bold text-gray-900 dark:text-white tabular-nums">{platformFeePercent}%</p>
                    <p className="text-[11px] text-gray-600 dark:text-gray-400 mt-0.5">{tStripe("split_platform_label")}</p>
                </div>
                <div>
                    <div className="flex items-center justify-center mb-1 text-emerald-600 dark:text-emerald-400">
                        <ArrowDownToLine className="h-4 w-4" />
                    </div>
                    <p className="text-xl font-bold text-gray-900 dark:text-white">{tStripe("split_payout_value")}</p>
                    <p className="text-[11px] text-gray-600 dark:text-gray-400 mt-0.5">{tStripe("split_payout_label")}</p>
                </div>
            </div>
            <p className="text-xs text-gray-500 dark:text-gray-400 -mt-2 leading-relaxed">
                {tStripe("split_disclosure", { owner: ownerSharePercent, platform: platformFeePercent })}
            </p>

            {error && (
                <div className="rounded-lg border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950/30 px-3 py-2 text-sm text-red-700 dark:text-red-400" role="alert">
                    {error}
                </div>
            )}

            {/* State-specific CTA */}
            {state === "ready" && (
                <div className="flex items-center justify-between gap-3 pt-1 border-t border-gray-100 dark:border-gray-800">
                    <div className="flex items-center gap-2 text-sm text-emerald-600 dark:text-emerald-400 pt-3">
                        <CheckCircle2 className="h-4 w-4 shrink-0" />
                        <span>{tStripe("ready_body")}</span>
                    </div>
                    <button
                        onClick={handleDisconnect}
                        disabled={disconnecting}
                        className="text-xs text-gray-400 hover:text-red-500 dark:hover:text-red-400 transition-colors disabled:opacity-50 pt-3 shrink-0"
                    >
                        {disconnecting ? "…" : t("stripe_disconnect")}
                    </button>
                </div>
            )}

            {state === "needs_action" && (
                <div className="space-y-3 pt-1 border-t border-gray-100 dark:border-gray-800">
                    <div className="flex items-start gap-2 text-sm text-red-700 dark:text-red-300 pt-3">
                        <FileWarning className="h-4 w-4 mt-0.5 shrink-0" />
                        <span>{tStripe("needs_action_body")}</span>
                    </div>
                    <ul className="text-sm text-gray-700 dark:text-gray-300 space-y-1.5 ms-6 list-disc">
                        {currentlyDue.map((req) => (
                            <li key={req}>
                                {labelForRequirement(req)}
                                <span className="block text-[10px] text-gray-400 dark:text-gray-500 font-mono">{req}</span>
                            </li>
                        ))}
                    </ul>
                    {disabledReason && (
                        <p className="text-xs text-gray-500 dark:text-gray-400 ms-6">
                            {tStripe("needs_action_reason", { reason: disabledReason })}
                        </p>
                    )}
                    <button
                        onClick={startOnboarding}
                        disabled={redirecting}
                        className="inline-flex items-center gap-2 px-4 py-2.5 rounded-lg bg-[#635BFF] text-white text-sm font-semibold hover:bg-[#5851e5] disabled:opacity-60 transition-colors shadow-sm"
                    >
                        {redirecting ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                            <ExternalLink className="h-4 w-4" />
                        )}
                        {redirecting ? t("stripe_redirecting") : tStripe("continue_verification")}
                    </button>
                </div>
            )}

            {state === "verifying" && (
                <div className="space-y-3 pt-1 border-t border-gray-100 dark:border-gray-800">
                    <div className="flex items-start gap-2 text-sm text-blue-700 dark:text-blue-300 pt-3">
                        <Clock className="h-4 w-4 mt-0.5 shrink-0" />
                        <span>{tStripe("verifying_body")}</span>
                    </div>
                    <p className="text-xs text-gray-500 dark:text-gray-400 ms-6">{tStripe("verifying_hint")}</p>
                    <button
                        onClick={startOnboarding}
                        disabled={redirecting}
                        className="inline-flex items-center gap-2 px-4 py-2 rounded-lg border border-gray-300 dark:border-gray-600 text-sm font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 disabled:opacity-50 transition-colors"
                    >
                        {redirecting ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                            <ExternalLink className="h-4 w-4" />
                        )}
                        {redirecting ? t("stripe_redirecting") : tStripe("review_or_update")}
                    </button>
                </div>
            )}

            {state === "incomplete" && (
                <div className="space-y-3 pt-1 border-t border-gray-100 dark:border-gray-800">
                    <div className="flex items-start gap-2 text-sm text-amber-700 dark:text-amber-300 pt-3">
                        <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
                        <span>{tStripe("incomplete_body")}</span>
                    </div>
                    <ul className="text-xs text-gray-600 dark:text-gray-400 space-y-1 ms-6 list-disc">
                        {!initialDetailsSubmitted && <li>{tStripe("checklist_details")}</li>}
                        {!chargesEnabled && <li>{tStripe("checklist_charges")}</li>}
                        {!initialPayoutsEnabled && <li>{tStripe("checklist_payouts")}</li>}
                    </ul>
                    <button
                        onClick={startOnboarding}
                        disabled={redirecting}
                        className="inline-flex items-center gap-2 px-4 py-2.5 rounded-lg bg-[#635BFF] text-white text-sm font-semibold hover:bg-[#5851e5] disabled:opacity-60 transition-colors shadow-sm"
                    >
                        {redirecting ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                            <ExternalLink className="h-4 w-4" />
                        )}
                        {redirecting ? t("stripe_redirecting") : tStripe("continue_setup")}
                    </button>
                </div>
            )}

            {state === "none" && (
                <div className="space-y-3 pt-1 border-t border-gray-100 dark:border-gray-800">
                    <div className="flex items-start gap-2 text-sm text-amber-700 dark:text-amber-300 pt-3">
                        <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
                        <span>{t("stripe_not_connected")}</span>
                    </div>
                    <button
                        onClick={startOnboarding}
                        disabled={redirecting}
                        className="inline-flex items-center gap-2 px-5 py-2.5 rounded-lg bg-[#635BFF] text-white text-sm font-semibold hover:bg-[#5851e5] disabled:opacity-60 transition-colors shadow-sm"
                    >
                        {redirecting ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                            <ExternalLink className="h-4 w-4" />
                        )}
                        {redirecting ? t("stripe_redirecting") : t("stripe_connect")}
                    </button>
                    <p className="text-xs text-gray-400 dark:text-gray-500">
                        {tStripe("hosted_hint")}
                    </p>
                </div>
            )}
        </div>
    );
}
