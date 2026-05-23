"use client";

import React from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { facilityUpdateSchema, type FacilityUpdateInput } from "@/lib/validations";
import {
    updateFacilityAction,
    updateFacilitySportsAction,
    saveFacilityHoursAction,
} from "../actions";
import { Input } from "@/components/ui/Input";
import { Button } from "@/components/ui/Button";
import { CheckCircle } from "lucide-react";
import { ImageUploader } from "@/components/facility/ImageUploader";
import { MapboxAddressInput } from "@/components/facility/MapboxAddressInput";
import type { FacilityImage } from "@/types/database";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";

interface Sport { id: number; name: string }

type HourRow = {
    day_of_week: number;
    is_closed: boolean;
    open_time: string | null;
    close_time: string | null;
};

interface Props {
    facility: {
        id: string;
        name: string;
        description: string | null;
        address: string;
        city: string;
        postal_code: string | null;
        phone: string | null;
        website: string | null;
        trn?: string | null;
        has_prayer_room?: boolean;
        has_wudu_area?: boolean;
    };
    allSports: Sport[];
    currentSportIds: number[];
    initialImages: FacilityImage[];
    initialHours: HourRow[];
}

const TIME_OPTIONS = Array.from({ length: 37 }, (_, i) => {
    const totalMins = 6 * 60 + i * 30;
    const h = String(Math.floor(totalMins / 60)).padStart(2, "0");
    const m = String(totalMins % 60).padStart(2, "0");
    return `${h}:${m}`;
});

const DAY_KEYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"] as const;

function buildHourDefaults(saved: HourRow[]): HourRow[] {
    return Array.from({ length: 7 }, (_, i) => {
        const existing = saved.find((h) => h.day_of_week === i);
        return existing ?? { day_of_week: i, is_closed: false, open_time: "09:00", close_time: "22:00" };
    });
}

/**
 * SAH-66: One Save Changes button at the bottom of the page submits details,
 * sports, and hours in parallel. Photos and Stripe Connect remain async
 * (per the ticket spec — they trigger their own flows).
 */
