-- =============================================================================
-- SECURITY FIX (self-audit 2026-07-15) — HIGH payment / loyalty bypass.
--
-- The original policy (004_booking_system.sql:223) was:
--     CREATE POLICY "bookings_update_player_or_owner" ON public.bookings
--       FOR UPDATE USING (player_id = auth.uid() OR is_admin() OR <owner>);
-- USING only, NO WITH CHECK. The defaulted check only re-verified player_id, so
-- a booking's own player could freely rewrite `status` and `total_price`:
--     .from('bookings').update({status:'confirmed'})  -> reserved court, unpaid
--     .from('bookings').update({status:'completed'})   -> fabricated loyalty
--                                                         credit + review rights
-- Payment / attendance state must only ever move via the Stripe webhook and the
-- cron jobs, both of which run under the service-role key.
--
-- FIX:
--   1. Re-create the policy WITH CHECK identical to USING (pins player/owner on
--      the NEW row; no cross-user takeover).
--   2. Add a BEFORE UPDATE trigger. The PostgREST client roles (anon /
--      authenticated) may ONLY cancel a booking (pending|confirmed ->
--      cancelled) — the single status transition the app performs via the user
--      client (cancelBookingAction / cancelBookingSeriesAction). All
--      money/attendance transitions (confirmed / completed / no_show) are
--      reserved for the service role. total_price / currency are frozen for
--      client roles. moveBookingAction is unaffected: it changes slot/date/time
--      but leaves status and price untouched.
-- Verified by supabase/tests/security_regression.sql.
-- =============================================================================

-- 1. Add the explicit WITH CHECK (was missing entirely).
DROP POLICY IF EXISTS "bookings_update_player_or_owner" ON public.bookings;
CREATE POLICY "bookings_update_player_or_owner" ON public.bookings
    FOR UPDATE
    USING (
        player_id = auth.uid()
        OR public.is_admin()
        OR EXISTS (
            SELECT 1 FROM public.courts c
            JOIN public.facilities f ON f.id = c.facility_id
            WHERE c.id = court_id AND f.owner_id = auth.uid()
        )
    )
    WITH CHECK (
        player_id = auth.uid()
        OR public.is_admin()
        OR EXISTS (
            SELECT 1 FROM public.courts c
            JOIN public.facilities f ON f.id = c.facility_id
            WHERE c.id = court_id AND f.owner_id = auth.uid()
        )
    );

-- 2. Restrict client-role status/price changes.
CREATE OR REPLACE FUNCTION public.enforce_booking_update_rules()
RETURNS TRIGGER
LANGUAGE plpgsql
-- SECURITY INVOKER (default): current_user must be the caller's role.
AS $$
BEGIN
    -- Service role (Stripe webhook, cron) and superusers may make any change.
    IF current_user NOT IN ('anon', 'authenticated') THEN
        RETURN NEW;
    END IF;

    -- Client roles may only CANCEL, and only from a not-yet-finalised state.
    IF NEW.status IS DISTINCT FROM OLD.status
       AND NOT (NEW.status = 'cancelled' AND OLD.status IN ('pending', 'confirmed')) THEN
        RAISE EXCEPTION 'booking status transition % -> % is not permitted for this role',
            OLD.status, NEW.status
            USING ERRCODE = 'insufficient_privilege',
                  HINT = 'Confirmation/completion is driven by the payment webhook, not the client.';
    END IF;

    -- Money columns are never client-writable.
    IF NEW.total_price IS DISTINCT FROM OLD.total_price
       OR NEW.currency IS DISTINCT FROM OLD.currency THEN
        RAISE EXCEPTION 'booking price columns are not client-writable'
            USING ERRCODE = 'insufficient_privilege';
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS enforce_booking_update_rules ON public.bookings;
CREATE TRIGGER enforce_booking_update_rules
    BEFORE UPDATE ON public.bookings
    FOR EACH ROW
    EXECUTE FUNCTION public.enforce_booking_update_rules();
