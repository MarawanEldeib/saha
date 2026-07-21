"use server";

import { revalidatePath } from "next/cache";
import { cookies, headers } from "next/headers";
import { getLocale } from "next-intl/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { capWalletCredit, computeCheckoutAmounts } from "@/lib/booking-pricing";
import { rateLimit } from "@/lib/rate-limit";
import { facilityUpdateSchema, profileUpdateSchema, courtSchema, type CourtInput, availabilitySlotSchema, facilityHoursSchema } from "@/lib/validations";
import { sanitizeTextInput } from "@/lib/utils";
import { geocodeAddress } from "@/lib/geocoding";
import { bookCourtCore } from "@/lib/booking-flow";
import type { Database } from "@/types/database";
import type Stripe from "stripe";
import { getStripe } from "@/lib/stripe";
import { getPlatformFeePercent } from "@/lib/platform-settings";
import { logAuditEvent } from "@/lib/audit";
import { captureRouteError } from "@/lib/sentry-helpers";
import { tr } from "@/lib/i18n-errors";
import {
    FACILITY_COOKIE_NAME,
    FACILITY_COOKIE_MAX_AGE,
    getActiveFacility,
} from "@/lib/facility-context";

type FacilityUpdate = Database["public"]["Tables"]["facilities"]["Update"];
type FacilityInsert = Database["public"]["Tables"]["facility_sports"]["Insert"];

// SAH-156: incrementally splitting this god module by domain.
// First out: owner-facing event lifecycle → dashboard/actions/events.ts.
// Callers (NewEventForm, OwnerEventCard) import from the new path
// directly. Re-exports through `"use server"` files don't work with
// Turbopack, so this barrel intentionally stays slim.

// ---------------------------------------------------------------------------
// Facility selection: set the cookie that scopes dashboard pages to a
// specific facility owned by the caller. SAH-65.
// ---------------------------------------------------------------------------
export async function setActiveFacilityAction(facilityId: string) {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return { error: await tr("common.not_authenticated") };

    // Verify the caller owns this facility before trusting the cookie value.
    const { data: facility } = await supabase
        .from("facilities")
        .select("id")
        .eq("id", facilityId)
        .eq("owner_id", user.id)
        .single();
    if (!facility) return { error: await tr("common.access_denied") };

    const cookieStore = await cookies();
    cookieStore.set(FACILITY_COOKIE_NAME, facilityId, {
        path: "/",
        maxAge: FACILITY_COOKIE_MAX_AGE,
        httpOnly: true,
        sameSite: "lax",
        secure: process.env.NODE_ENV === "production",
    });

    revalidatePath("/", "layout");
    return { success: true };
}

// ---------------------------------------------------------------------------
// Facility: update core details — scoped to a specific facility id passed
// in the form (SAH-65). Previously updated every facility owned by the
// caller, which would have been wrong as soon as a single owner had two.
// ---------------------------------------------------------------------------
export async function updateFacilityAction(formData: FormData) {
    const supabase = await createClient();
    const locale = await getLocale();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return { error: await tr("common.not_authenticated") };

    const facilityId = formData.get("facility_id") as string;
    if (!facilityId) return { error: await tr("common.facility_id_missing") };

    // Verify ownership before updating.
    const { data: own } = await supabase
        .from("facilities")
        .select("id")
        .eq("id", facilityId)
        .eq("owner_id", user.id)
        .single();
    if (!own) return { error: await tr("common.access_denied") };

    // SAH-120: normalize free-text inputs before validation/storage so the API
    // doesn't surface Windows line endings or trailing whitespace from form
    // submissions.
    const raw = {
        name: sanitizeTextInput((formData.get("name") as string) ?? ""),
        description: sanitizeTextInput((formData.get("description") as string) ?? ""),
        address: sanitizeTextInput((formData.get("address") as string) ?? ""),
        city: sanitizeTextInput((formData.get("city") as string) ?? ""),
        postal_code: sanitizeTextInput((formData.get("postal_code") as string) ?? ""),
        phone: (formData.get("phone") as string) || undefined,
        website: (formData.get("website") as string) || undefined,
        trn: (formData.get("trn") as string) || undefined,
        has_prayer_room: formData.get("has_prayer_room") === "true",
        has_wudu_area: formData.get("has_wudu_area") === "true",
    };

    const parsed = facilityUpdateSchema.safeParse(raw);
    if (!parsed.success) return { error: parsed.error.issues[0].message };

    // SAH-119 bounce-back: bzo complained the "couldn't locate address" error
    // was hard-blocking the save for many real addresses. Soften the gate —
    // save the row regardless, but only update `location` when Mapbox returns
    // a match. Surface a non-blocking warning so the owner knows the map
    // won't show their facility until they correct the address.
    //
    // Admin approval (`approveFacilityAction`) still refuses to set
    // `status='active'` when `location IS NULL`, so ghost facilities can't
    // go public — that's the safety net.
    //
    // Phase 2 (separate ticket): replace this server-side fallback path with
    // a client-side Mapbox-places autocomplete so the owner picks from a list
    // of real suggestions instead of free-typing.
    //
    // SAH-119 / SAH-152: the autocomplete-picker (built in this PR) can pass
    // `location_wkt` directly, bypassing the server-side geocode entirely.
    const clientWkt = ((formData.get("location_wkt") as string) || "").trim() || null;
    let warning: string | null = null;
    let locationWkt: string | null = clientWkt;

    if (!clientWkt) {
        const geo = await geocodeAddress(parsed.data.address, parsed.data.city);
        if (geo.status === "ok") {
            locationWkt = geo.wkt;
        } else if (geo.status === "no_match") {
            warning = await tr("admin.address_soft_warning");
        }
        // `not_configured` (no Mapbox key) silently leaves location untouched
        // — same dev-environment behaviour as before.
    }

    const update: FacilityUpdate = {
        ...parsed.data,
        phone: parsed.data.phone ?? null,
        website: parsed.data.website ?? null,
        trn: parsed.data.trn || null,
        has_prayer_room: parsed.data.has_prayer_room ?? false,
        has_wudu_area: parsed.data.has_wudu_area ?? false,
        updated_at: new Date().toISOString(),
        ...(locationWkt ? { location: locationWkt as never } : {}),
    };

    const { error } = await supabase
        .from("facilities")
        .update(update)
        .eq("id", facilityId);

    if (error) return { error: error.message };
    revalidatePath(`/${locale}/dashboard/facility`);
    return { success: true, warning };
}

// ---------------------------------------------------------------------------
// Facility: update sports selection
// ---------------------------------------------------------------------------
export async function updateFacilitySportsAction(facilityId: string, sportIds: number[]) {
    const supabase = await createClient();
    const locale = await getLocale();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return { error: await tr("common.not_authenticated") };

    // Verify ownership
    const { data: facility } = await supabase
        .from("facilities")
        .select("id")
        .eq("id", facilityId)
        .eq("owner_id", user.id)
        .single();
    if (!facility) return { error: await tr("common.facility_not_found_or_denied") };

    // Replace all sports: delete existing, then insert selected
    const { error: deleteError } = await supabase
        .from("facility_sports")
        .delete()
        .eq("facility_id", facilityId);
    if (deleteError) return { error: deleteError.message };

    if (sportIds.length > 0) {
        const rows: FacilityInsert[] = sportIds.map((id) => ({
            facility_id: facilityId,
            sport_id: id,
        }));
        const { error } = await supabase.from("facility_sports").insert(rows);
        if (error) return { error: error.message };
    }

    revalidatePath(`/${locale}/dashboard/facility`);
    return { success: true };
}

// ---------------------------------------------------------------------------
// Availability: create single slot
// ---------------------------------------------------------------------------
export async function createAvailabilitySlotAction(
    courtId: string,
    date: string,
    startTime: string,
    endTime: string,
    sessionType: "mixed" | "family" | "women_only" | "men_only" = "mixed",
) {
    const supabase = await createClient();
    const locale = await getLocale();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return { error: await tr("common.not_authenticated") };

    const parsed = availabilitySlotSchema.safeParse({ court_id: courtId, date, start_time: startTime, end_time: endTime, session_type: sessionType });
    if (!parsed.success) return { error: parsed.error.issues[0].message };

    const { data: courtRow } = await supabase.from("courts").select("facility_id").eq("id", courtId).single();
    if (!courtRow) return { error: await tr("courts.not_found") };

    const { data: facility } = await supabase.from("facilities").select("id").eq("id", courtRow.facility_id).eq("owner_id", user.id).single();
    if (!facility) return { error: await tr("common.access_denied") };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error } = await (supabase as any).from("court_availability").insert({
        court_id: courtId,
        date,
        start_time: startTime,
        end_time: endTime,
        is_booked: false,
        session_type: sessionType,
    });

    if (error) return { error: error.code === "23505" ? "A slot already exists at that time" : error.message };
    revalidatePath(`/${locale}/dashboard/availability`);
    return { success: true };
}