export function FacilityEditForm({
    facility,
    allSports,
    currentSportIds,
    initialImages,
    initialHours,
}: Props) {
    const t = useTranslations("facility_form");
    const th = useTranslations("hours_form");
    const tc = useTranslations("common");
    const tSports = useTranslations("sports");
    const router = useRouter();

    const knownSports = ["Padel", "Pickleball", "Tennis", "Squash", "Badminton"] as const;
    const sportName = (name: string) =>
        knownSports.includes(name as typeof knownSports[number])
            ? tSports(name as typeof knownSports[number])
            : name;

    const [sportIds, setSportIds] = React.useState<number[]>(currentSportIds);
    const [hours, setHours] = React.useState<HourRow[]>(buildHourDefaults(initialHours));
    const [serverError, setServerError] = React.useState<string | null>(null);
    const [saved, setSaved] = React.useState(false);
    const [submitting, setSubmitting] = React.useState(false);
    // SAH-119: WKT string set by the Mapbox autocomplete picker. When non-null
    // the server action skips the server-side geocode round-trip.
    const [locationWkt, setLocationWkt] = React.useState<string | null>(null);
    // SAH-119: warning surfaced by the action when Mapbox couldn't locate
    // the manually-typed address. Save still succeeds.
    const [softWarning, setSoftWarning] = React.useState<string | null>(null);

    const {
        register,
        handleSubmit,
        setValue,
        watch,
        formState: { errors },
    } = useForm<FacilityUpdateInput>({
        resolver: zodResolver(facilityUpdateSchema),
        defaultValues: {
            name: facility.name,
            description: facility.description ?? "",
            address: facility.address,
            city: facility.city,
            postal_code: facility.postal_code ?? "",
            phone: facility.phone ?? "",
            website: facility.website ?? "",
            trn: facility.trn ?? "",
            has_prayer_room: facility.has_prayer_room ?? false,
            has_wudu_area: facility.has_wudu_area ?? false,
        },
    });

    function updateHourRow(index: number, patch: Partial<HourRow>) {
        setHours((prev) => prev.map((h, i) => (i === index ? { ...h, ...patch } : h)));
        setSaved(false);
    }

    const onSubmit = async (data: FacilityUpdateInput) => {
        setServerError(null);
        setSoftWarning(null);
        setSaved(false);
        setSubmitting(true);

        try {
            // Run all three saves in parallel — they touch different tables
            // and don't depend on each other.
            const fd = new FormData();
            fd.append("facility_id", facility.id);
            Object.entries(data).forEach(([k, v]) => {
                fd.append(k, typeof v === "boolean" ? String(v) : (v ?? ""));
            });
            // SAH-119: hand the picker's WKT to the action so it can skip
            // the server-side geocode round-trip.
            if (locationWkt) fd.append("location_wkt", locationWkt);

            const [details, sports, hoursResult] = await Promise.all([
                updateFacilityAction(fd),
                updateFacilitySportsAction(facility.id, sportIds),
                saveFacilityHoursAction(facility.id, hours),
            ]);

            const firstError =
                details?.error ?? sports?.error ?? hoursResult?.error ?? null;

            if (firstError) {
                setServerError(firstError);
                return;
            }

            // SAH-119: soft warning from the action when Mapbox couldn't
            // locate the address. Save still succeeded.
            if (details && "warning" in details && details.warning) {
                setSoftWarning(details.warning);
            }

            setSaved(true);
            router.refresh();
        } finally {
            setSubmitting(false);
        }
    };

    return (
        <form onSubmit={handleSubmit(onSubmit)} className="space-y-8" noValidate>
            {/* Basic Info */}
            <div className="bg-white dark:bg-gray-900 rounded-2xl border border-gray-200 dark:border-gray-800 p-6">
                <h2 className="text-lg font-semibold text-gray-900 dark:text-white mb-5">{t("details_section")}</h2>
                <div className="space-y-4">
                    <Input label={t("name_label")} error={errors.name?.message} {...register("name")} />
                    {/* SAH-119: address + city handled by MapboxAddressInput.
                        The picker syncs both react-hook-form fields + a hidden
                        location_wkt the form submits to the server action. */}
                    <MapboxAddressInput
                        defaultAddress={facility.address}
                        defaultCity={facility.city}
                        onAddressChange={(v) => setValue("address", v, { shouldDirty: true })}
                        onCityChange={(v) => setValue("city", v, { shouldDirty: true })}
                        onSelect={(sel) => {
                            setValue("address", sel.address, { shouldDirty: true });
                            setValue("city", sel.city, { shouldDirty: true });
                            setLocationWkt(sel.wkt);
                        }}
                        addressError={errors.address?.message}
                        cityError={errors.city?.message}
                    />
                    {/* react-hook-form registration kept hidden so validation
                        runs against the same values the picker writes to. */}
                    <input type="hidden" {...register("address")} />
                    <input type="hidden" {...register("city")} />
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                        <Input label={t("postal_label")} error={errors.postal_code?.message} {...register("postal_code")} />
                        <Input label={t("phone_label")} error={errors.phone?.message} {...register("phone")} />
                        <Input label={t("website_label")} placeholder={t("website_placeholder")} error={errors.website?.message} {...register("website")} />
                    </div>
                    <div>
                        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">{t("description_label")}</label>
                        <textarea
                            {...register("description")}
                            rows={4}
                            className="w-full rounded-xl border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-emerald-500"
                            placeholder={t("description_placeholder")}
                        />
                        {errors.description && <p className="text-xs text-red-500 mt-1">{errors.description.message}</p>}
                    </div>
                    <div>
                        <Input
                            label={t("trn_label")}
                            placeholder={t("trn_placeholder")}
                            inputMode="numeric"
                            maxLength={15}
                            error={errors.trn?.message}
                            {...register("trn")}
                        />
                        <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">{t("trn_hint")}</p>
                    </div>
                </div>

                <div className="mt-6 pt-6 border-t border-gray-100 dark:border-gray-800">
                    <h3 className="text-sm font-semibold text-gray-900 dark:text-white mb-1">{t("prayer_section")}</h3>
                    <p className="text-xs text-gray-500 dark:text-gray-400 mb-3">{t("prayer_hint")}</p>
                    {/* SAH-111 bounce-back: bzo asked for a single "Prayer-friendly"
                        checkbox instead of two. Both DB columns are still updated
                        in lockstep so existing reads (facility profile badge, map
                        filter) keep working without a schema change. */}
                    <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300 cursor-pointer">
                        <input
                            type="checkbox"
                            className="h-4 w-4 rounded border-gray-300 text-emerald-600 focus:ring-emerald-500"
                            checked={watch("has_prayer_room") ?? false}
                            onChange={(e) => {
                                setValue("has_prayer_room", e.target.checked, { shouldDirty: true });
                                setValue("has_wudu_area", e.target.checked, { shouldDirty: true });
                            }}
                        />
                        {t("prayer_friendly_label")}
                    </label>
                </div>
            </div>

            {/* Photos — independent async per-image upload */}
            <div className="bg-white dark:bg-gray-900 rounded-2xl border border-gray-200 dark:border-gray-800 p-6">
                <h2 className="text-lg font-semibold text-gray-900 dark:text-white mb-2">{t("photos_section")}</h2>
                <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">{t("photos_hint")}</p>
                <ImageUploader facilityId={facility.id} initialImages={initialImages} />
            </div>

            {/* Sports */}
            <div className="bg-white dark:bg-gray-900 rounded-2xl border border-gray-200 dark:border-gray-800 p-6">
                <h2 className="text-lg font-semibold text-gray-900 dark:text-white mb-2">{t("sports_section")}</h2>
                <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">{t("sports_hint")}</p>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                    {allSports.map((sport) => (
                        <button
                            key={sport.id}
                            type="button"
                            onClick={() => {
                                setSportIds((prev) =>
                                    prev.includes(sport.id) ? prev.filter((i) => i !== sport.id) : [...prev, sport.id]
                                );
                                setSaved(false);
                            }}
                            className={`px-3 py-2 rounded-xl text-sm font-medium border-2 transition-all text-left ${sportIds.includes(sport.id)
                                ? "border-emerald-500 bg-emerald-50 dark:bg-emerald-900/20 text-emerald-700 dark:text-emerald-400"
                                : "border-gray-200 dark:border-gray-700 text-gray-700 dark:text-gray-300 hover:border-gray-300"
                                }`}
                        >
                            {sportName(sport.name)}
                        </button>
                    ))}
                </div>
            </div>

            {/* Hours */}
            <div className="bg-white dark:bg-gray-900 rounded-2xl border border-gray-200 dark:border-gray-800 p-6">
                <h2 className="text-lg font-semibold text-gray-900 dark:text-white mb-1">{th("heading")}</h2>
                <p className="text-sm text-gray-500 dark:text-gray-400 mb-5">{th("subheading")}</p>
                <div className="space-y-3">
                    {hours.map((row, i) => (
                        <div key={i} className="flex items-center gap-3 flex-wrap">
                            <span className="w-24 text-sm font-medium text-gray-700 dark:text-gray-300 shrink-0">
                                {tc(DAY_KEYS[i])}
                            </span>
                            <label className="flex items-center gap-1.5 text-sm text-gray-500 dark:text-gray-400 shrink-0">
                                <input
                                    type="checkbox"
                                    checked={row.is_closed}
                                    onChange={(e) => updateHourRow(i, { is_closed: e.target.checked })}
                                    className="rounded border-gray-300 dark:border-gray-600"
                                />
                                {th("closed_label")}
                            </label>
                            {!row.is_closed && (
                                <>
                                    <select
                                        value={row.open_time ?? "09:00"}
                                        onChange={(e) => updateHourRow(i, { open_time: e.target.value })}
                                        className="text-sm border border-gray-300 dark:border-gray-600 rounded-lg px-2 py-1.5 bg-white dark:bg-gray-800 text-gray-900 dark:text-white"
                                    >
                                        {TIME_OPTIONS.map((time) => (
                                            <option key={time} value={time}>{time}</option>
                                        ))}
                                    </select>
                                    <span className="text-sm text-gray-400">{th("to")}</span>
                                    <select
                                        value={row.close_time ?? "22:00"}
                                        onChange={(e) => updateHourRow(i, { close_time: e.target.value })}
                                        className="text-sm border border-gray-300 dark:border-gray-600 rounded-lg px-2 py-1.5 bg-white dark:bg-gray-800 text-gray-900 dark:text-white"
                                    >
                                        {TIME_OPTIONS.map((time) => (
                                            <option key={time} value={time}>{time}</option>
                                        ))}
                                    </select>
                                </>
                            )}
                            {row.is_closed && (
                                <span className="text-sm text-gray-400 italic">{th("closed_all_day")}</span>
                            )}
                        </div>
                    ))}
                </div>
            </div>

            {/* Single sticky save bar */}
            <div className="sticky bottom-4 z-10 bg-white/95 dark:bg-gray-900/95 backdrop-blur border border-gray-200 dark:border-gray-800 rounded-2xl p-4 flex flex-col sm:flex-row sm:items-center gap-3 shadow-sm">
                <div className="flex-1 min-w-0 space-y-1">
                    {serverError && (
                        <p className="text-sm text-red-500" role="alert">{serverError}</p>
                    )}
                    {/* SAH-111 bounce-back: surface form-level validation errors
                        so the save button can't appear "broken" when there's an
                        invalid value above the fold. */}
                    {Object.keys(errors).length > 0 && !serverError && (
                        <p className="text-sm text-red-500" role="alert">
                            {t("fix_fields_error")} ({Object.keys(errors).join(", ")}).
                        </p>
                    )}
                    {saved && !serverError && Object.keys(errors).length === 0 && !softWarning && (
                        <p className="text-sm text-emerald-600 flex items-center gap-1">
                            <CheckCircle className="h-4 w-4" /> {t("saved")}
                        </p>
                    )}
                    {/* SAH-119: non-blocking soft warning when Mapbox couldn't
                        locate the typed address. Save succeeded; facility just
                        won't show on the map until the address is fixable. */}
                    {saved && softWarning && (
                        <p className="text-sm text-amber-600 dark:text-amber-400">
                            ⚠ {softWarning}
                        </p>
                    )}
                </div>
                <Button type="submit" variant="primary" loading={submitting}>
                    {t("save")}
                </Button>
            </div>
        </form>
    );
}
