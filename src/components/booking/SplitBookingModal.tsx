"use client";

import React, { useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { X, Plus, Trash2, Loader2, Copy, Check, MessageSquare } from "lucide-react";
import { splitBookingAction } from "@/app/[locale]/dashboard/actions";

interface Props {
    bookingId: string;
    totalPrice: number;
    currency: string;
    numPlayers: number;
    open: boolean;
    onClose: () => void;
}

type GuestRow = { name: string; whatsapp_phone: string; email: string };
type SentGuest = {
    id: string;
    name: string | null;
    whatsapp_phone: string | null;
    email: string | null;
    share_amount: number;
    url: string | null;
    notified_via: string[];
};

/**
 * SAH-92 bounce-back: bzo asked for the actual UI that connects to
 * `splitBookingAction`. This modal collects the guest list, calls the
 * action, then shows each guest's payment link + which channels we
 * managed to notify them on (WhatsApp / email), so the booker can copy
 * any link that didn't send through automatically.
 *
 * Limits: 1–7 guests (action enforces it too). The booker counts as one
 * payer, so a 4-player booking with 3 guests = 4 shares.
 */
export function SplitBookingModal({ bookingId, totalPrice, currency, numPlayers, open, onClose }: Props) {
    const t = useTranslations("split_modal");
    const initialCount = Math.max(1, Math.min(7, numPlayers - 1));
    const [guests, setGuests] = useState<GuestRow[]>(() =>
        Array.from({ length: initialCount }, () => ({ name: "", whatsapp_phone: "", email: "" })),
    );
    const [pending, startTransition] = useTransition();
    const [sentGuests, setSentGuests] = useState<SentGuest[] | null>(null);
    const [sharePerPerson, setSharePerPerson] = useState<number | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [copiedId, setCopiedId] = useState<string | null>(null);

    if (!open) return null;

    const previewShare = guests.length > 0
        ? (totalPrice / (guests.length + 1)).toFixed(2)
        : totalPrice.toFixed(2);

    function setRow(i: number, patch: Partial<GuestRow>) {
        setGuests((rs) => rs.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
    }
    function addRow() {
        if (guests.length >= 7) return;
        setGuests((rs) => [...rs, { name: "", whatsapp_phone: "", email: "" }]);
    }
    function removeRow(i: number) {
        setGuests((rs) => rs.filter((_, idx) => idx !== i));
    }

    function submit() {
        setError(null);
        const filtered = guests
            .map((g) => ({
                name: g.name.trim(),
                whatsapp_phone: g.whatsapp_phone.trim(),
                email: g.email.trim(),
            }))
            .filter((g) => g.name || g.whatsapp_phone || g.email);

        if (filtered.length === 0) {
            setError(t("error_at_least_one"));
            return;
        }

        // Require at least one contact channel per row so we have a way
        // to actually deliver the payment link.
        const missingChannel = filtered.find((g) => !g.whatsapp_phone && !g.email);
        if (missingChannel) {
            setError(t("error_need_contact"));
            return;
        }

        startTransition(async () => {
            const result = await splitBookingAction(bookingId, filtered);
            if ("error" in result && result.error) {
                setError(result.error);
                return;
            }
            if ("success" in result && result.success) {
                setSentGuests(result.guests as SentGuest[]);
                setSharePerPerson(result.sharePerPerson ?? null);
            }
        });
    }

    function copyLink(id: string, url: string | null) {
        if (!url) return;
        navigator.clipboard.writeText(url);
        setCopiedId(id);
        setTimeout(() => setCopiedId(null), 2000);
    }

    return (
        <div
            className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-end sm:items-center justify-center p-0 sm:p-4"
            onClick={onClose}
            role="dialog"
            aria-modal="true"
        >
            <div
                className="bg-white dark:bg-gray-900 rounded-t-2xl sm:rounded-2xl w-full max-w-lg max-h-[90vh] overflow-hidden flex flex-col"
                onClick={(e) => e.stopPropagation()}
            >
                <div className="px-5 py-4 border-b border-gray-200 dark:border-gray-800 flex items-center justify-between">
                    <h2 className="text-base font-semibold text-gray-900 dark:text-white">
                        {sentGuests ? t("sent_heading") : t("heading")}
                    </h2>
                    <button
                        onClick={onClose}
                        aria-label={t("close")}
                        className="p-1 rounded-lg text-gray-400 hover:text-gray-700 dark:hover:text-gray-200"
                    >
                        <X className="h-5 w-5" />
                    </button>
                </div>

                <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
                    {!sentGuests && (
                        <>
                            <p className="text-sm text-gray-500 dark:text-gray-400">
                                {t("subtitle")}
                            </p>
                            <div className="rounded-xl bg-emerald-50 dark:bg-emerald-900/20 border border-emerald-200 dark:border-emerald-800 px-3 py-2 text-sm text-emerald-700 dark:text-emerald-300">
                                {t("share_preview", { currency, amount: previewShare, count: guests.length + 1 })}
                            </div>

                            <ul className="space-y-3">
                                {guests.map((g, i) => (
                                    <li key={i} className="rounded-xl border border-gray-200 dark:border-gray-800 p-3 space-y-2">
                                        <div className="flex items-center justify-between">
                                            <span className="text-xs font-medium text-gray-500 dark:text-gray-400">
                                                {t("guest_n", { n: i + 1 })}
                                            </span>
                                            {guests.length > 1 && (
                                                <button
                                                    type="button"
                                                    onClick={() => removeRow(i)}
                                                    aria-label={t("remove_guest")}
                                                    className="p-1 rounded text-gray-400 hover:text-red-500"
                                                >
                                                    <Trash2 className="h-3.5 w-3.5" />
                                                </button>
                                            )}
                                        </div>
                                        <input
                                            type="text"
                                            value={g.name}
                                            onChange={(e) => setRow(i, { name: e.target.value })}
                                            placeholder={t("name_placeholder")}
                                            className="w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-1.5 text-sm"
                                        />
                                        <input
                                            type="tel"
                                            inputMode="tel"
                                            value={g.whatsapp_phone}
                                            onChange={(e) => setRow(i, { whatsapp_phone: e.target.value })}
                                            placeholder={t("phone_placeholder")}
                                            className="w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-1.5 text-sm"
                                        />
                                        <input
                                            type="email"
                                            value={g.email}
                                            onChange={(e) => setRow(i, { email: e.target.value })}
                                            placeholder={t("email_placeholder")}
                                            className="w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-1.5 text-sm"
                                        />
                                    </li>
                                ))}
                            </ul>

                            {guests.length < 7 && (
                                <button
                                    type="button"
                                    onClick={addRow}
                                    className="flex items-center gap-1.5 text-sm text-emerald-600 dark:text-emerald-400 hover:underline"
                                >
                                    <Plus className="h-3.5 w-3.5" />
                                    {t("add_guest")}
                                </button>
                            )}

                            {error && (
                                <p className="text-sm text-red-500" role="alert">{error}</p>
                            )}
                        </>
                    )}

                    {sentGuests && (
                        <>
                            <p className="text-sm text-gray-500 dark:text-gray-400">
                                {t("sent_subtitle", { currency, amount: sharePerPerson ?? 0 })}
                            </p>
                            <ul className="space-y-2">
                                {sentGuests.map((g) => (
                                    <li key={g.id} className="rounded-xl border border-gray-200 dark:border-gray-800 p-3">
                                        <div className="flex items-start justify-between gap-3">
                                            <div className="min-w-0">
                                                <div className="text-sm font-medium text-gray-900 dark:text-white truncate">
                                                    {g.name || g.email || g.whatsapp_phone || t("unnamed_guest")}
                                                </div>
                                                <div className="text-xs text-gray-500 dark:text-gray-400 flex items-center gap-1.5 mt-0.5">
                                                    {g.notified_via.length > 0 ? (
                                                        <>
                                                            <MessageSquare className="h-3 w-3" />
                                                            {t("notified_via", { channels: g.notified_via.join(", ") })}
                                                        </>
                                                    ) : (
                                                        <span className="text-amber-600 dark:text-amber-400">{t("not_notified")}</span>
                                                    )}
                                                </div>
                                            </div>
                                            {g.url && (
                                                <button
                                                    type="button"
                                                    onClick={() => copyLink(g.id, g.url)}
                                                    className="shrink-0 inline-flex items-center gap-1 px-2 py-1 rounded-lg border border-gray-300 dark:border-gray-700 text-xs hover:bg-gray-50 dark:hover:bg-gray-800"
                                                >
                                                    {copiedId === g.id ? <Check className="h-3 w-3 text-emerald-500" /> : <Copy className="h-3 w-3" />}
                                                    {copiedId === g.id ? t("copied") : t("copy_link")}
                                                </button>
                                            )}
                                        </div>
                                    </li>
                                ))}
                            </ul>
                            <p className="text-xs text-gray-500 dark:text-gray-400">
                                {t("wallet_credit_note")}
                            </p>
                        </>
                    )}
                </div>

                {!sentGuests ? (
                    <div className="px-5 py-3 border-t border-gray-200 dark:border-gray-800 flex items-center justify-end gap-2">
                        <button
                            type="button"
                            onClick={onClose}
                            className="px-4 py-2 rounded-lg text-sm font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800"
                        >
                            {t("cancel")}
                        </button>
                        <button
                            type="button"
                            onClick={submit}
                            disabled={pending}
                            className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-emerald-600 text-white text-sm font-medium hover:bg-emerald-700 disabled:opacity-50"
                        >
                            {pending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                            {t("create_links")}
                        </button>
                    </div>
                ) : (
                    <div className="px-5 py-3 border-t border-gray-200 dark:border-gray-800 flex items-center justify-end">
                        <button
                            type="button"
                            onClick={onClose}
                            className="px-4 py-2 rounded-lg bg-gray-900 dark:bg-white text-white dark:text-gray-900 text-sm font-medium"
                        >
                            {t("done")}
                        </button>
                    </div>
                )}
            </div>
        </div>
    );
}