// ---------------------------------------------------------------------------
// Availability: generate slots for a full day
// ---------------------------------------------------------------------------
function timeToMinutes(t: string) {
    const [h, m] = t.split(":").map(Number);
    return h * 60 + m;
}

function minutesToTime(mins: number) {
    return `${String(Math.floor(mins / 60)).padStart(2, "0")}:${String(mins % 60).padStart(2, "0")}`;
}

export async function generateAvailabilitySlotsAction(
    courtId: string,
    date: string,
    fromTime: string,
    toTime: string,
    durationMinutes: number,
    sessionType: "mixed" | "family" | "women_only" | "men_only" = "mixed",
) {
    const supabase = await createClient();
    const locale = await getLocale();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return { error: await tr("common.not_authenticated") };

    const { data: courtRow } = await supabase.from("courts").select("facility_id").eq("id", courtId).single();
    if (!courtRow) return { error: await tr("courts.not_found") };

    const { data: facility } = await supabase.from("facilities").select("id").eq("id", courtRow.facility_id).eq("owner_id", user.id).single();
    if (!facility) return { error: await tr("common.access_denied") };

    const start = timeToMinutes(fromTime);
    const end = timeToMinutes(toTime);
    if (start >= end) return { error: await tr("courts.time_inverted") };
    if (end - start < durationMinutes) return { error: await tr("courts.time_range_too_short") };

    const rows = [];
    for (let cur = start; cur + durationMinutes <= end; cur += durationMinutes) {
        rows.push({
            court_id: courtId,
            date,
            start_time: minutesToTime(cur),
            end_time: minutesToTime(cur + durationMinutes),
            is_booked: false,
            session_type: sessionType,
        });
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error } = await (supabase as any).from("court_availability").upsert(rows, {
        onConflict: "court_id,date,start_time",
        ignoreDuplicates: true,
    });

    if (error) return { error: error.message };
    revalidatePath(`/${locale}/dashboard/availability`);
    return { success: true, count: rows.length };
}

// ---------------------------------------------------------------------------
// Availability: delete a slot (only if not booked)
// ---------------------------------------------------------------------------
export async function deleteAvailabilitySlotAction(slotId: string) {
    const supabase = await createClient();
    const locale = await getLocale();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return { error: await tr("common.not_authenticated") };

    const { data: slot } = await supabase.from("court_availability").select("id, is_booked, court_id").eq("id", slotId).single();
    if (!slot) return { error: await tr("courts.slot_not_found") };
    if (slot.is_booked) return { error: await tr("courts.cannot_delete_booked") };

    const { data: courtRow } = await supabase.from("courts").select("facility_id").eq("id", slot.court_id).single();
    if (!courtRow) return { error: await tr("courts.not_found") };

    const { data: facility } = await supabase.from("facilities").select("id").eq("id", courtRow.facility_id).eq("owner_id", user.id).single();
    if (!facility) return { error: await tr("common.access_denied") };

    const { error } = await supabase.from("court_availability").delete().eq("id", slotId);
    if (error) return { error: error.message };
    revalidatePath(`/${locale}/dashboard/availability`);
    return { success: true };
}

// ---------------------------------------------------------------------------
// SAH-92: split a confirmed booking into per-guest Stripe Payment Links.
// The booker has already paid in full; each friend's link pays the
// platform, and on success we award the booker an equal wallet credit.
//
// This is intentionally a thin v1: no live invitations (the booker shares
// the URL via WhatsApp manually), no per-guest cancellation, no auto-Stripe
// refund to the booker. We stack settle-up via the existing wallet flow,
// which keeps the Stripe surface tiny and avoids destination-charge gymnastics.
// ---------------------------------------------------------------------------
export async function splitBookingAction(
    bookingId: string,
    guests: { name?: string; email?: string }[],
) {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return { error: await tr("common.not_authenticated") };

    if (!Array.isArray(guests) || guests.length < 1 || guests.length > 7) {
        return { error: await tr("split_payment.invite_range") };
    }

    const { data: booking } = await supabase
        .from("bookings")
        .select("id, status, total_price, currency, player_id")
        .eq("id", bookingId)
        .eq("player_id", user.id)
        .single();
    if (!booking) return { error: await tr("booking.not_found") };
    if (booking.status !== "confirmed") return { error: await tr("booking.only_confirmed_split") };

    // Existing splits? Don't double-create.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: existing } = await (supabase as any)
        .from("booking_guests")
        .select("id")
        .eq("booking_id", bookingId)
        .limit(1);
    if (existing && existing.length > 0) {
        return { error: await tr("booking.already_split") };
    }

    // Booker is one of the players, so split the total across (guests + 1).
    const totalShares = guests.length + 1;
    const sharePerPerson = Math.round((Number(booking.total_price) / totalShares) * 100) / 100;
    const currency = booking.currency || "AED";

    const headersList = await headers();
    const host = headersList.get("host") ?? "localhost:3000";
    const appUrl = host.startsWith("localhost") ? `http://${host}` : `https://${host}`;
    const successUrl = `${appUrl}/en/bookings/${bookingId}?split_paid=1`;

    const admin = createAdminClient();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: insertedGuests, error: insertError } = await (admin as any)
        .from("booking_guests")
        .insert(
            guests.map((g) => ({
                booking_id: bookingId,
                name: g.name?.trim() || null,
                email: g.email?.trim() || null,
                share_amount: sharePerPerson,
                currency,
                payment_status: "pending" as const,
            })),
        )
        .select("id, name, email, share_amount");
    if (insertError || !insertedGuests) {
        return { error: await tr("split_payment.could_not_create_guests") };
    }

    // Create one Stripe Payment Link per guest. Each link is platform-only
    // (no Connect transfer) — the friend reimburses the booker via wallet
    // credit awarded in the webhook.
    const stripe = getStripe();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const enriched: any[] = [];
    for (const guest of insertedGuests as { id: string; share_amount: number; name: string | null; email: string | null }[]) {
        try {
            const product = await stripe.products.create({
                name: `Saha booking split — ${(guest.name ?? guest.email ?? "guest")}`,
                description: `Your share of booking ${bookingId.slice(0, 8)}`,
            });
            const price = await stripe.prices.create({
                product: product.id,
                currency: currency.toLowerCase(),
                unit_amount: Math.round(Number(guest.share_amount) * 100),
            });
            const link = await stripe.paymentLinks.create({
                line_items: [{ price: price.id, quantity: 1 }],
                metadata: {
                    booking_guest_id: guest.id,
                    booking_id: bookingId,
                    booker_id: user.id,
                },
                after_completion: { type: "redirect", redirect: { url: successUrl } },
            });
            await admin
                .from("booking_guests")
                .update({
                    stripe_payment_link_id: link.id,
                    stripe_payment_link_url: link.url,
                } as never)
                .eq("id", guest.id);
            enriched.push({
                id: guest.id,
                name: guest.name,
                email: guest.email,
                share_amount: guest.share_amount,
                url: link.url,
            });
        } catch (err) {
            captureRouteError(err, {
                route: "actions:createSplitPaymentLink",
                level: "error",
                extra: { guest_id: guest.id, booking_id: bookingId },
            });
            await admin
                .from("booking_guests")
                .update({ payment_status: "failed" } as never)
                .eq("id", guest.id);
            enriched.push({
                id: guest.id,
                name: guest.name,
                email: guest.email,
                share_amount: guest.share_amount,
                url: null,
            });
        }
    }

    return {
        success: true,
        sharePerPerson,
        currency,
        guests: enriched,
    };
}

// ---------------------------------------------------------------------------
// Courts: create
// ---------------------------------------------------------------------------
export async function createCourtAction(facilityId: string, input: CourtInput) {
    const supabase = await createClient();
    const locale = await getLocale();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return { error: await tr("common.not_authenticated") };

    const { data: facility } = await supabase
        .from("facilities")
        .select("id")
        .eq("id", facilityId)
        .eq("owner_id", user.id)
        .single();
    if (!facility) return { error: await tr("common.facility_not_found_or_denied") };

    const parsed = courtSchema.safeParse(input);
    if (!parsed.success) return { error: parsed.error.issues[0].message };

    const sportId = parsed.data.sport_id === "" ? null : parseInt(parsed.data.sport_id, 10);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: inserted, error } = await (supabase as any).from("courts").insert({
        facility_id: facilityId,
        name: parsed.data.name,
        sport_id: sportId,
        capacity: parsed.data.capacity,
        price_per_hour: parsed.data.price_per_hour,
        is_active: true,
    }).select("id").single();

    if (error) return { error: error.message };

    // SAH-138: audit. Owner-side mutation — log with the new court id so
    // /admin/audit-log can reconstruct who created what when.
    await logAuditEvent({
        actorId: user.id,
        actorRole: "business",
        action: "court.create",
        targetType: "court",
        targetId: (inserted as { id: string } | null)?.id ?? null,
        metadata: {
            facility_id: facilityId,
            name: parsed.data.name,
            sport_id: sportId,
            capacity: parsed.data.capacity,
            price_per_hour: parsed.data.price_per_hour,
        },
    });

    revalidatePath(`/${locale}/dashboard/courts`);
    return { success: true };
}

