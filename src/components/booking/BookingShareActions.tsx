"use client";

import { useState } from "react";
import { Copy, Check, Users, Calendar, ExternalLink, UsersRound } from "lucide-react";
import { format } from "date-fns";
import { useTranslations } from "next-intl";
import { SplitBookingModal } from "./SplitBookingModal";

interface Props {
    courtName: string;
    facilityName: string;
    date: string;
    startTime: string;
    endTime: string;
    address: string;
    totalPrice: number;
    currency: string;
    numPlayers: number;
    shareUrl: string;
    /** SAH-92: enables the "Split with friends" modal when present. Booker only. */
    bookingId?: string;
    /** SAH-92: hide the split button when a split is already in flight. */
    splitInProgress?: boolean;
}

function buildGCalUrl(props: Props) {
    const { facilityName, courtName, date, startTime, endTime, address } = props;
    const start = `${date.replace(/-/g, "")}T${startTime.replace(/:/g, "").slice(0, 6)}00`;
    const end = `${date.replace(/-/g, "")}T${endTime.replace(/:/g, "").slice(0, 6)}00`;
    const params = new URLSearchParams({
        action: "TEMPLATE",
        text: `${courtName} @ ${facilityName}`,
        dates: `${start}/${end}`,
        location: address,
    });
    return `https://calendar.google.com/calendar/render?${params}`;
}

function buildIcsContent(props: Props) {
    const { facilityName, courtName, date, startTime, endTime, address } = props;
    const start = `${date.replace(/-/g, "")}T${startTime.replace(/:/g, "").slice(0, 6)}00`;
    const end = `${date.replace(/-/g, "")}T${endTime.replace(/:/g, "").slice(0, 6)}00`;
    return [
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        "BEGIN:VEVENT",
        `DTSTART:${start}`,
        `DTEND:${end}`,
        `SUMMARY:${courtName} @ ${facilityName}`,
        `LOCATION:${address}`,
        "END:VEVENT",
        "END:VCALENDAR",
    ].join("\r\n");
}

export function BookingShareActions(props: Props) {
    const t = useTranslations("booking_share");
    const { totalPrice, currency, numPlayers, shareUrl, courtName, facilityName, date, startTime, bookingId, splitInProgress } = props;
    const [copied, setCopied] = useState(false);
    const [showSplit, setShowSplit] = useState(false);
    const [splitModalOpen, setSplitModalOpen] = useState(false);

    const readableDate = format(new Date(date), "EEEE, MMMM d");
    const waText = `Hey! I booked ${courtName} at ${facilityName} on ${readableDate} at ${startTime.slice(0, 5)}. Join me: ${shareUrl}`;
    const waUrl = `https://wa.me/?text=${encodeURIComponent(waText)}`;
    const gcalUrl = buildGCalUrl(props);
    const perPlayer = numPlayers > 0 ? (totalPrice / numPlayers).toFixed(0) : totalPrice;

    function copyLink() {
        navigator.clipboard.writeText(shareUrl);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
    }

    function downloadIcs() {
        const blob = new Blob([buildIcsContent(props)], { type: "text/calendar" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = "booking.ics";
        a.click();
        URL.revokeObjectURL(url);
    }

    return (
        <div className="space-y-3">
            {/* WhatsApp share */}
            <a
                href={waUrl}
                target="_blank"
                rel="noreferrer"
                className="flex items-center justify-center gap-2 w-full px-4 py-2.5 rounded-lg bg-[#25D366] text-white text-sm font-medium hover:opacity-90 transition-opacity"
            >
                <svg viewBox="0 0 24 24" className="h-4 w-4 fill-current" xmlns="http://www.w3.org/2000/svg">
                    <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z" />
                </svg>
                {t("whatsapp")}
            </a>

            {/* Copy link */}
            <button
                onClick={copyLink}
                className="flex items-center justify-center gap-2 w-full px-4 py-2.5 rounded-lg border border-gray-300 dark:border-gray-600 text-sm font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
            >
                {copied ? <Check className="h-4 w-4 text-emerald-500" /> : <Copy className="h-4 w-4" />}
                {copied ? t("link_copied") : t("copy_link")}
            </button>

            {/* Calendar buttons */}
            <div className="flex gap-2">
                <a
                    href={gcalUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 text-xs font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
                >
                    <Calendar className="h-3.5 w-3.5" />
                    {t("google_calendar")}
                    <ExternalLink className="h-3 w-3 opacity-50" />
                </a>
                <button
                    onClick={downloadIcs}
                    className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 text-xs font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
                >
                    <Calendar className="h-3.5 w-3.5" />
                    {t("apple_calendar")}
                </button>
            </div>

            {/* Cost split toggle */}
            {numPlayers > 1 && (
                <div className="bg-gray-50 dark:bg-gray-800/50 rounded-xl overflow-hidden">
                    <button
                        onClick={() => setShowSplit(!showSplit)}
                        className="flex items-center justify-between w-full px-4 py-3 text-sm font-medium text-gray-700 dark:text-gray-300"
                    >
                        <span className="flex items-center gap-2">
                            <Users className="h-4 w-4" />
                            {t("split_cost")}
                        </span>
                        <span className="text-xs text-gray-400">{showSplit ? t("hide") : t("show")}</span>
                    </button>
                    {showSplit && (
                        <div className="px-4 pb-3 border-t border-gray-200 dark:border-gray-700 pt-3 space-y-3">
                            <div className="text-sm text-gray-600 dark:text-gray-400">
                                {currency} {totalPrice} ÷ {numPlayers} players ={" "}
                                <span className="font-semibold text-gray-900 dark:text-white">{currency} {perPlayer} each</span>
                            </div>
                            {/* SAH-92: collect names + WhatsApp numbers, then create
                                a Stripe Payment Link per guest and notify each. */}
                            {bookingId && !splitInProgress && (
                                <button
                                    type="button"
                                    onClick={() => setSplitModalOpen(true)}
                                    className="flex items-center justify-center gap-2 w-full px-4 py-2 rounded-lg bg-emerald-600 text-white text-sm font-medium hover:bg-emerald-700"
                                >
                                    <UsersRound className="h-4 w-4" />
                                    {t("split_with_friends")}
                                </button>
                            )}
                            {splitInProgress && (
                                <p className="text-xs text-gray-500 dark:text-gray-400">
                                    {t("split_already_running")}
                                </p>
                            )}
                        </div>
                    )}
                </div>
            )}

            {bookingId && (
                <SplitBookingModal
                    bookingId={bookingId}
                    totalPrice={totalPrice}
                    currency={currency}
                    numPlayers={numPlayers}
                    open={splitModalOpen}
                    onClose={() => setSplitModalOpen(false)}
                />
            )}
        </div>
    );
}
