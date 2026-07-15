import { NextRequest, NextResponse } from "next/server";
import { getStripe } from "@/lib/stripe";
import { createAdminClient } from "@/lib/supabase/admin";
import { sendWhatsApp } from "@/lib/twilio";
import { sendBookingConfirmationEmail } from "@/lib/emails/booking-confirmation-email";
import { logAuditEvent } from "@/lib/audit";
import { captureRouteError, captureRouteMessage } from "@/lib/sentry-helpers";
import { format } from "date-fns";
import Stripe from "stripe";

const ROUTE = "stripe/webhook";

export async function POST(req: NextRequest) {
    const body = await req.text();
    const sig = req.headers.get("stripe-signature");

    if (!sig) return NextResponse.json({ error: "No signature" }, { status: 400 });

    let event: Stripe.Event;
    try {
        event = getStripe().webhooks.constructEvent(body, sig, process.env.STRIPE_WEBHOOK_SECRET!);
    } catch {
        return NextResponse.json({ error: "Invalid signature" }, { status: 400 });
    }

    const supabase = createAdminClient();

    // Idempotency: insert the event id first. If it already exists, this is
    // a retry — return 200 without re-running side effects (WhatsApp + email).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error: dedupError } = await (supabase as any)
        .from("stripe_events")
        .insert({ id: event.id, type: event.type });
    if (dedupError) {
        // 23505 = unique_violation — already processed, ack and skip.
        if (dedupError.code === "23505") {
            return NextResponse.json({ received: true, duplicate: true });
        }
        // Anything else: let Stripe retry.
        return NextResponse.json({ error: "Database error" }, { status: 500 });
    }

    if (event.type === "checkout.session.completed") {
        const session = event.data.object as Stripe.Checkout.Session;
        const bookingId = session.metadata?.booking_id;
        const recurringGroupId = session.metadata?.recurring_group_id;
        const bookingGuestId = session.metadata?.booking_guest_id;
        const bookerId = session.metadata?.booker_id;

        // SAH-92: a friend just paid their share via Payment Link. Flip
        // the guest row and award the booker an equal-amount wallet credit.
        if (bookingGuestId) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const { data: guest } = await (supabase as any)
                .from("booking_guests")
                .select("id, share_amount, payment_status, booking_id")
                .eq("id", bookingGuestId)
                .single();
            if (guest && guest.payment_status === "pending") {
                await supabase
                    .from("booking_guests")
                    .update({
                        payment_status: "paid",
                        paid_at: new Date().toISOString(),
                    } as never)
                    .eq("id", bookingGuestId);

                if (bookerId && guest.share_amount) {
                    try {
                        // eslint-disable-next-line @typescript-eslint/no-explicit-any
                        await (supabase as any).rpc("refund_wallet_credit", {
                            p_user_id: bookerId,
                            p_amount: Number(guest.share_amount),
                            p_booking_id: guest.booking_id,
                        });
                    } catch (err) {
                        captureRouteError(err, {
                            route: ROUTE,
                            extra: {
                                event_id: event.id,
                                booking_guest_id: bookingGuestId,
                                booker_id: bookerId,
                                share_amount: guest.share_amount,
                                phase: "split_wallet_credit_award",
                            },
                        });
                    }
                }
            }
            return NextResponse.json({ received: true });
        }

        if (!bookingId) return NextResponse.json({ received: true });

        if (recurringGroupId) {
            // Whole-series confirmation (SAH-91). Flip every booking + every
            // associated payment in one go. Slots were locked at session
            // creation time so we don't need to lock again here.
            const { data: groupBookings } = await supabase
                .from("bookings")
                .select("id")
                .eq("recurring_group_id", recurringGroupId);
            const groupBookingIds = (groupBookings ?? []).map((b: { id: string }) => b.id);

            await supabase
                .from("bookings")
                .update({ status: "confirmed" } as never)
                .eq("recurring_group_id", recurringGroupId);

            if (groupBookingIds.length > 0) {
                await supabase
                    .from("payments")
                    .update({ status: "succeeded", stripe_checkout_session_id: session.id } as never)
                    .in("booking_id", groupBookingIds);
            }
        } else {
            await supabase
                .from("bookings")
                .update({ status: "confirmed" } as never)
                .eq("id", bookingId);

            const availabilityId = session.metadata?.availability_id;
            if (!availabilityId) {
                // Without an availability_id we silently update no row and
                // the slot stays in an inconsistent state. Flag it loudly.
                captureRouteMessage("checkout.session.completed missing availability_id", {
                    route: ROUTE,
                    level: "error",
                    extra: { event_id: event.id, booking_id: bookingId, session_id: session.id },
                });
            } else {
                await supabase
                    .from("court_availability")
                    .update({ is_booked: true } as never)
                    .eq("id", availabilityId);
            }

            // Refund fix (self-audit 2026-07-15): persist the payment intent id
            // so cancel/refund and the charge.refunded / dispute.created webhook
            // sync can locate the charge. Previously only the session id was
            // stored, so payments.stripe_payment_intent_id stayed null and
            // app-initiated refunds silently no-op'd. (Single-booking path only:
            // a recurring series shares one intent across N payment rows and the
            // column is UNIQUE, so the series-cancel path resolves the intent
            // from the checkout session instead.)
            const paymentIntentId = typeof session.payment_intent === "string"
                ? session.payment_intent
                : session.payment_intent?.id ?? null;

            await supabase
                .from("payments")
                .update({
                    status: "succeeded",
                    stripe_checkout_session_id: session.id,
                    stripe_payment_intent_id: paymentIntentId,
                } as never)
                .eq("booking_id", bookingId);
        }

        // Send WhatsApp confirmation and email
        const { data: booking } = await supabase
            .from("bookings")
            .select(`
                id, date, start_time, end_time, num_players, total_price, currency, qr_code_token,
                courts(name, facilities(name, address, city)),
                profiles(id, display_name, phone, phone_verified)
            `)
            .eq("id", bookingId)
            .single();

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const court = (booking as any)?.courts;
        const facility = court?.facilities;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const profile = (booking as any)?.profiles;

        if (booking && profile?.phone && profile?.phone_verified) {
            const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "";
            const bookingUrl = `${appUrl}/en/bookings/${booking.id}`;
            const readableDate = format(new Date(booking.date), "EEEE, MMMM d, yyyy");

            await sendWhatsApp(
                profile.phone,
                `✅ Booking confirmed!\n\n` +
                `🏟 ${court?.name} at ${facility?.name}\n` +
                `📅 ${readableDate}\n` +
                `⏰ ${booking.start_time.slice(0, 5)} – ${booking.end_time.slice(0, 5)}\n` +
                `📍 ${facility?.address}, ${facility?.city}\n\n` +
                `View your booking & QR code:\n${bookingUrl}`
            ).catch(() => {/* WhatsApp not blocking — fire and forget */});
        }

        // Send confirmation email (fire and forget)
        if (booking && profile) {
            try {
                // Fetch player email from auth
                const { data: { user } } = await supabase.auth.admin.getUserById(profile.id);
                const playerEmail = user?.email;

                if (playerEmail) {
                    // SAH-90: render the Tax Invoice PDF and attach. Failure
                    // here is non-blocking — the email still goes out, the
                    // player can re-download from /bookings/[id]/invoice.
                    let invoicePdf: { buffer: Buffer; invoiceNumber: string } | null = null;
                    try {
                        const { renderInvoicePdf } = await import("@/lib/pdf/render-invoice");
                        const rendered = await renderInvoicePdf(booking.id);
                        if (rendered) {
                            invoicePdf = {
                                buffer: rendered.buffer,
                                invoiceNumber: rendered.data.invoiceNumber,
                            };
                        }
                    } catch (err) {
                        captureRouteError(err, {
                            route: ROUTE,
                            extra: {
                                event_id: event.id,
                                booking_id: booking.id,
                                phase: "invoice_pdf_render",
                            },
                        });
                    }

                    await sendBookingConfirmationEmail({
                        bookingId: booking.id,
                        playerName: profile.display_name || "Player",
                        playerEmail,
                        facilityName: facility?.name || "Facility",
                        facilityAddress: facility?.address || "",
                        facilityCity: facility?.city || "",
                        courtName: court?.name || "Court",
                        date: booking.date,
                        startTime: booking.start_time.slice(0, 5),
                        endTime: booking.end_time.slice(0, 5),
                        numPlayers: booking.num_players || 1,
                        totalPrice: booking.total_price || 0,
                        currency: booking.currency || "USD",
                        appUrl: process.env.NEXT_PUBLIC_APP_URL ?? "",
                        invoicePdf,
                    }).catch((error) => {
                        captureRouteError(error, {
                            route: ROUTE,
                            extra: { event_id: event.id, booking_id: booking.id, phase: "confirmation_email_send" },
                        });
                    });
                }
            } catch (error) {
                captureRouteError(error, {
                    route: ROUTE,
                    extra: { event_id: event.id, booking_id: booking.id, phase: "confirmation_email_flow" },
                });
            }
        }
    }

    if (event.type === "checkout.session.expired") {
        const session = event.data.object as Stripe.Checkout.Session;
        const bookingId = session.metadata?.booking_id;
        const availabilityId = session.metadata?.availability_id;
        const recurringGroupId = session.metadata?.recurring_group_id;
        if (!bookingId) return NextResponse.json({ received: true });

        if (recurringGroupId) {
            // SAH-91: a whole series expired — cancel every booking + release
            // every slot. Without this, N-1 slots stay locked forever.
            const { data: groupBookings } = await supabase
                .from("bookings")
                .select("availability_id")
                .eq("recurring_group_id", recurringGroupId);

            await supabase
                .from("bookings")
                .update({ status: "cancelled" } as never)
                .eq("recurring_group_id", recurringGroupId);

            const slotIds = (groupBookings ?? [])
                .map((b: { availability_id: string }) => b.availability_id)
                .filter(Boolean);
            if (slotIds.length > 0) {
                await supabase
                    .from("court_availability")
                    .update({ is_booked: false } as never)
                    .in("id", slotIds);
            }
        } else {
            if (!availabilityId) {
                // Same silent-no-op risk as in the completed branch — flag it.
                captureRouteMessage("checkout.session.expired missing availability_id", {
                    route: ROUTE,
                    level: "warning",
                    extra: { event_id: event.id, booking_id: bookingId, session_id: session.id },
                });
            } else {
                await supabase
                    .from("court_availability")
                    .update({ is_booked: false } as never)
                    .eq("id", availabilityId);
            }

            await supabase
                .from("bookings")
                .update({ status: "cancelled" } as never)
                .eq("id", bookingId);

            // SAH-93: refund any wallet credit that was applied to this
            // booking. Without this, an expired session burns the player's
            // credit with no booking to show for it.
            const walletCredit = Number(session.metadata?.wallet_credit_applied ?? 0);
            if (walletCredit > 0) {
                const { data: bookingRow } = await supabase
                    .from("bookings")
                    .select("player_id")
                    .eq("id", bookingId)
                    .single();
                const playerId = (bookingRow as { player_id: string } | null)?.player_id;
                if (playerId) {
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    await (supabase as any).rpc("refund_wallet_credit", {
                        p_user_id: playerId,
                        p_amount: walletCredit,
                        p_booking_id: bookingId,
                    });
                }
            }
        }
    }

    // ---------------------------------------------------------------------
    // Payment intent failed — release the slot, mark booking cancelled, and
    // notify the player. Triggered when 3DS challenges fail or card declines
    // happen after the Checkout session was created but before completion.
    // ---------------------------------------------------------------------
    if (event.type === "payment_intent.payment_failed") {
        const intent = event.data.object as Stripe.PaymentIntent;
        const bookingId = intent.metadata?.booking_id;
        const availabilityId = intent.metadata?.availability_id;

        if (bookingId) {
            // Look up the booking's recurring_group_id (intent metadata
            // doesn't carry it). When set, fan out cancellation to the whole
            // series so we don't leak inventory on a failed recurring charge.
            const { data: bookingRow } = await supabase
                .from("bookings")
                .select("recurring_group_id")
                .eq("id", bookingId)
                .single();
            const groupId = (bookingRow as { recurring_group_id: string | null } | null)?.recurring_group_id ?? null;

            if (groupId) {
                const { data: groupBookings } = await supabase
                    .from("bookings")
                    .select("id, availability_id")
                    .eq("recurring_group_id", groupId);

                const groupBookingIds = (groupBookings ?? []).map((b: { id: string }) => b.id);
                const groupSlotIds = (groupBookings ?? [])
                    .map((b: { availability_id: string }) => b.availability_id)
                    .filter(Boolean);

                if (groupBookingIds.length > 0) {
                    await supabase
                        .from("payments")
                        .update({ status: "failed" } as never)
                        .in("booking_id", groupBookingIds);

                    await supabase
                        .from("bookings")
                        .update({ status: "cancelled" } as never)
                        .in("id", groupBookingIds);
                }
                if (groupSlotIds.length > 0) {
                    await supabase
                        .from("court_availability")
                        .update({ is_booked: false } as never)
                        .in("id", groupSlotIds);
                }
            } else {
                await supabase
                    .from("payments")
                    .update({ status: "failed" } as never)
                    .eq("booking_id", bookingId);

                await supabase
                    .from("bookings")
                    .update({ status: "cancelled" } as never)
                    .eq("id", bookingId);

                if (availabilityId) {
                    await supabase
                        .from("court_availability")
                        .update({ is_booked: false } as never)
                        .eq("id", availabilityId);
                }
            }
        }
    }

    // ---------------------------------------------------------------------
    // Refund issued from the Stripe dashboard (i.e. not via our cancel flow).
    // Sync our payments + bookings rows so the dashboard stays consistent.
    // ---------------------------------------------------------------------
    if (event.type === "charge.refunded") {
        const charge = event.data.object as Stripe.Charge;
        const intentId = typeof charge.payment_intent === "string"
            ? charge.payment_intent
            : charge.payment_intent?.id;
        if (intentId) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const { data: payment } = await (supabase as any)
                .from("payments")
                .select("booking_id")
                .eq("stripe_payment_intent_id", intentId)
                .single();

            if (payment?.booking_id) {
                await supabase
                    .from("payments")
                    .update({ status: "refunded" } as never)
                    .eq("booking_id", payment.booking_id);

                await supabase
                    .from("bookings")
                    .update({ status: "cancelled" } as never)
                    .eq("id", payment.booking_id);

                await logAuditEvent({
                    actorId: null,
                    actorRole: "system",
                    action: "payment.refunded.via_stripe_dashboard",
                    targetType: "booking",
                    targetId: payment.booking_id,
                    metadata: { stripe_payment_intent_id: intentId, charge_id: charge.id },
                });
            }
        }
    }

    // ---------------------------------------------------------------------
    // Connected account state changed. The most useful signal is when an
    // owner finishes Connect onboarding (charges_enabled flips to true) —
    // we want a record so the dashboard can show "ready" status.
    // ---------------------------------------------------------------------
    if (event.type === "account.updated") {
        const account = event.data.object as Stripe.Account;
        await logAuditEvent({
            actorId: null,
            actorRole: "system",
            action: "stripe.account.updated",
            targetType: "stripe_account",
            metadata: {
                stripe_account_id: account.id,
                charges_enabled: account.charges_enabled,
                details_submitted: account.details_submitted,
                payouts_enabled: account.payouts_enabled,
            },
        });
    }

    // ---------------------------------------------------------------------
    // Owner deauthorized our app on their Stripe account. Clear the linked
    // account id so future booking attempts hit the "not yet ready" guard
    // (SAH-68) and the owner is forced to reconnect.
    // For this event the connected account id is on event.account, not in
    // event.data.object (which is the deauthorized Application).
    // ---------------------------------------------------------------------
    if (event.type === "account.application.deauthorized") {
        const connectedAccountId = event.account;
        if (connectedAccountId) {
            await supabase
                .from("facilities")
                .update({ stripe_account_id: null } as never)
                .eq("stripe_account_id", connectedAccountId);

            await logAuditEvent({
                actorId: null,
                actorRole: "system",
                action: "stripe.account.deauthorized",
                targetType: "stripe_account",
                metadata: { stripe_account_id: connectedAccountId },
            });
        }
    }

    // ---------------------------------------------------------------------
    // Payout to the connected account failed. We can't fix this from code —
    // it usually means the owner's bank rejected. Record for ops follow-up.
    // ---------------------------------------------------------------------
    if (event.type === "payout.failed") {
        const payout = event.data.object as Stripe.Payout;
        await logAuditEvent({
            actorId: null,
            actorRole: "system",
            action: "stripe.payout.failed",
            targetType: "stripe_payout",
            metadata: {
                payout_id: payout.id,
                amount: payout.amount,
                currency: payout.currency,
                failure_code: payout.failure_code,
                failure_message: payout.failure_message,
            },
        });
        captureRouteMessage("stripe payout failed", {
            route: ROUTE,
            level: "error",
            extra: {
                payout_id: payout.id,
                failure_code: payout.failure_code,
                failure_message: payout.failure_message,
            },
        });
    }

    // ---------------------------------------------------------------------
    // Player chargeback. Pause the facility for ops review and record. We
    // intentionally do not auto-refund — disputes need human judgement.
    // ---------------------------------------------------------------------
    if (event.type === "charge.dispute.created") {
        const dispute = event.data.object as Stripe.Dispute;
        const intentId = typeof dispute.payment_intent === "string"
            ? dispute.payment_intent
            : dispute.payment_intent?.id;

        let facilityId: string | null = null;
        if (intentId) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const { data: payment } = await (supabase as any)
                .from("payments")
                .select("booking_id, bookings(court_id, courts(facility_id))")
                .eq("stripe_payment_intent_id", intentId)
                .single();
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            facilityId = (payment as any)?.bookings?.courts?.facility_id ?? null;
        }

        await logAuditEvent({
            actorId: null,
            actorRole: "system",
            action: "stripe.dispute.created",
            targetType: "stripe_dispute",
            targetId: facilityId,
            metadata: {
                dispute_id: dispute.id,
                amount: dispute.amount,
                currency: dispute.currency,
                reason: dispute.reason,
                status: dispute.status,
                stripe_payment_intent_id: intentId,
            },
        });
        captureRouteMessage("stripe dispute created", {
            route: ROUTE,
            level: "error",
            extra: { dispute_id: dispute.id, reason: dispute.reason, facility_id: facilityId },
        });
    }

    return NextResponse.json({ received: true });
}