// ---------------------------------------------------------------------------
// Courts: update
// ---------------------------------------------------------------------------
export async function updateCourtAction(courtId: string, input: CourtInput) {
    const supabase = await createClient();
    const locale = await getLocale();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return { error: await tr("common.not_authenticated") };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: courtRow } = await (supabase as any)
        .from("courts")
        .select("facility_id, name, sport_id, capacity, price_per_hour")
        .eq("id", courtId)
        .single();
    if (!courtRow) return { error: await tr("courts.not_found") };

    const { data: facility } = await supabase
        .from("facilities")
        .select("id")
        .eq("id", courtRow.facility_id)
        .eq("owner_id", user.id)
        .single();
    if (!facility) return { error: await tr("common.access_denied") };

    const parsed = courtSchema.safeParse(input);
    if (!parsed.success) return { error: parsed.error.issues[0].message };

    const nextSportId = parsed.data.sport_id === "" ? null : parseInt(parsed.data.sport_id, 10);

    const { error } = await supabase
        .from("courts")
        .update({
            name: parsed.data.name,
            sport_id: nextSportId,
            capacity: parsed.data.capacity,
            price_per_hour: parsed.data.price_per_hour,
        })
        .eq("id", courtId);

    if (error) return { error: error.message };

    // SAH-138: audit with both previous and next snapshots so we can see
    // exactly what an owner changed (e.g. silent price hike).
    await logAuditEvent({
        actorId: user.id,
        actorRole: "business",
        action: "court.update",
        targetType: "court",
        targetId: courtId,
        metadata: {
            previous: {
                name: courtRow.name,
                sport_id: courtRow.sport_id,
                capacity: courtRow.capacity,
                price_per_hour: courtRow.price_per_hour,
            },
            next: {
                name: parsed.data.name,
                sport_id: nextSportId,
                capacity: parsed.data.capacity,
                price_per_hour: parsed.data.price_per_hour,
            },
        },
    });

    revalidatePath(`/${locale}/dashboard/courts`);
    return { success: true };
}

// ---------------------------------------------------------------------------
// Courts: toggle active
// ---------------------------------------------------------------------------
export async function toggleCourtActiveAction(courtId: string, isActive: boolean) {
    const supabase = await createClient();
    const locale = await getLocale();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return { error: await tr("common.not_authenticated") };

    const { data: courtRow } = await supabase
        .from("courts")
        .select("facility_id")
        .eq("id", courtId)
        .single();
    if (!courtRow) return { error: await tr("courts.not_found") };

    const { data: facility } = await supabase
        .from("facilities")
        .select("id")
        .eq("id", courtRow.facility_id)
        .eq("owner_id", user.id)
        .single();
    if (!facility) return { error: await tr("common.access_denied") };

    const { error } = await supabase
        .from("courts")
        .update({ is_active: isActive })
        .eq("id", courtId);

    if (error) return { error: error.message };

    // SAH-138: distinguish activate vs deactivate as separate action keys so
    // /admin/audit-log filters work cleanly.
    await logAuditEvent({
        actorId: user.id,
        actorRole: "business",
        action: isActive ? "court.activate" : "court.deactivate",
        targetType: "court",
        targetId: courtId,
        metadata: { facility_id: courtRow.facility_id, is_active: isActive },
    });

    revalidatePath(`/${locale}/dashboard/courts`);
    return { success: true };
}

// ---------------------------------------------------------------------------
// Courts: delete
// ---------------------------------------------------------------------------
export async function deleteCourtAction(courtId: string) {
    const supabase = await createClient();
    const locale = await getLocale();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return { error: await tr("common.not_authenticated") };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: courtRow } = await (supabase as any)
        .from("courts")
        .select("facility_id, name, sport_id, capacity, price_per_hour, is_active")
        .eq("id", courtId)
        .single();
    if (!courtRow) return { error: await tr("courts.not_found") };

    const { data: facility } = await supabase
        .from("facilities")
        .select("id")
        .eq("id", courtRow.facility_id)
        .eq("owner_id", user.id)
        .single();
    if (!facility) return { error: await tr("common.access_denied") };

    const { error } = await supabase
        .from("courts")
        .delete()
        .eq("id", courtId);

    if (error) return { error: error.message };

    // SAH-138: snapshot the deleted court so we can reconstruct it if a
    // deletion turns out to be wrong (e.g. owner deletes a court mid-dispute).
    await logAuditEvent({
        actorId: user.id,
        actorRole: "business",
        action: "court.delete",
        targetType: "court",
        targetId: courtId,
        metadata: {
            facility_id: courtRow.facility_id,
            snapshot: {
                name: courtRow.name,
                sport_id: courtRow.sport_id,
                capacity: courtRow.capacity,
                price_per_hour: courtRow.price_per_hour,
                is_active: courtRow.is_active,
            },
        },
    });

    revalidatePath(`/${locale}/dashboard/courts`);
    return { success: true };
}

// ---------------------------------------------------------------------------
// Facility: save opening hours (upsert all 7 days)
// ---------------------------------------------------------------------------
export async function saveFacilityHoursAction(
    facilityId: string,
    hours: Array<{ day_of_week: number; is_closed: boolean; open_time: string | null; close_time: string | null }>,
) {
    const supabase = await createClient();
    const locale = await getLocale();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return { error: await tr("common.not_authenticated") };

    const { data: facility } = await supabase
        .from("facilities")
        .select("id")
        .eq("id", facilityId)
        .eq("owner_id", user.id)
        .single();
    if (!facility) return { error: await tr("common.access_denied") };

    const parsed = facilityHoursSchema.safeParse({ hours });
    if (!parsed.success) return { error: parsed.error.issues[0].message };

    const rows = parsed.data.hours.map((h) => ({
        facility_id: facilityId,
        day_of_week: h.day_of_week,
        is_closed: h.is_closed,
        open_time: h.is_closed ? null : h.open_time,
        close_time: h.is_closed ? null : h.close_time,
    }));

    // SAH-138: fetch previous hours so the audit row carries both states.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: previousHours } = await (supabase as any)
        .from("facility_hours")
        .select("day_of_week, is_closed, open_time, close_time")
        .eq("facility_id", facilityId)
        .order("day_of_week");

    const { error } = await supabase
        .from("facility_hours")
        .upsert(rows, { onConflict: "facility_id,day_of_week" });

    if (error) return { error: error.message };

    await logAuditEvent({
        actorId: user.id,
        actorRole: "business",
        action: "facility.hours_update",
        targetType: "facility",
        targetId: facilityId,
        metadata: {
            previous: previousHours ?? [],
            next: parsed.data.hours,
        },
    });

    revalidatePath(`/${locale}/dashboard/facility`);
    return { success: true };
}

// ---------------------------------------------------------------------------
// Booking: get available slots for a court on a date (used by player booking widget)
// SAH-128: returns a discriminated result so the UI can show a specific
// reason instead of the generic "no slots" message — owners reported being
// confused when the silent empty array meant "you haven't published any
// availability for this date" vs "everything's booked" vs a real error.
// ---------------------------------------------------------------------------
export type GetSlotsResult =
    | { ok: true; slots: { id: string; start_time: string; end_time: string; session_type: string }[]; totalDefinedForDate: number }
    | { ok: false; code: "past_date" | "no_court" | "no_slots_defined" | "all_booked" | "error"; error: string };

