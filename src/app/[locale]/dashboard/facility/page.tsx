import { createClient } from "@/lib/supabase/server";
import { getLocale, getTranslations } from "next-intl/server";
import { redirect } from "next/navigation";
import { FacilityEditForm } from "./FacilityEditForm";
import { StripeConnectSection } from "./StripeConnectSection";
import { ShareableLinkCard } from "./ShareableLinkCard";
import { getActiveFacility } from "@/lib/facility-context";
import { getStripe, isStripeTestMode } from "@/lib/stripe";
import { getPlatformFeePercent } from "@/lib/platform-settings";

export const metadata = { title: "Manage Facility – Saha" };

export default async function FacilityPage() {
    const supabase = await createClient();
    const locale = await getLocale();
    const t = await getTranslations("facility_form");
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) redirect(`/${locale}/login`);

    const active = await getActiveFacility(supabase, user.id);
    if (!active) redirect(`/${locale}/dashboard/onboarding`);

    // Re-fetch the active facility with the columns the form needs.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: facility } = await (supabase as any)
        .from("facilities")
        .select("id, name, slug, description, address, city, postal_code, phone, website, trn, has_prayer_room, has_wudu_area, stripe_account_id, facility_images(id, storage_path, display_order)")
        .eq("id", active.id)
        .single();

    if (!facility) {
        redirect(`/${locale}/dashboard/onboarding`);
    }

    const [{ data: allSports }, { data: facilitySpots }, { data: hours }] = await Promise.all([
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (supabase as any).from("sports").select("id, name").in("name", ["Padel", "Pickleball", "Squash", "Tennis", "Badminton"]).order("name"),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (supabase as any).from("facility_sports").select("sport_id").eq("facility_id", facility.id),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (supabase as any)
            .from("facility_hours")
            .select("day_of_week, is_closed, open_time, close_time")
            .eq("facility_id", facility.id)
            .order("day_of_week"),
    ]);

    const currentSportIds: number[] = (facilitySpots ?? []).map((r: { sport_id: number }) => r.sport_id);

    // SAH-64: fetch live Stripe account state so the section can show
    // "ready" vs "onboarding incomplete" instead of just "connected".
    // Also surface `requirements.currently_due` so owners see exactly which
    // documents Stripe is waiting on (instead of a generic "verifying").
    let chargesEnabled = false;
    let detailsSubmitted = false;
    let payoutsEnabled = false;
    let currentlyDue: string[] = [];
    let disabledReason: string | null = null;
    let accountCountry: string | undefined;
    if (facility.stripe_account_id) {
        try {
            const account = await getStripe().accounts.retrieve(facility.stripe_account_id);
            chargesEnabled = !!account.charges_enabled;
            detailsSubmitted = !!account.details_submitted;
            payoutsEnabled = !!account.payouts_enabled;
            currentlyDue = account.requirements?.currently_due ?? [];
            disabledReason = account.requirements?.disabled_reason ?? null;
            accountCountry = account.country ?? undefined;
        } catch {
            // Stripe lookup failed — treat as not-yet-ready. UI will show
            // "complete onboarding" state.
        }
    }

    // SAH-64 bounce-back: detect test mode server-side so the dashboard
    // can surface the test-data cheat sheet without leaking the key prefix.
    const testMode = isStripeTestMode();

    return (
        <div className="max-w-2xl space-y-6">
            <div className="mb-2">
                <h1 className="text-2xl font-bold text-gray-900 dark:text-white">{t("heading")}</h1>
                <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">{t("subheading")}</p>
            </div>
            <ShareableLinkCard slug={facility.slug} locale={locale} />
            <FacilityEditForm
                facility={facility}
                allSports={allSports ?? []}
                currentSportIds={currentSportIds}
                initialImages={facility.facility_images ?? []}
                initialHours={hours ?? []}
            />
            <StripeConnectSection
                hasAccount={!!facility.stripe_account_id}
                chargesEnabled={chargesEnabled}
                detailsSubmitted={detailsSubmitted}
                payoutsEnabled={payoutsEnabled}
                currentlyDue={currentlyDue}
                disabledReason={disabledReason}
                platformFeePercent={await getPlatformFeePercent()}
                testMode={testMode}
                accountCountry={accountCountry}
            />
        </div>
    );
}
