"use client";

import React, { useState } from "react";
import { useTranslations } from "next-intl";
import { CheckCircle2, Clock, AlertTriangle, Copy, Check, UsersRound } from "lucide-react";

type Guest = {
    id: string;
    name: string | null;
    whatsapp_phone: string | null;
    email: string | null;
    share_amount: number;
    currency: string;
    payment_status: "pending" | "paid" | "cancelled" | "failed";
    stripe_payment_link_url: string | null;
    paid_at: string | null;
    notified_at: string | null;
};

interface Props {
    guests: Guest[];
}

/**
 * SAH-92: after the booker has invited friends to split the booking,
 * surface who has paid and who hasn't. Each pending row exposes a
 * one-click Copy link so the booker can resend it manually if the
 * automated WhatsApp/email didn't land.
 */
export function SplitStatusPanel({ guests }: Props) {
    const t = useTranslations("split_status");
    const [copiedId, setCopiedId] = useState<string | null>(null);
    if (!guests || guests.length === 0) return null;

    const paid = guests.filter((g) => g.payment_status === "paid").length;
    const total = guests.length;

    function copyLink(id: string, url: string | null) {
        if (!url) return;
        navigator.clipboard.writeText(url);
        setCopiedId(id);
        setTimeout(() => setCopiedId(null), 2000);
    }

    return (
        <div className="rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 p-4 space-y-3">
            <div className="flex items-center justify-between">
                <h3 className="text-sm font-semibold text-gray-900 dark:text-white flex items-center gap-2">
                    <UsersRound className="h-4 w-4 text-emerald-500" />
                    {t("heading")}
                </h3>
                <span className="text-xs text-gray-500 dark:text-gray-400">
                    {t("paid_count", { paid, total })}
                </span>
            </div>

            <ul className="divide-y divide-gray-100 dark:divide-gray-800">
                {guests.map((g) => {
                    const label = g.name || g.email || g.whatsapp_phone || t("unnamed_guest");
                    const statusIcon = g.payment_status === "paid"
                        ? <CheckCircle2 className="h-4 w-4 text-emerald-500 shrink-0" />
                        : g.payment_status === "failed" || g.payment_status === "cancelled"
                            ? <AlertTriangle className="h-4 w-4 text-red-500 shrink-0" />
                            : <Clock className="h-4 w-4 text-amber-500 shrink-0" />;
                    return (
                        <li key={g.id} className="py-2 flex items-start justify-between gap-3">
                            <div className="flex items-start gap-2 min-w-0">
                                {statusIcon}
                                <div className="min-w-0">
                                    <div className="text-sm font-medium text-gray-900 dark:text-white truncate">
                                        {label}
                                    </div>
                                    <div className="text-xs text-gray-500 dark:text-gray-400">
                                        {g.currency} {g.share_amount} · {t(`status_${g.payment_status}`)}
                                        {g.payment_status === "pending" && !g.notified_at && (
                                            <span className="ml-1 text-amber-600 dark:text-amber-400">· {t("not_notified")}</span>
                                        )}
                                    </div>
                                </div>
                            </div>
                            {g.payment_status === "pending" && g.stripe_payment_link_url && (
                                <button
                                    type="button"
                                    onClick={() => copyLink(g.id, g.stripe_payment_link_url)}
                                    className="shrink-0 inline-flex items-center gap-1 px-2 py-1 rounded-lg border border-gray-300 dark:border-gray-700 text-xs hover:bg-gray-50 dark:hover:bg-gray-800"
                                >
                                    {copiedId === g.id ? <Check className="h-3 w-3 text-emerald-500" /> : <Copy className="h-3 w-3" />}
                                    {copiedId === g.id ? t("copied") : t("copy_link")}
                                </button>
                            )}
                        </li>
                    );
                })}
            </ul>

            <p className="text-xs text-gray-500 dark:text-gray-400">
                {t("wallet_credit_note")}
            </p>
        </div>
    );
}