export async function getAvailableSlotsAction(courtId: string, date: string): Promise<GetSlotsResult> {
    if (!courtId || !date) {
        return { ok: false, code: "error", error: await tr("courts.missing_court_or_date") };
    }

    // Past-date guard. Compare in YYYY-MM-DD strings to avoid timezone drift.
    const today = new Date().toISOString().slice(0, 10);
    if (date < today) {
        return { ok: false, code: "past_date", error: await tr("courts.pick_future_date") };
    }

    const supabase = await createClient();

    // Verify the court exists and belongs to an active facility. RLS already
    // restricts this read to public-active facilities, so a null result =
    // unknown court (or facility suspended).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: court } = await (supabase as any)
        .from("courts")
        .select("id, is_active")
        .eq("id", courtId)
        .maybeSingle();
    if (!court || !court.is_active) {
        return { ok: false, code: "no_court", error: await tr("courts.not_found_or_inactive") };
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (supabase as any)
        .from("court_availability")
        .select("id, start_time, end_time, is_booked, session_type")
        .eq("court_id", courtId)
        .eq("date", date)
        .order("start_time");

    if (error) {
        return { ok: false, code: "error", error: await tr("courts.could_not_load_slots") };
    }

    const allRows = (data ?? []) as { id: string; start_time: string; end_time: string; is_booked: boolean; session_type: string | null }[];
    if (allRows.length === 0) {
        return { ok: false, code: "no_slots_defined", error: await tr("courts.no_slots_published") };
    }

    const open = allRows.filter((r) => !r.is_booked);
    if (open.length === 0) {
        return { ok: false, code: "all_booked", error: await tr("courts.all_slots_booked") };
    }

    return {
        ok: true,
        slots: open.map(({ id, start_time, end_time, session_type }) => ({
            id,
            start_time,
            end_time,
            session_type: session_type ?? "mixed",
        })),
        totalDefinedForDate: allRows.length,
    };
}

// ---------------------------------------------------------------------------
// Booking: create booking + Stripe checkout session
// SECURITY: Server is the source of truth for slot times and price. The
// previous version trusted client-supplied start/end times and silently
// fell back to platform-account charges when the connected Stripe account
// wasn't ready (SAH-67, SAH-68).
//
// SAH-149 (Shariah compliance): do NOT add late-payment fees, compounding
// penalties, or interest-bearing balances here without revisiting the public
// /shariah statement. The current shape — a flat service fee plus a binary
// cancellation rule — is what the page commits us to.
// ---------------------------------------------------------------------------
export async function createBookingAndCheckoutAction(
    availabilityId: string,
    numPlayers: number,
    /** Optional wallet credit to apply (SAH-93). Capped server-side at the
     * platform fee (10% of total) so the owner stays whole. */
    creditToApply?: number,
) {
    const supabase = await createClient();
    const locale = await getLocale();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return { error: await tr("common.not_authenticated") };

    // SAH-76: 20 bookings / 1h / IP — slot squatting / booking spam guard.
    const rl = await rateLimit("booking_create", user.id);
    if (!rl.success) {
        return { error: await tr("booking.too_many_attempts", { seconds: rl.retryAfter }) };
    }

    const headersList = await headers();
    const host = headersList.get("host") ?? "localhost:3000";
    const appUrl = host.startsWith("localhost") ? `http://${host}` : `https://${host}`;

    // SAH-118: shared core handles slot-lock + booking insert + Stripe Checkout.
    // The same helper backs `POST /api/v1/bookings` so behaviour stays identical
    // across the website and AI-agent flows.
    const result = await bookCourtCore({
        supabase,
        userId: user.id,
        availabilityId,
        numPlayers,
        creditToApply,
        appUrl,
        locale,
    });

    if (!result.ok) return { error: result.error };
    return { checkoutUrl: result.checkoutUrl };
}

// ---------------------------------------------------------------------------
// Booking: create a weekly recurring series (SAH-91).
//
// Player picks a slot + N weeks. We need a free slot at the same court +
// same time every following week. We lock all of them, create N pending
// bookings sharing a `recurring_group_id`, and bundle the full series into
// a single Stripe Checkout session. The webhook flips them all to confirmed
// at once (and only emails/whatsapps the first occurrence so the player
// isn't spammed). Per-occurrence cancellation, holiday auto-skip, and partial
// refund are intentionally out of scope here — see follow-up work on SAH-91.
// ---------------------------------------------------------------------------
export async function createRecurringBookingAndCheckoutAction(
    availabilityId: string,
    numPlayers: number,
    weeks: number,
) {
    if (weeks <= 1) {
        return createBookingAndCheckoutAction(availabilityId, numPlayers);
    }
    if (![2, 4, 8, 12].includes(weeks)) {
        return { error: await tr("booking.invalid_recurrence") };
    }

    const supabase = await createClient();
    const locale = await getLocale();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return { error: await tr("common.not_authenticated") };

    // Authoritative slot data — never trust client times.
    const { data: firstSlot } = await supabase
        .from("court_availability")
        .select("id, court_id, date, start_time, end_time, is_booked")
        .eq("id", availabilityId)
        .single();
    if (!firstSlot) return { error: await tr("courts.slot_not_found") };
    if (firstSlot.is_booked) return { error: await tr("booking.slot_unlocked") };

    const { data: court } = await supabase
        .from("courts")
        .select("id, name, price_per_hour, capacity, facility_id, facilities(id, name, stripe_account_id, currency)")
        .eq("id", firstSlot.court_id)
        .single();
    if (!court) return { error: await tr("courts.not_found") };

    if (numPlayers < 1 || numPlayers > (court.capacity ?? 1)) {
        return { error: await tr("booking.invalid_players") };
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const facilityData = (court as any).facilities;
    const stripeAccountId = facilityData?.stripe_account_id as string | null;
    const currency = (facilityData?.currency as string) ?? "AED";

    if (!stripeAccountId) {
        return { error: await tr("booking.facility_not_ready") };
    }
    try {
        const account = await getStripe().accounts.retrieve(stripeAccountId);
        if (!account.charges_enabled || !account.details_submitted) {
            return { error: await tr("booking.facility_not_ready") };
        }
    } catch {
        return { error: await tr("booking.verify_facility_payment_failed") };
    }

    const [sh, sm] = firstSlot.start_time.split(":").map(Number);
    const [eh, em] = firstSlot.end_time.split(":").map(Number);
    const durationHours = ((eh * 60 + em) - (sh * 60 + sm)) / 60;
    if (durationHours <= 0) return { error: await tr("booking.invalid_slot") };
    const perWeekPrice = Math.round(court.price_per_hour * durationHours * 100) / 100;

    // Look up the matching slot for each subsequent week. A slot must be
    // pre-generated by the owner for that date and start at the same time
    // on the same court — we don't auto-generate availability.
    const slotIds: string[] = [firstSlot.id];
    const slotDates: string[] = [firstSlot.date];
    const missingWeeks: number[] = [];

    for (let w = 1; w < weeks; w++) {
        const target = new Date(firstSlot.date + "T00:00:00Z");
        target.setUTCDate(target.getUTCDate() + 7 * w);
        const dateKey = target.toISOString().split("T")[0];

        const { data: weekSlot } = await supabase
            .from("court_availability")
            .select("id, is_booked")
            .eq("court_id", firstSlot.court_id)
            .eq("date", dateKey)
            .eq("start_time", firstSlot.start_time)
            .eq("end_time", firstSlot.end_time)
            .maybeSingle();

        if (!weekSlot || weekSlot.is_booked) {
            missingWeeks.push(w + 1);
            continue;
        }
        slotIds.push(weekSlot.id);
        slotDates.push(dateKey);
    }

    if (missingWeeks.length > 0) {
        return {
            error: await tr("booking.weeks_unavailable", { weeks: missingWeeks.join(", ") }),
        };
    }

    // Lock every slot via CAS. Roll back on any failure so we don't leak
    // inventory.
    const lockedIds: string[] = [];
    for (const id of slotIds) {
        const { data: rows } = await supabase
            .from("court_availability")
            .update({ is_booked: true } as never)
            .eq("id", id)
            .eq("is_booked", false)
            .select("id");
        if (!rows || rows.length === 0) {
            // Release everything we locked so far and bail.
            for (const lockedId of lockedIds) {
                await supabase
                    .from("court_availability")
                    .update({ is_booked: false } as never)
                    .eq("id", lockedId);
            }
            return { error: await tr("booking.weekly_slot_taken") };
        }
        lockedIds.push(id);
    }

    // Generate the group id client-side via crypto so we can stash it on
    // every row up-front and reuse it as Stripe metadata.
    const recurringGroupId = crypto.randomUUID();
    const totalPrice = Math.round(perWeekPrice * weeks * 100) / 100;

    // Insert N pending bookings tied by recurring_group_id. Per-row price
    // is the per-week amount so the existing cancellation refund math works
    // for one-off cancellations.
    const rowsToInsert = slotIds.map((id, idx) => ({
        availability_id: id,
        court_id: firstSlot.court_id,
        player_id: user.id,
        date: slotDates[idx],
        start_time: firstSlot.start_time,
        end_time: firstSlot.end_time,
        num_players: numPlayers,
        total_price: perWeekPrice,
        currency,
        status: "pending" as const,
        recurring_group_id: recurringGroupId,
    }));

    const { data: insertedBookings, error: bookingError } = await supabase
        .from("bookings")
        .insert(rowsToInsert as never)
        .select("id");

    if (bookingError || !insertedBookings) {
        for (const id of lockedIds) {
            await supabase.from("court_availability").update({ is_booked: false } as never).eq("id", id);
        }
        return { error: await tr("booking.could_not_create_series") };
    }

    const firstBookingId = insertedBookings[0].id;

    // One pending payment row per booking so reconciliation stays consistent.
    await supabase.from("payments").insert(
        insertedBookings.map((b) => ({
            booking_id: b.id,
            amount: perWeekPrice,
            currency,
            status: "pending",
        })) as never,
    );

    const headersList = await headers();
    const host = headersList.get("host") ?? "localhost:3000";
    const appUrl = host.startsWith("localhost") ? `http://${host}` : `https://${host}`;

    const feePercent = await getPlatformFeePercent();
    const feeAmount = Math.round(totalPrice * 100 * feePercent / 100);
    const sessionParams: Stripe.Checkout.SessionCreateParams = {
        mode: "payment",
        line_items: [{
            quantity: 1,
            price_data: {
                currency: currency.toLowerCase(),
                unit_amount: Math.round(totalPrice * 100),
                product_data: {
                    name: facilityData?.name ? `${facilityData.name} — ${court.name}` : court.name,
                    description: `${weeks} weeks · ${firstSlot.start_time}–${firstSlot.end_time} from ${firstSlot.date}`,
                },
            },
        }],
        metadata: {
            recurring_group_id: recurringGroupId,
            booking_id: firstBookingId,
            weeks: String(weeks),
        },
        success_url: `${appUrl}/${locale}/bookings/${firstBookingId}?success=1`,
        cancel_url: `${appUrl}/${locale}/bookings/${firstBookingId}?cancelled=1`,
        expires_at: Math.floor(Date.now() / 1000) + 30 * 60,
        payment_intent_data: {
            application_fee_amount: feeAmount,
            transfer_data: { destination: stripeAccountId },
        },
    };

    let session: Stripe.Checkout.Session;
    try {
        session = await getStripe().checkout.sessions.create(sessionParams);
    } catch {
        // Cancel all pending bookings + release every slot.
        await supabase
            .from("bookings")
            .update({ status: "cancelled" } as never)
            .eq("recurring_group_id", recurringGroupId);
        for (const id of lockedIds) {
            await supabase.from("court_availability").update({ is_booked: false } as never).eq("id", id);
        }
        return { error: await tr("booking.could_not_start_payment") };
    }

    return { checkoutUrl: session.url };
}

// ---------------------------------------------------------------------------
// Profile: update avatar URL
// ---------------------------------------------------------------------------
export async function updateAvatarAction(avatarUrl: string) {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return { error: await tr("common.not_authenticated") };

    const { error } = await supabase
        .from("profiles")
        .update({ avatar_url: avatarUrl } as never)
        .eq("id", user.id);

    if (error) return { error: error.message };
    revalidatePath("/", "layout");
    return { success: true };
}

// ---------------------------------------------------------------------------
// Profile: remove avatar
// ---------------------------------------------------------------------------
export async function removeAvatarAction() {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return { error: await tr("common.not_authenticated") };

    // Delete from storage (ignore errors — file may not exist)
    await supabase.storage.from("avatars").remove([`${user.id}/avatar.jpg`]);

    const { error } = await supabase
        .from("profiles")
        .update({ avatar_url: null } as never)
        .eq("id", user.id);

    if (error) return { error: error.message };
    revalidatePath("/", "layout");
    return { success: true };
}

// ---------------------------------------------------------------------------
// Profile: update display name and phone
// ---------------------------------------------------------------------------
export async function updateProfileAction(formData: FormData) {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return { error: await tr("common.not_authenticated") };

    const rawPhone = (formData.get("phone") as string)?.trim();
    const rawTrn = (formData.get("trn") as string)?.trim();
    const rawSkill = (formData.get("skill_rating") as string)?.trim();
    const skillNum = rawSkill ? Number(rawSkill) : "";
    const raw = {
        display_name: (formData.get("display_name") as string)?.trim(),
        phone: rawPhone || "",
        trn: rawTrn || "",
        skill_rating: skillNum === "" || Number.isNaN(skillNum) ? "" : skillNum,
    };
    const parsed = profileUpdateSchema.safeParse(raw);
    if (!parsed.success) return { error: parsed.error.issues[0].message };

    // SAH-79: phone changes must go through the verify-before-persist
    // path (startPhoneVerificationAction → checkPhoneVerificationAction).
    // This action accepts:
    //   - display_name updates
    //   - clearing the phone (empty string -> null)
    // It rejects setting a non-empty phone — the client must verify first.
    const { data: existing } = await supabase
        .from("profiles")
        .select("phone")
        .eq("id", user.id)
        .single();
    const previousPhone = (existing as { phone: string | null } | null)?.phone ?? null;
    const nextPhone = parsed.data.phone ? parsed.data.phone : null;
    const phoneChanged = nextPhone !== previousPhone;

    if (phoneChanged && nextPhone !== null) {
        return { error: await tr("profile.phone_must_verify") };
    }

    const update: Record<string, unknown> = {
        display_name: parsed.data.display_name,
        trn: parsed.data.trn ? parsed.data.trn : null,
        // SAH-152 Phase 8: skill rating — null when blank, clamped value otherwise.
        skill_rating: typeof parsed.data.skill_rating === "number" ? parsed.data.skill_rating : null,
    };
    if (phoneChanged) {
        // Clearing the phone — drop verified state too.
        update.phone = null;
        update.phone_verified = false;
        update.phone_verification_sid = null;
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error } = await (supabase as any)
        .from("profiles")
        .update(update)
        .eq("id", user.id);

    if (error) return { error: error.message };
    revalidatePath("/", "layout");
    return { success: true, phoneChanged };
}

// ---------------------------------------------------------------------------
// SAH-79: WhatsApp OTP — verify-before-persist.
//
// The caller provides the phone number they WANT to set (it isn't yet
// persisted to profiles). Twilio Verify sends a code via WhatsApp. The
// matching check action takes (phone, code) and only writes the phone +
// flips phone_verified=true on approval.
//
// Rate limits: 3 sends per hour per target phone (prevents OTP spam to
// someone else's number), 5 sends per day per signed-in user (prevents a
// single attacker from cycling through phone numbers).
// ---------------------------------------------------------------------------

const PHONE_E164 = /^\+[1-9]\d{6,14}$/;

export async function startPhoneVerificationAction(phone: string) {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return { error: await tr("common.not_authenticated") };

    const normalized = (phone ?? "").trim();
    if (!PHONE_E164.test(normalized)) {
        return { error: await tr("profile.phone_invalid") };
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: existing } = await (supabase as any)
        .from("profiles")
        .select("phone, phone_verified")
        .eq("id", user.id)
        .single();
    if (existing && existing.phone === normalized && existing.phone_verified) {
        return { error: await tr("profile.phone_already_verified") };
    }

    const { rateLimitByOwnerKey } = await import("@/lib/rate-limit");
    // SECURITY: OTP is an SMS-cost + brute-force surface — fail closed if the
    // rate-limit backend is unavailable rather than sending unthrottled codes.
    const phoneRl = await rateLimitByOwnerKey("phone_otp_per_phone", normalized, { failClosed: true });
    if (!phoneRl.success) {
        return { error: await tr("profile.otp_rate_phone", { minutes: Math.ceil(phoneRl.retryAfter / 60) }), retryAfter: phoneRl.retryAfter };
    }
    const userRl = await rateLimitByOwnerKey("phone_otp_per_user", user.id, { failClosed: true });
    if (!userRl.success) {
        return { error: await tr("profile.otp_rate_user", { hours: Math.ceil(userRl.retryAfter / 3600) }), retryAfter: userRl.retryAfter };
    }

    const { startWhatsAppVerification } = await import("@/lib/twilio");
    const result = await startWhatsAppVerification(normalized);

    if (result.status === "not_configured") return { notConfigured: true };
    if (result.status === "error") return { error: result.message };

    return { success: true, status: result.status };
}

export async function checkPhoneVerificationAction(phone: string, code: string) {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return { error: await tr("common.not_authenticated") };

    const normalized = (phone ?? "").trim();
    if (!PHONE_E164.test(normalized)) {
        return { error: await tr("profile.phone_format_invalid") };
    }
    if (!code || code.length < 4) return { error: await tr("profile.otp_enter_code") };

    const { checkWhatsAppVerification } = await import("@/lib/twilio");
    const result = await checkWhatsAppVerification(normalized, code);

    if (result.status === "not_configured") return { notConfigured: true };
    if (result.status === "incorrect") return { error: await tr("profile.otp_incorrect") };
    if (result.status === "expired") return { error: await tr("profile.otp_expired") };
    if (result.status === "pending") return { error: await tr("profile.otp_pending") };
    if (result.status === "error") return { error: result.message ?? "Verification failed." };

    if (result.status === "approved") {
        // Atomic: write phone + phone_verified together. The DB trigger
        // (20260511070000_profile_phone_requires_verified.sql) enforces
        // this contract as a second line of defence.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { error } = await (supabase as any)
            .from("profiles")
            .update({
                phone: normalized,
                phone_verified: true,
                phone_verification_sid: null,
            })
            .eq("id", user.id);
        if (error) return { error: error.message };
        revalidatePath("/", "layout");
        return { success: true };
    }
    return { error: await tr("profile.otp_failed") };
}

// ---------------------------------------------------------------------------
// Booking: retry payment for a pending booking
// ---------------------------------------------------------------------------
export async function retryPaymentAction(bookingId: string) {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return { error: await tr("common.not_authenticated") };

    // Confirm this booking belongs to the user and is still pending
    const { data: booking } = await supabase
        .from("bookings")
        .select("id, status")
        .eq("id", bookingId)
        .eq("player_id", user.id)
        .single();

    if (!booking) return { error: await tr("booking.not_found") };
    if (booking.status !== "pending") return { error: await tr("booking.no_pending") };

    // Get the Stripe session ID from the payments record
    const { data: payment } = await supabase
        .from("payments")
        .select("stripe_checkout_session_id")
        .eq("booking_id", bookingId)
        .single();

    if (!payment?.stripe_checkout_session_id) return { error: await tr("booking.payment_record_not_found") };

    // Retrieve the Stripe session — if still open, return its URL
    const session = await getStripe().checkout.sessions.retrieve(payment.stripe_checkout_session_id);
    if (session.status === "open" && session.url) return { checkoutUrl: session.url };

    return { error: await tr("booking.payment_expired") };
}

// ---------------------------------------------------------------------------
// Booking: move to another free slot on the SAME court (SAH-88).
//
// Constraints (intentionally tight; cross-court + Stripe price-diff are
// follow-ups, see ticket SAH-88):
//   1. Caller owns the booking and it is `confirmed`.
//   2. Move window: original start must be > 24h away.
//   3. One move per booking — `move_count` is incremented and capped at 1.
//   4. New slot must be on the same court, free, and at the same price tier
//      (durations equal, price_per_hour identical → total unchanged).
//   5. Atomic: lock new slot via CAS, release old slot, update booking row.
//      Audit-log the event for ops.
// ---------------------------------------------------------------------------
export async function moveBookingAction(bookingId: string, newAvailabilityId: string) {
    const supabase = await createClient();
    const locale = await getLocale();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return { error: await tr("common.not_authenticated") };

    // Load booking with the source court id so we can validate same-court rule.
    const { data: booking } = await supabase
        .from("bookings")
        .select("id, status, date, start_time, end_time, total_price, court_id, availability_id, move_count")
        .eq("id", bookingId)
        .eq("player_id", user.id)
        .single();

    if (!booking) return { error: await tr("booking.not_found") };
    if (booking.status !== "confirmed") return { error: await tr("booking.only_confirmed_move") };
    if ((booking.move_count ?? 0) >= 1) return { error: await tr("booking.already_moved") };

    const originalStart = new Date(`${booking.date}T${booking.start_time}`);
    const hoursUntil = (originalStart.getTime() - Date.now()) / 3_600_000;
    if (hoursUntil <= 24) return { error: await tr("booking.move_window") };

    if (newAvailabilityId === booking.availability_id) {
        return { error: await tr("booking.pick_different_slot") };
    }

    // Validate the target slot: same court, free, same duration as original.
    const { data: newSlot } = await supabase
        .from("court_availability")
        .select("id, court_id, date, start_time, end_time, is_booked")
        .eq("id", newAvailabilityId)
        .single();

    if (!newSlot) return { error: await tr("booking.slot_unavailable") };
    if (newSlot.court_id !== booking.court_id) {
        return { error: await tr("booking.cross_court") };
    }
    if (newSlot.is_booked) return { error: await tr("booking.slot_unavailable") };

    // Same duration → same price tier (same court_id already implies same price_per_hour).
    const oldDur =
        (new Date(`1970-01-01T${booking.end_time}`).getTime() -
            new Date(`1970-01-01T${booking.start_time}`).getTime()) / 60_000;
    const newDur =
        (new Date(`1970-01-01T${newSlot.end_time}`).getTime() -
            new Date(`1970-01-01T${newSlot.start_time}`).getTime()) / 60_000;
    if (oldDur !== newDur) {
        return { error: await tr("booking.different_duration") };
    }

    // Lock new slot via CAS — concurrent caller would race here.
    const { data: lockedRows } = await supabase
        .from("court_availability")
        .update({ is_booked: true } as never)
        .eq("id", newAvailabilityId)
        .eq("is_booked", false)
        .select("id");

    if (!lockedRows || lockedRows.length === 0) {
        return { error: await tr("booking.slot_just_taken") };
    }

    // Release the old slot and update booking row in two updates. If the
    // booking update fails, roll back the slot lock.
    const { error: bookingError } = await supabase
        .from("bookings")
        .update({
            availability_id: newAvailabilityId,
            date: newSlot.date,
            start_time: newSlot.start_time,
            end_time: newSlot.end_time,
            move_count: (booking.move_count ?? 0) + 1,
            updated_at: new Date().toISOString(),
        } as never)
        .eq("id", bookingId);

    if (bookingError) {
        // Rollback the new-slot lock so we don't leak inventory.
        await supabase
            .from("court_availability")
            .update({ is_booked: false } as never)
            .eq("id", newAvailabilityId);
        return { error: await tr("booking.could_not_move") };
    }

    await supabase
        .from("court_availability")
        .update({ is_booked: false } as never)
        .eq("id", booking.availability_id);

    await logAuditEvent({
        actorId: user.id,
        actorRole: "user",
        action: "booking.move",
        targetType: "booking",
        targetId: bookingId,
        metadata: {
            from_availability_id: booking.availability_id,
            to_availability_id: newAvailabilityId,
            from_date: booking.date,
            to_date: newSlot.date,
            from_start: booking.start_time,
            to_start: newSlot.start_time,
        },
    });

    revalidatePath(`/${locale}/bookings`);
    revalidatePath(`/${locale}/bookings/${bookingId}`);
    return { success: true };
}

// ---------------------------------------------------------------------------
// Booking: cancel by player (refund if paid and within 24h of booking date)
// ---------------------------------------------------------------------------
export async function cancelBookingAction(bookingId: string) {
    const supabase = await createClient();
    const locale = await getLocale();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return { error: await tr("common.not_authenticated") };

    const { data: booking } = await supabase
        .from("bookings")
        .select("id, status, date, start_time, availability_id")
        .eq("id", bookingId)
        .eq("player_id", user.id)
        .single();

    if (!booking) return { error: await tr("booking.not_found") };
    if (!["confirmed", "pending"].includes(booking.status)) return { error: await tr("booking.cannot_cancel") };

    // Check cancellation window: must be >24h before the booking start
    const bookingStart = new Date(`${booking.date}T${booking.start_time}`);
    const hoursUntil = (bookingStart.getTime() - Date.now()) / 3_600_000;
    const withinWindow = hoursUntil > 24;

    // Get payment record for refund
    const { data: payment } = await supabase
        .from("payments")
        .select("stripe_payment_intent_id, amount, status")
        .eq("booking_id", bookingId)
        .single();

    // Issue Stripe refund if payment succeeded and within window.
    // `refunded` is true ONLY when refunds.create actually ran (self-audit
    // 2026-07-15). Previously we reported refunded:true whenever the payment
    // had succeeded within the window — but the refund itself was gated on
    // stripe_payment_intent_id, which was never persisted, so the refund was
    // silently skipped while the UI was told the money came back.
    let refunded = false;
    if (withinWindow && payment?.stripe_payment_intent_id && payment.status === "succeeded") {
        try {
            await getStripe().refunds.create({ payment_intent: payment.stripe_payment_intent_id });
            await supabase.from("payments").update({ status: "refunded" } as never).eq("booking_id", bookingId);
            refunded = true;
        } catch (err) {
            captureRouteError(err, {
                route: "actions:cancelBooking",
                level: "error",
                extra: { booking_id: bookingId, payment_intent_id: payment.stripe_payment_intent_id },
            });
            // Refund failed — still cancel the booking; `refunded` stays false.
        }
    }

    // Cancel booking + release slot
    await supabase.from("bookings").update({ status: "cancelled" } as never).eq("id", bookingId);
    await supabase.from("court_availability").update({ is_booked: false } as never).eq("id", booking.availability_id);

    // SAH-93 follow-up: if this booking spent wallet credit, refund it back
    // to the player's wallet so they're whole on cancellation.
    const walletRefunded = await refundWalletCreditForBooking(user.id, bookingId);
    await logAuditEvent({
        actorId: user.id,
        actorRole: "user",
        action: "booking.cancel.player",
        targetType: "booking",
        targetId: bookingId,
        metadata: {
            refunded,
            within_window: withinWindow,
            hours_until: hoursUntil,
            wallet_credit_refunded: walletRefunded,
        },
    });

    revalidatePath(`/${locale}/bookings`);
    return { success: true, refunded };
}

// ---------------------------------------------------------------------------
// SAH-91: Cancel an entire weekly series.
//
// One Stripe payment covers all N occurrences (see
// createRecurringBookingAndCheckoutAction), so a series cancel is one
// pro-rata Stripe refund + a status flip on every future cancellable
// row + slot release. We only refund occurrences whose date is still
// >24h away — anything within the window cancels without a refund (slot
// is released but the player gave up the money for the imminent week).
//
// Past occurrences are left alone — the session already happened.
// ---------------------------------------------------------------------------
export async function cancelBookingSeriesAction(bookingId: string) {
    const supabase = await createClient();
    const locale = await getLocale();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return { error: await tr("common.not_authenticated") };

    // Anchor: caller proves ownership via one row in the group.
    const { data: anchor } = await supabase
        .from("bookings")
        .select("id, recurring_group_id, status")
        .eq("id", bookingId)
        .eq("player_id", user.id)
        .single();
    if (!anchor) return { error: await tr("booking.not_found") };
    if (!anchor.recurring_group_id) return { error: await tr("booking.not_recurring") };

    const groupId = anchor.recurring_group_id;

    // Pull every sibling. We need every row to compute refund + release
    // slots, even past ones (for the audit metadata count).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: siblings } = await (supabase as any)
        .from("bookings")
        .select("id, date, start_time, status, total_price, currency, availability_id")
        .eq("recurring_group_id", groupId)
        .eq("player_id", user.id);

    if (!siblings || siblings.length === 0) return { error: await tr("booking.series_no_bookings") };

    const now = Date.now();
    const cancellable = siblings.filter((s: { status: string; date: string; start_time: string }) => {
        if (!["confirmed", "pending"].includes(s.status)) return false;
        const start = new Date(`${s.date}T${s.start_time}`).getTime();
        return start > now;
    });
    if (cancellable.length === 0) return { error: await tr("booking.nothing_to_cancel_series") };

    // Split into refundable (>24h out) and lapsed (within 24h — cancel
    // the slot but no money back).
    type Sib = { id: string; date: string; start_time: string; total_price: number; availability_id: string };
    const refundable = cancellable.filter((s: Sib) => {
        const start = new Date(`${s.date}T${s.start_time}`).getTime();
        return (start - now) / 3_600_000 > 24;
    });
    const refundAmountAed = refundable.reduce((sum: number, s: Sib) => sum + Number(s.total_price), 0);

    // Stripe partial refund. The whole series shared one checkout session;
    // pull payment_intent off any sibling's stripe_checkout_session_id then
    // issue ONE refund for the pro-rata sum.
    let stripeRefunded = false;
    if (refundAmountAed > 0) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { data: anyPayment } = await (supabase as any)
            .from("payments")
            .select("stripe_checkout_session_id, currency")
            .eq("booking_id", cancellable[0].id)
            .single();
        const sessionId = (anyPayment as { stripe_checkout_session_id: string | null } | null)?.stripe_checkout_session_id;
        if (sessionId) {
            try {
                const session = await getStripe().checkout.sessions.retrieve(sessionId);
                const intentId = typeof session.payment_intent === "string"
                    ? session.payment_intent
                    : session.payment_intent?.id;
                if (intentId) {
                    await getStripe().refunds.create({
                        payment_intent: intentId,
                        amount: Math.round(refundAmountAed * 100),
                    });
                    stripeRefunded = true;
                }
            } catch (err) {
                captureRouteError(err, {
                    route: "actions:cancelBookingSeries",
                    level: "error",
                    extra: { booking_id: bookingId, refund_amount_aed: refundAmountAed },
                });
                // Continue — better to cancel + log the failure than leave
                // the player stuck with a confirmed-but-unwanted booking.
            }
        }
    }

    // Flip every cancellable booking to cancelled + release slots.
    const cancellableIds = cancellable.map((s: Sib) => s.id);
    await supabase.from("bookings").update({ status: "cancelled" } as never).in("id", cancellableIds);

    const slotIds = cancellable.map((s: Sib) => s.availability_id).filter(Boolean);
    if (slotIds.length > 0) {
        await supabase.from("court_availability").update({ is_booked: false } as never).in("id", slotIds);
    }

    // Only the refundable weeks' payment rows get flipped to refunded;
    // the lapsed weeks' payments stay 'succeeded' since no money came back.
    if (refundable.length > 0) {
        const refundedIds = refundable.map((s: Sib) => s.id);
        await supabase.from("payments").update({ status: "refunded" } as never).in("booking_id", refundedIds);
    }

    await logAuditEvent({
        actorId: user.id,
        actorRole: "user",
        action: "booking.cancel_series",
        targetType: "booking",
        targetId: bookingId,
        metadata: {
            recurring_group_id: groupId,
            total_in_series: siblings.length,
            cancelled_count: cancellable.length,
            refunded_count: refundable.length,
            refund_amount_aed: refundAmountAed,
            stripe_refunded: stripeRefunded,
        },
    });

    revalidatePath(`/${locale}/bookings`);
    return {
        success: true,
        cancelled: cancellable.length,
        refunded: refundable.length,
        refundAmount: refundAmountAed,
    };
}

// ---------------------------------------------------------------------------
// SAH-93 helper: looks up the wallet 'spend' tied to a booking_id and refunds
// it via refund_wallet_credit. Idempotent — checks for existing 'refund' rows
// so a re-cancel doesn't double-refund. Returns the amount refunded.
// ---------------------------------------------------------------------------
async function refundWalletCreditForBooking(userId: string, bookingId: string): Promise<number> {
    try {
        const admin = createAdminClient();
        // Sum signed amounts for this booking — spend is negative, refund is
        // positive. If they cancel out the wallet was already refunded.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { data: txs } = await (admin as any)
            .from("wallet_transactions")
            .select("amount_aed, reason")
            .eq("user_id", userId)
            .eq("booking_id", bookingId);

        const net = (txs ?? []).reduce(
            (acc: number, t: { amount_aed: number }) => acc + Number(t.amount_aed),
            0,
        );
        // net < 0 means there's an unrefunded spend equal to |net|.
        if (net < 0) {
            const refundAmount = -net;
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            await (admin as any).rpc("refund_wallet_credit", {
                p_user_id: userId,
                p_amount: refundAmount,
                p_booking_id: bookingId,
            });
            return refundAmount;
        }
    } catch (err) {
        captureRouteError(err, {
            route: "actions:walletRefundOnCancel",
            user_id: userId,
            extra: { booking_id: bookingId },
        });
    }
    return 0;
}

// ---------------------------------------------------------------------------
// Booking: cancel by facility owner — full refund regardless of 24h window.
// SAH-87: closes the gap where RLS allows owners to UPDATE bookings but no
// action handles the refund + notification side. If we let an owner just
// flip status='cancelled' the player loses money silently.
// ---------------------------------------------------------------------------
export async function ownerCancelBookingAction(bookingId: string, reason: string) {
    const supabase = await createClient();
    const locale = await getLocale();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return { error: await tr("common.not_authenticated") };

    // Verify caller owns the facility containing the court for this booking.
    const { data: booking } = await supabase
        .from("bookings")
        .select(`
            id, status, availability_id, court_id, player_id,
            courts(facility_id, facilities(owner_id))
        `)
        .eq("id", bookingId)
        .single();

    if (!booking) return { error: await tr("booking.not_found") };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ownerId = (booking as any).courts?.facilities?.owner_id;
    if (ownerId !== user.id) return { error: await tr("common.access_denied") };

    if (!["confirmed", "pending"].includes(booking.status)) {
        return { error: await tr("booking.cannot_cancel") };
    }

    // Issue full refund regardless of window — owner-initiated cancellations
    // should never punish the player.
    const { data: payment } = await supabase
        .from("payments")
        .select("stripe_payment_intent_id, status")
        .eq("booking_id", bookingId)
        .single();

    let refunded = false;
    if (payment?.stripe_payment_intent_id && payment.status === "succeeded") {
        try {
            await getStripe().refunds.create({ payment_intent: payment.stripe_payment_intent_id });
            await supabase.from("payments").update({ status: "refunded" } as never).eq("booking_id", bookingId);
            refunded = true;
        } catch (err) {
            captureRouteError(err, {
                route: "actions:ownerCancelBooking",
                level: "error",
                extra: { booking_id: bookingId, payment_intent_id: payment.stripe_payment_intent_id },
            });
            // Continue cancelling so the slot is released. Refund will be
            // retried via the audit trail / Stripe dashboard.
        }
    }

    await supabase.from("bookings").update({ status: "cancelled" } as never).eq("id", bookingId);
    await supabase
        .from("court_availability")
        .update({ is_booked: false } as never)
        .eq("id", booking.availability_id);

    // SAH-93 follow-up: refund the player's wallet credit if they used any.
    const walletRefunded = await refundWalletCreditForBooking(booking.player_id, bookingId);

    await logAuditEvent({
        actorId: user.id,
        actorRole: "business",
        action: "booking.cancel.owner",
        targetType: "booking",
        targetId: bookingId,
        metadata: {
            reason: reason || null,
            refunded,
            prior_status: booking.status,
            wallet_credit_refunded: walletRefunded,
        },
    });

    revalidatePath(`/${locale}/dashboard/bookings`);
    revalidatePath(`/${locale}/bookings`);
    return { success: true, refunded };
}

export async function markCheckedInAction(bookingId: string) {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return { error: await tr("common.unauthorized") };

    const { data: facility } = await supabase
        .from("facilities")
        .select("id")
        .eq("owner_id", user.id)
        .single();
    if (!facility) return { error: await tr("common.no_facility") };

    // Find the player so we can run the loyalty milestone check after the
    // status flip — this is the canonical "completed" trigger.
    const { data: bookingRow } = await supabase
        .from("bookings")
        .select("player_id")
        .eq("id", bookingId)
        .single();

    await supabase
        .from("bookings")
        .update({ status: "completed" } as never)
        .eq("id", bookingId)
        .eq("status", "confirmed");

    // SAH-93: try awarding a milestone credit. RPC is idempotent — safe to
    // call after every check-in, returns 0 until the threshold is hit.
    const playerId = (bookingRow as { player_id: string } | null)?.player_id;
    if (playerId) {
        const admin = createAdminClient();
        try {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            await (admin as any).rpc("award_loyalty_credit_if_due", { p_user_id: playerId });
        } catch (err) {
            captureRouteError(err, {
                route: "actions:checkInBooking",
                user_id: playerId,
                extra: { phase: "loyalty_award_if_due" },
            });
        }
    }

    revalidatePath("/dashboard/checkin");
    return { success: true };
}

// ---------------------------------------------------------------------------
// SAH-93: read the caller's wallet balance + recent ledger. RLS already
// scopes both tables to the caller, so no extra ownership checks needed.
// ---------------------------------------------------------------------------
export async function getWalletAction() {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return { error: await tr("common.unauthorized") };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: balanceRow } = await (supabase as any)
        .from("wallet_balances")
        .select("credit_aed, updated_at")
        .eq("user_id", user.id)
        .maybeSingle();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: ledger } = await (supabase as any)
        .from("wallet_transactions")
        .select("id, amount_aed, reason, booking_id, created_at")
        .eq("user_id", user.id)
        .order("created_at", { ascending: false })
        .limit(20);

    return {
        balance: Number(balanceRow?.credit_aed ?? 0),
        ledger: (ledger ?? []) as Array<{
            id: string;
            amount_aed: number;
            reason: "booking_milestone" | "spend" | "refund" | "admin";
            booking_id: string | null;
            created_at: string;
        }>,
    };
}

