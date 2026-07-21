import { createClient } from "@/lib/supabase/server";
import { notFound, redirect } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import { format } from "date-fns";
import { CheckCircle, XCircle, Clock, MapPin } from "lucide-react";
import Link from "next/link";
import { headers } from "next/headers";
import { BookingQRCode } from "@/components/booking/BookingQRCode";
import { BookingShareActions } from "@/components/booking/BookingShareActions";
import { BookingStatusWatcher } from "@/components/booking/BookingStatusWatcher";
import { CompletePaymentButton } from "@/components/booking/CompletePaymentButton";
import { MoveBookingPanel } from "@/components/booking/MoveBookingPanel";
import { SplitStatusPanel } from "@/components/booking/SplitStatusPanel";
import { CancelButton } from "../CancelButton";
import { CancelSeriesButton } from "../CancelSeriesButton";

export const metadata = { title: "Booking – Saha" };

export default async function BookingPage({
    params,
    searchParams,
}: {
    params: Promise<{ id: string }>;
    searchParams: Promise<{ success?: string; cancelled?: string }>;
}) {
    const { id } = await params;
    const { success, cancelled } = await searchParams;
    const supabase = await createClient();
    const locale = await getLocale();
    const t = await getTranslations("booking_detail");

    const { data: { user } } = await supabase.auth.getUser();
    if (!user) redirect(`/${locale}/login`);

    const { data: booking } = await supabase
        .from("bookings")
        .select(`
            id, date, start_time, end_time, status, total_price, currency, qr_code_token, num_players,
            court_id, availability_id, move_count, recurring_group_id,
            courts(name, facilities(name, address, city))
        `)
        .eq("id", id)
        .eq("player_id", user.id)
        .single();

    if (!booking) notFound();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const court = (booking as any).courts;
    const facility = court?.facilities;

    const isCancelled = cancelled === "1" || booking.status === "cancelled";
    const isConfirmed = success === "1" || booking.status === "confirmed";
    const isPending = !isConfirmed && !isCancelled && booking.status === "pending";
    const justPaid = success === "1";

    // Server Component — Date.now() at request time is intentional.
    // eslint-disable-next-line react-hooks/purity
    const nowMs = Date.now();
    const bookingStart = new Date(`${booking.date}T${booking.start_time}`);
    const hoursUntil = (bookingStart.getTime() - nowMs) / 3_600_000;
    const canMove =
        booking.status === "confirmed" &&
        (booking.move_count ?? 0) < 1 &&
        hoursUntil > 24 &&
        !booking.recurring_group_id;

    let seriesPosition: { index: number; total: number } | null = null;
    let remainingInSeries = 0;
    if (booking.recurring_group_id) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { data: siblings } = await (supabase as any)
            .from("bookings")
            .select("id, date, start_time, status")
            .eq("recurring_group_id", booking.recurring_group_id)
            .order("date", { ascending: true })
            .order("start_time", { ascending: true });
        if (siblings && siblings.length > 0) {
            const idx = siblings.findIndex((b: { id: string }) => b.id === booking.id);
            if (idx >= 0) seriesPosition = { index: idx + 1, total: siblings.length };
            // Count cancellable future siblings — drives the "Cancel remaining N weeks" button copy.
            // Reusing nowMs from above keeps the timestamp consistent across the page render.
            remainingInSeries = siblings.filter((s: { status: string; date: string; start_time: string }) => {
                if (!["confirmed", "pending"].includes(s.status)) return false;
                return new Date(`${s.date}T${s.start_time}`).getTime() > nowMs;
            }).length;
        }
    }
    const canCancelSingle = ["confirmed", "pending"].includes(booking.status) && hoursUntil > 0;
    const canCancelSeries = !!booking.recurring_group_id && remainingInSeries > 0;

    const headersList = await headers();
    const host = headersList.get("host") ?? "localhost:3000";
    const appUrl = host.startsWith("localhost") ? `http://${host}` : `https://${host}`;
    const shareUrl = `${appUrl}/${locale}/booking/${booking.qr_code_token}`;

    // SAH-92: pull existing booking_guests so the booker can see who has
    // paid and copy any payment link that didn't deliver automatically.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: splitGuests } = await (supabase as any)
        .from("booking_guests")
        .select("id, name, whatsapp_phone, email, share_amount, currency, payment_status, stripe_payment_link_url, paid_at, notified_at")
        .eq("booking_id", booking.id)
        .order("invited_at", { ascending: true });
    const splitInProgress = Array.isArray(splitGuests) && splitGuests.length > 0;

    return (
        <div className="min-h-[calc(100vh-4rem)] flex items-center justify-center px-4 py-12">
            <div className="max-w-md w-full space-y-6">
                {/* Polls every 2.5s after Stripe redirect until webhook fires and status flips */}
                <BookingStatusWatcher isPending={isPending} justPaid={justPaid} />

                {/* Status header */}
                <div className="text-center">
                    {isConfirmed && !isCancelled ? (
                        <>
                            <CheckCircle className="h-14 w-14 text-emerald-500 mx-auto mb-3" />
                            <h1 className="text-2xl font-bold text-gray-900 dark:text-white">{t("confirmed_heading")}</h1>
                            <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">{t("confirmed_desc")}</p>
                        </>
                    ) : isCancelled ? (
                        <>
                            <XCircle className="h-14 w-14 text-red-400 mx-auto mb-3" />
                            <h1 className="text-2xl font-bold text-gray-900 dark:text-white">{t("cancelled_heading")}</h1>
                            <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">{t("cancelled_desc")}</p>
                        </>
                    ) : (
                        <>
                            <Clock className="h-14 w-14 text-amber-400 mx-auto mb-3" />
                            <h1 className="text-2xl font-bold text-gray-900 dark:text-white">{t("pending_heading")}</h1>
                            <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">{t("pending_desc")}</p>
                        </>
                    )}
                </div>

                {seriesPosition && (
                    <div className="rounded-lg bg-emerald-50 dark:bg-emerald-900/20 border border-emerald-200 dark:border-emerald-800 px-4 py-2 text-center text-sm font-medium text-emerald-700 dark:text-emerald-300">
                        {t("series_position", { index: seriesPosition.index, total: seriesPosition.total })}
                    </div>
                )}

                {/* Booking details */}
                <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-xl p-5 space-y-3">
                    <div className="flex justify-between text-sm">
                        <span className="text-gray-500 dark:text-gray-400">{t("court")}</span>
                        <span className="font-medium text-gray-900 dark:text-white">{court?.name}</span>
                    </div>
                    <div className="flex justify-between text-sm">
                        <span className="text-gray-500 dark:text-gray-400">{t("date")}</span>
                        <span className="font-medium text-gray-900 dark:text-white">
                            {format(new Date(booking.date), "PPP")}
                        </span>
                    </div>
                    <div className="flex justify-between text-sm">
                        <span className="text-gray-500 dark:text-gray-400">{t("time")}</span>
                        <span className="font-medium text-gray-900 dark:text-white">
                            {booking.start_time.slice(0, 5)} – {booking.end_time.slice(0, 5)}
                        </span>
                    </div>
                    <div className="flex justify-between text-sm">
                        <span className="text-gray-500 dark:text-gray-400">{t("players")}</span>
                        <span className="font-medium text-gray-900 dark:text-white">{booking.num_players}</span>
                    </div>
                    <div className="flex justify-between text-sm">
                        <span className="text-gray-500 dark:text-gray-400">{t("total")}</span>
                        <span className="font-semibold text-gray-900 dark:text-white">
                            {booking.total_price} {booking.currency}
                        </span>
                    </div>
                    {facility && (
                        <div className="pt-2 border-t border-gray-100 dark:border-gray-800 flex items-start gap-2 text-sm text-gray-500 dark:text-gray-400">
                            <MapPin className="h-4 w-4 mt-0.5 shrink-0" />
                            <span>{facility.name} — {facility.address}, {facility.city}</span>
                        </div>
                    )}
                </div>

                {/* Complete Payment — pending bookings */}
                {isPending && <CompletePaymentButton bookingId={booking.id} />}

                {/* QR Code — only for confirmed bookings */}
                {isConfirmed && !isCancelled && booking.qr_code_token && (
                    <BookingQRCode token={booking.qr_code_token} appUrl={appUrl} />
                )}

                {/* Share actions — only for confirmed bookings */}
                {isConfirmed && !isCancelled && (
                    <BookingShareActions
                        courtName={court?.name ?? ""}
                        facilityName={facility?.name ?? ""}
                        date={booking.date}
                        startTime={booking.start_time}
                        endTime={booking.end_time}
                        address={`${facility?.address ?? ""}, ${facility?.city ?? ""}`}
                        totalPrice={booking.total_price}
                        currency={booking.currency}
                        numPlayers={booking.num_players}
                        shareUrl={shareUrl}
                        bookingId={booking.id}
                        splitInProgress={splitInProgress}
                    />
                )}

                {/* SAH-92: per-guest paid/pending status with copy-link buttons. */}
                {isConfirmed && !isCancelled && splitInProgress && (
                    <SplitStatusPanel guests={splitGuests ?? []} />
                )}

                {canMove && (
                    <MoveBookingPanel
                        bookingId={booking.id}
                        courtId={booking.court_id}
                        currentAvailabilityId={booking.availability_id}
                        currentStartTime={booking.start_time}
                        currentEndTime={booking.end_time}
                    />
                )}

                {(isConfirmed || booking.status === "completed") && (
                    <Link
                        href={`/${locale}/bookings/${booking.id}/invoice`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="block w-full px-4 py-2.5 rounded-lg border border-gray-300 dark:border-gray-600 text-sm font-medium text-gray-700 dark:text-gray-300 text-center hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
                    >
                        {t("download_invoice")}
                    </Link>
                )}

                {/* SAH-91: per-occurrence vs whole-series cancel choices. */}
                {(canCancelSingle || canCancelSeries) && (
                    <div className="rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 p-4 space-y-3">
                        <h3 className="text-sm font-semibold text-gray-900 dark:text-white">{t("cancel_section_title")}</h3>
                        <div className="flex flex-wrap items-center gap-2">
                            {canCancelSingle && (
                                <CancelButton bookingId={booking.id} />
                            )}
                            {canCancelSeries && (
                                <CancelSeriesButton
                                    bookingId={booking.id}
                                    remainingCount={remainingInSeries}
                                />
                            )}
                        </div>
                        {canCancelSeries && (
                            <p className="text-xs text-gray-500 dark:text-gray-400">
                                {t("cancel_series_hint")}
                            </p>
                        )}
                    </div>
                )}

                <div className="flex gap-3">
                    <Link
                        href={`/${locale}/map`}
                        className="flex-1 px-4 py-2.5 rounded-lg border border-gray-300 dark:border-gray-600 text-sm font-medium text-gray-700 dark:text-gray-300 text-center hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
                    >
                        {t("find_courts")}
                    </Link>
                    <Link
                        href={`/${locale}/bookings`}
                        className="flex-1 px-4 py-2.5 rounded-lg bg-gray-900 dark:bg-white text-white dark:text-gray-900 text-sm font-medium text-center hover:opacity-90 transition-opacity"
                    >
                        {t("my_bookings")}
                    </Link>
                </div>
            </div>
        </div>
    );
}
