-- =============================================================================
-- Security regression test (self-audit 2026-07-15)
--
-- Proves that the two RLS authorization fixes stay in place:
--   #1 CRITICAL — a normal 'user' cannot escalate their own profiles.role
--   #2 HIGH     — a normal 'user' cannot self-confirm/-complete their booking
-- and that legitimate self-service (display-name change, self-cancel) still
-- works.
--
-- HOW TO RUN — pick one, against a NON-PRODUCTION Supabase database (a preview
-- branch or a local `supabase start`). Both migrations must be applied first.
--   A) Supabase Dashboard → SQL Editor: paste this whole file and Run.
--   B) psql:  psql "$DATABASE_URL" -f supabase/tests/security_regression.sql
--
-- Deliberately uses no psql-only meta-commands (\set etc.) so it runs in the
-- SQL Editor too. The whole script is one transaction and ROLLBACKs at the end,
-- so it is non-destructive. A clean run prints only "PASS ..." notices; any
-- regression (an escalation that is wrongly allowed) aborts with ERROR.
-- =============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Seed a throwaway auth user. The on_auth_user_created trigger
--    (handle_new_user) creates the matching public.profiles row as role='user'.
--    Adjust the auth.users column list if your Supabase version differs.
-- ---------------------------------------------------------------------------
INSERT INTO auth.users (instance_id, id, aud, role, email, encrypted_password,
                        created_at, updated_at, raw_app_meta_data, raw_user_meta_data)
VALUES ('00000000-0000-0000-0000-000000000000',
        '00000000-0000-4000-a000-0000000000aa', 'authenticated', 'authenticated',
        'sec-regression@example.test', '', now(), now(),
        '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb);

-- ---------------------------------------------------------------------------
-- 2. Seed a facility → court → availability → booking owned by that user, as
--    the migration/superuser role (bypasses the new client-role triggers).
-- ---------------------------------------------------------------------------
INSERT INTO public.facilities (id, owner_id, name, address, city, country, status)
VALUES ('00000000-0000-4000-a000-0000000000fb', '00000000-0000-4000-a000-0000000000aa',
        'Regression FC', '1 Test St', 'Dubai', 'AE', 'active');

INSERT INTO public.courts (id, facility_id, name, capacity, price_per_hour)
VALUES ('00000000-0000-4000-a000-0000000000cc', '00000000-0000-4000-a000-0000000000fb',
        'Court 1', 4, 100);

INSERT INTO public.court_availability (id, court_id, date, start_time, end_time, is_booked)
VALUES ('00000000-0000-4000-a000-0000000000dd', '00000000-0000-4000-a000-0000000000cc',
        current_date, '10:00', '11:00', true);

INSERT INTO public.bookings (id, availability_id, court_id, player_id, date,
                             start_time, end_time, num_players, total_price, currency, status)
VALUES ('00000000-0000-4000-a000-0000000000ee', '00000000-0000-4000-a000-0000000000dd',
        '00000000-0000-4000-a000-0000000000cc', '00000000-0000-4000-a000-0000000000aa',
        current_date, '10:00', '11:00', 2, 100, 'AED', 'pending');

-- ---------------------------------------------------------------------------
-- 3. Impersonate the seeded user as an ordinary authenticated PostgREST caller.
--    auth.uid() reads request.jwt.claims->>'sub'; SET LOCAL ROLE makes
--    current_user = 'authenticated', which is what the triggers gate on.
-- ---------------------------------------------------------------------------
SELECT set_config('request.jwt.claims',
    json_build_object('sub', '00000000-0000-4000-a000-0000000000aa', 'role', 'authenticated')::text,
    true);
SET LOCAL ROLE authenticated;

-- ---------------------------------------------------------------------------
-- 4. NEGATIVE — the attacks must be rejected by OUR triggers (match the message
--    so a missing GRANT can't produce a false PASS).
-- ---------------------------------------------------------------------------
DO $$
BEGIN
    -- #1 role self-escalation
    BEGIN
        UPDATE public.profiles SET role = 'admin'
        WHERE id = (current_setting('request.jwt.claims')::json ->> 'sub')::uuid;
        RAISE EXCEPTION 'REGRESSION #1: user was able to escalate profiles.role to admin';
    EXCEPTION WHEN insufficient_privilege THEN
        IF SQLERRM LIKE '%not self-assignable%' THEN
            RAISE NOTICE 'PASS #1: role escalation blocked (%)', SQLERRM;
        ELSE
            RAISE;  -- some other privilege error (e.g. missing table grant) — surface it
        END IF;
    END;

    -- #2a self-confirm (unpaid reservation)
    BEGIN
        UPDATE public.bookings SET status = 'confirmed'
        WHERE player_id = (current_setting('request.jwt.claims')::json ->> 'sub')::uuid;
        RAISE EXCEPTION 'REGRESSION #2a: user was able to self-confirm a booking';
    EXCEPTION WHEN insufficient_privilege THEN
        IF SQLERRM LIKE '%not permitted for this role%' THEN
            RAISE NOTICE 'PASS #2a: self-confirm blocked (%)', SQLERRM;
        ELSE
            RAISE;
        END IF;
    END;

    -- #2b self-complete (fabricated loyalty credit / review eligibility)
    BEGIN
        UPDATE public.bookings SET status = 'completed'
        WHERE player_id = (current_setting('request.jwt.claims')::json ->> 'sub')::uuid;
        RAISE EXCEPTION 'REGRESSION #2b: user was able to self-complete a booking';
    EXCEPTION WHEN insufficient_privilege THEN
        IF SQLERRM LIKE '%not permitted for this role%' THEN
            RAISE NOTICE 'PASS #2b: self-complete blocked (%)', SQLERRM;
        ELSE
            RAISE;
        END IF;
    END;
END $$;

-- ---------------------------------------------------------------------------
-- 5. POSITIVE — legitimate self-service must still succeed (these throw and
--    abort the run if wrongly blocked).
-- ---------------------------------------------------------------------------
DO $$
BEGIN
    UPDATE public.profiles SET display_name = 'Regression New Name'
    WHERE id = (current_setting('request.jwt.claims')::json ->> 'sub')::uuid;
    RAISE NOTICE 'PASS #3a: benign profile update allowed';

    UPDATE public.bookings SET status = 'cancelled'
    WHERE player_id = (current_setting('request.jwt.claims')::json ->> 'sub')::uuid;
    RAISE NOTICE 'PASS #3b: self-cancel (pending -> cancelled) allowed';
END $$;

RESET ROLE;
ROLLBACK;  -- nothing persists