// ---------------------------------------------------------------------------
// SAH-61: scanner-driven check-in. Looks the booking up by its qr_code_token,
// verifies the booking is at one of the caller's facilities and dated today,
// then marks it completed. Returns enough info for the UI to confirm the
// match before flipping status.
// ---------------------------------------------------------------------------
export async function checkInByQrTokenAction(token: string) {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return { error: await tr("common.unauthorized") };

    if (!token || token.length < 8) return { error: await tr("booking.qr_invalid") };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: booking } = await (supabase as any)
        .from("bookings")
        .select(`
            id, date, start_time, end_time, status, num_players,
            courts(name, facility_id, facilities(owner_id, name)),
            profiles(display_name)
        `)
        .eq("qr_code_token", token)
        .single();

    if (!booking) return { error: await tr("booking.qr_not_found") };

    const ownerId = booking.courts?.facilities?.owner_id;
    if (ownerId !== user.id) return { error: await tr("booking.cross_facility") };

    const today = new Date().toISOString().split("T")[0];
    if (booking.date !== today) {
        return { error: await tr("booking.checkin_wrong_date", { date: booking.date }) };
    }

    if (booking.status === "completed") {
        return {
            alreadyCheckedIn: true,
            booking: {
                id: booking.id,
                playerName: booking.profiles?.display_name ?? "Player",
                courtName: booking.courts?.name ?? "Court",
                startTime: booking.start_time as string,
                endTime: booking.end_time as string,
                numPlayers: booking.num_players as number,
            },
        };
    }
    if (booking.status !== "confirmed") {
        return { error: await tr("booking.checkin_wrong_status", { status: booking.status }) };
    }

    const { error } = await supabase
        .from("bookings")
        .update({ status: "completed" } as never)
        .eq("id", booking.id)
        .eq("status", "confirmed");

    if (error) return { error: await tr("booking.checkin_failed") };

    revalidatePath("/dashboard/checkin");

    return {
        success: true,
        booking: {
            id: booking.id,
            playerName: booking.profiles?.display_name ?? "Player",
            courtName: booking.courts?.name ?? "Court",
            startTime: booking.start_time as string,
            endTime: booking.end_time as string,
            numPlayers: booking.num_players as number,
        },
    };
}

