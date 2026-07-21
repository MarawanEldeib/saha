"use client";

import React, { useState } from "react";
import { useTranslations } from "next-intl";
import { FlaskConical, Copy, Check, ChevronDown, ChevronUp } from "lucide-react";

interface Props {
    /** Account country for the connected facility — picks the right test
     * bank routing/account fields. Defaults to AE since Saha launches in UAE. */
    accountCountry?: string;
}

type Row = { labelKey: string; value: string };

/**
 * SAH-64 bounce-back: bzo couldn't finish Stripe Connect onboarding because
 * Stripe was asking for real-world documents (passport, trade license, MOA,
 * bank statement). In test mode, Stripe accepts dummy values — the platform
 * just wasn't surfacing that anywhere, so the owner naturally assumed they
 * had to provide real docs.
 *
 * This banner only renders when STRIPE_SECRET_KEY starts with sk_test_,
 * makes the test-mode state obvious, and gives a copyable cheat sheet of
 * the magic Stripe test values for the most common onboarding fields.
 *
 * Reference: https://docs.stripe.com/connect/testing
 */
export function StripeTestModeBanner({ accountCountry }: Props) {
    const t = useTranslations("stripe_test_mode");
    const [expanded, setExpanded] = useState(false);
    const [copied, setCopied] = useState<string | null>(null);

    // Stripe test values — these are documented in
    // https://docs.stripe.com/connect/testing and accepted by every
    // hosted-onboarding deployment. We pick the UAE/AED bank as the
    // default since Saha launches in UAE; other countries fall back to
    // the US numbers which also pass.
    const country = (accountCountry ?? "AE").toUpperCase();
    const bankRoutingByCountry: Record<string, string> = {
        AE: "ABNANL2A",       // IBAN-style; Stripe accepts any valid BIC in test mode for AE
        US: "110000000",
        GB: "108800",
        SA: "RJHISARI",
    };
    const bankAccountByCountry: Record<string, string> = {
        AE: "AE070331234567890123456",
        US: "000123456789",
        GB: "00012345",
        SA: "SA0380000000608010167519",
    };

    const rows: Row[] = [
        { labelKey: "card_label", value: "4242 4242 4242 4242" },
        { labelKey: "card_exp_label", value: "12 / 34" },
        { labelKey: "card_cvc_label", value: "123" },
        { labelKey: "bank_routing_label", value: bankRoutingByCountry[country] ?? bankRoutingByCountry.US },
        { labelKey: "bank_account_label", value: bankAccountByCountry[country] ?? bankAccountByCountry.US },
        { labelKey: "ssn_label", value: "0000" },
        { labelKey: "id_number_label", value: "000000000" },
        { labelKey: "dob_label", value: "01 / 01 / 1901" },
        { labelKey: "phone_label", value: "0000000000" },
        { labelKey: "address_label", value: "address_full_match" },
    ];

    function copy(value: string) {
        navigator.clipboard.writeText(value);
        setCopied(value);
        setTimeout(() => setCopied(null), 2000);
    }

    return (
        <div className="rounded-xl border-2 border-dashed border-amber-300 dark:border-amber-700 bg-amber-50/60 dark:bg-amber-950/20 p-4 space-y-2">
            <div className="flex items-start gap-3">
                <FlaskConical className="h-5 w-5 text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" />
                <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between gap-2">
                        <h3 className="text-sm font-semibold text-amber-900 dark:text-amber-200">
                            {t("title")}
                        </h3>
                        <button
                            type="button"
                            onClick={() => setExpanded((v) => !v)}
                            className="text-xs text-amber-700 dark:text-amber-300 hover:underline inline-flex items-center gap-0.5"
                        >
                            {expanded ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
                            {expanded ? t("hide_cheatsheet") : t("show_cheatsheet")}
                        </button>
                    </div>
                    <p className="text-xs text-amber-800 dark:text-amber-300 mt-1 leading-relaxed">
                        {t("body")}
                    </p>
                </div>
            </div>

            {expanded && (
                <div className="rounded-lg bg-white dark:bg-gray-900 border border-amber-200 dark:border-amber-900/50 p-3 space-y-2">
                    <p className="text-xs text-gray-600 dark:text-gray-400 mb-2">
                        {t("cheatsheet_intro")}
                    </p>
                    <ul className="space-y-1.5">
                        {rows.map((r) => (
                            <li key={r.labelKey} className="flex items-center justify-between gap-3 text-xs">
                                <span className="text-gray-600 dark:text-gray-400 shrink-0">
                                    {t(r.labelKey)}
                                </span>
                                <div className="flex items-center gap-2 min-w-0">
                                    <code className="font-mono text-gray-900 dark:text-gray-100 bg-gray-100 dark:bg-gray-800 rounded px-1.5 py-0.5 truncate">
                                        {r.value}
                                    </code>
                                    <button
                                        type="button"
                                        onClick={() => copy(r.value)}
                                        aria-label={t("copy")}
                                        className="p-1 rounded text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 shrink-0"
                                    >
                                        {copied === r.value
                                            ? <Check className="h-3 w-3 text-emerald-500" />
                                            : <Copy className="h-3 w-3" />}
                                    </button>
                                </div>
                            </li>
                        ))}
                    </ul>
                    <p className="text-[11px] text-gray-500 dark:text-gray-400 mt-2">
                        {t("docs_link_prefix")}{" "}
                        <a
                            href="https://docs.stripe.com/connect/testing"
                            target="_blank"
                            rel="noreferrer"
                            className="underline hover:text-amber-700 dark:hover:text-amber-300"
                        >
                            docs.stripe.com/connect/testing
                        </a>
                    </p>
                </div>
            )}
        </div>
    );
}
