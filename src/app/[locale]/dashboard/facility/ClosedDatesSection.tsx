"use client";

import React from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { CalendarOff, Plus, Trash2 } from "lucide-react";
import {
    addFacilityClosedDateAction,
    removeFacilityClosedDateAction,
} from "../actions";

type ClosedDate = { closed_date: string; reason: string };

interface Props {
    facilityId: string;
    initialClosedDates: ClosedDate[];
}

/**
 * SAH-91: owner declares dates the facility is closed (holidays,
 * maintenance, Eid). A nightly cron sweeps confirmed bookings on these
 * dates, cancels them, refunds the player and fires a notification.
 *
 * This section is intentionally write-on-add (no batch save) — owners
 * tend to add closed dates one at a time as holidays come up, and
 * making it part of the big Save Changes button is a worse UX (you'd
 * lose unsaved changes if you navigated away).
 */
export function ClosedDatesSection({ facilityId, initialClosedDates }: Props) {
    const t = useTranslations("closed_dates");
    const router = useRouter();
    const [rows, setRows] = React.useState<ClosedDate[]>(initialClosedDates);
    const [date, setDate] = React.useState("");
    const [reason, setReason] = React.useState("");
    const [error, setError] = React.useState<string | null>(null);
    const [pending, setPending] = React.useState(false);

    const today = React.useMemo(() => new Date().toISOString().slice(0, 10), []);

    async function add() {
        if (!date) return;
        setError(null);
        setPending(true);
        const result = await addFacilityClosedDateAction(facilityId, date, reason.trim());
        setPending(false);
        if (result.error) {
            setError(result.error);
            return;
        }
        // Optimistic insert + sort.
        setRows((prev) => {
            const without = prev.filter((r) => r.closed_date !== date);
            return [...without, { closed_date: date, reason: reason.trim() }].sort(
                (a, b) => a.closed_date.localeCompare(b.closed_date),
            );
        });
        setDate("");
        setReason("");
        router.refresh();
    }

    async function remove(closedDate: string) {
        setError(null);
        const prev = rows;
        setRows((rs) => rs.filter((r) => r.closed_date !== closedDate));
        const result = await removeFacilityClosedDateAction(facilityId, closedDate);
        if (result.error) {
            setError(result.error);
            setRows(prev);
            return;
        }
        router.refresh();
    }

    return (
        <div className="bg-white dark:bg-gray-900 rounded-2xl border border-gray-200 dark:border-gray-800 p-6">
            <div className="flex items-center gap-2 mb-2">
                <CalendarOff className="h-4 w-4 text-emerald-500" />
                <h2 className="text-lg font-semibold text-gray-900 dark:text-white">{t("heading")}</h2>
            </div>
            <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">{t("hint")}</p>

            <div className="flex flex-col sm:flex-row gap-2 items-stretch sm:items-end">
                <div className="flex-1 min-w-0">
                    <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">{t("date_label")}</label>
                    <input
                        type="date"
                        min={today}
                        value={date}
                        onChange={(e) => setDate(e.target.value)}
                        className="w-full rounded-xl border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm text-gray-900 dark:text-gray-100"
                    />
                </div>
                <div className="flex-[2] min-w-0">
                    <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">{t("reason_label")}</label>
                    <input
                        type="text"
                        maxLength={200}
                        placeholder={t("reason_placeholder")}
                        value={reason}
                        onChange={(e) => setReason(e.target.value)}
                        className="w-full rounded-xl border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm text-gray-900 dark:text-gray-100"
                    />
                </div>
                <button
                    type="button"
                    disabled={!date || pending}
                    onClick={add}
                    className="inline-flex items-center justify-center gap-1.5 px-4 py-2 rounded-xl bg-emerald-600 text-white text-sm font-medium hover:bg-emerald-700 disabled:opacity-50"
                >
                    <Plus className="h-3.5 w-3.5" />
                    {t("add")}
                </button>
            </div>

            {error && <p className="text-sm text-red-500 mt-2" role="alert">{error}</p>}

            <ul className="mt-4 divide-y divide-gray-100 dark:divide-gray-800">
                {rows.length === 0 ? (
                    <li className="text-sm text-gray-400 italic py-2">{t("empty")}</li>
                ) : (
                    rows.map((r) => (
                        <li key={r.closed_date} className="flex items-center justify-between py-2">
                            <div className="flex-1 min-w-0">
                                <div className="text-sm font-medium text-gray-900 dark:text-white">
                                    {new Date(r.closed_date).toLocaleDateString(undefined, { weekday: "short", year: "numeric", month: "short", day: "numeric" })}
                                </div>
                                {r.reason ? (
                                    <div className="text-xs text-gray-500 dark:text-gray-400 truncate">{r.reason}</div>
                                ) : null}
                            </div>
                            <button
                                type="button"
                                onClick={() => remove(r.closed_date)}
                                aria-label={t("remove_aria")}
                                className="p-1.5 rounded-lg text-gray-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20"
                            >
                                <Trash2 className="h-4 w-4" />
                            </button>
                        </li>
                    ))
                )}
            </ul>
        </div>
    );
}