// ---------------------------------------------------------------------------
// SAH-91: facility-declared closed dates (holidays, maintenance, Eid, etc.)
//
// Owner declares dates the facility is closed; a nightly cron sweeps any
// confirmed bookings on those dates, cancels them, refunds the player and
// fires a notification. These actions just manage the owner's list — the
// money/notify side runs server-side in /api/cron/skip-closed-bookings.
// ---------------------------------------------------------------------------
async function assertFacilityOwnerOrAdmin(facilityId: string) {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return { error: await tr("common.not_authenticated") };
    const { data: f } = await supabase
        .from("facilities")
        .select("id, owner_id")
        .eq("id", facilityId)
        .single();
    if (!f) return { error: await tr("common.access_denied") };
    const { data: profile } = await supabase
        .from("profiles").select("role").eq("id", user.id).single();
    const role = (profile as { role: string } | null)?.role ?? "user";
    const owner = (f as { owner_id: string }).owner_id;
    if (owner !== user.id && role !== "admin") return { error: await tr("common.access_denied") };
    return { supabase, user };
}

export async function addFacilityClosedDateAction(
    facilityId: string,
    closedDate: string,
    reason: string,
) {
    const auth = await assertFacilityOwnerOrAdmin(facilityId);
    if ("error" in auth) return { error: auth.error };
    const { supabase, user } = auth;
    const locale = await getLocale();

    // Validate the date — must be YYYY-MM-DD and not in the past.
    if (!/^\d{4}-\d{2}-\d{2}$/.test(closedDate)) {
        return { error: await tr("closed_dates.invalid_date") };
    }
    const today = new Date().toISOString().slice(0, 10);
    if (closedDate < today) {
        return { error: await tr("closed_dates.past_date") };
    }
    const trimmedReason = sanitizeTextInput(reason ?? "").slice(0, 200);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error } = await (supabase as any)
        .from("facility_closed_dates")
        .upsert({
            facility_id: facilityId,
            closed_date: closedDate,
            reason: trimmedReason,
            created_by: user.id,
        }, { onConflict: "facility_id,closed_date" });

    if (error) return { error: error.message };

    await logAuditEvent({
        actorId: user.id,
        actorRole: "user",
        action: "facility.closed_date.add",
        targetType: "facility",
        targetId: facilityId,
        metadata: { closed_date: closedDate, reason: trimmedReason },
    });

    revalidatePath(`/${locale}/dashboard/facility`);
    return { success: true };
}

export async function removeFacilityClosedDateAction(
    facilityId: string,
    closedDate: string,
) {
    const auth = await assertFacilityOwnerOrAdmin(facilityId);
    if ("error" in auth) return { error: auth.error };
    const { supabase, user } = auth;
    const locale = await getLocale();

    const { error } = await supabase
        .from("facility_closed_dates")
        .delete()
        .eq("facility_id", facilityId)
        .eq("closed_date", closedDate);

    if (error) return { error: error.message };

    await logAuditEvent({
        actorId: user.id,
        actorRole: "user",
        action: "facility.closed_date.remove",
        targetType: "facility",
        targetId: facilityId,
        metadata: { closed_date: closedDate },
    });

    revalidatePath(`/${locale}/dashboard/facility`);
    return { success: true };
}
