-- =============================================================================
-- SECURITY FIX (self-audit 2026-07-15) — CRITICAL privilege escalation.
--
-- The original policy (001_initial_schema.sql:338) was:
--     CREATE POLICY "profiles_update_own" ON public.profiles
--       FOR UPDATE USING (id = auth.uid());
-- i.e. USING only, NO WITH CHECK. In Postgres an UPDATE policy with no
-- WITH CHECK reuses the USING expression as the implicit check, which only
-- re-verifies `id = auth.uid()` on the NEW row and leaves every other column —
-- including `role` — freely writable. Any signed-in user could therefore run,
-- with the public anon key and their own session:
--     PATCH /rest/v1/profiles?id=eq.<self>   {"role":"admin"}
-- RLS permits it, is_admin() (which reads profiles.role) then returns true, and
-- every admin-only RLS policy unlocks — full platform takeover from any account.
--
-- FIX (defence in depth):
--   1. Re-create the policy with an explicit WITH CHECK that re-pins id. This
--      is behaviourally identical to the implicit default but documents the
--      invariant instead of relying on Postgres' fallback.
--   2. Add a BEFORE UPDATE trigger that FREEZES privilege columns (role,
--      no_show_count) whenever the caller is one of the PostgREST client roles
--      (`anon` / `authenticated`). Legitimate role changes are unaffected:
--        - adminChangeUserRoleAction() runs under the service-role key
--          (current_user = 'service_role'), and
--        - the documented bootstrap `UPDATE profiles SET role='admin' ...` runs
--          as a superuser in the SQL editor (current_user = 'postgres').
--      Neither is 'anon'/'authenticated', so both pass the guard.
--
-- WHY A TRIGGER rather than a self-referencing subquery in WITH CHECK
-- (e.g. `role = (SELECT role FROM profiles WHERE id = auth.uid())`):
--   * The trigger compares OLD.role vs NEW.role directly and unambiguously; the
--     subquery form depends on subtle MVCC snapshot semantics of reading the
--     same row mid-UPDATE and would re-enter profiles' own SELECT RLS.
--   * A single trigger freezes several columns and is trivially extensible.
--   * It holds no matter how the RLS policy is later edited, and it blocks the
--     `authenticated` role explicitly rather than implicitly.
-- Verified by supabase/tests/security_regression.sql.
-- =============================================================================

-- 1. Make the id-pin explicit on the UPDATE policy.
DROP POLICY IF EXISTS "profiles_update_own" ON public.profiles;
CREATE POLICY "profiles_update_own" ON public.profiles
    FOR UPDATE
    USING (id = auth.uid())
    WITH CHECK (id = auth.uid());

-- 2. Freeze privilege columns against the browser / API client roles.
CREATE OR REPLACE FUNCTION public.prevent_profile_privilege_change()
RETURNS TRIGGER
LANGUAGE plpgsql
-- NOTE: intentionally SECURITY INVOKER (the default). current_user must reflect
-- the CALLER's role (anon / authenticated / service_role), not the owner. Do
-- NOT mark this SECURITY DEFINER or the current_user guard breaks.
AS $$
BEGIN
    IF current_user IN ('anon', 'authenticated') THEN
        IF NEW.role IS DISTINCT FROM OLD.role THEN
            RAISE EXCEPTION 'profiles.role is not self-assignable'
                USING ERRCODE = 'insufficient_privilege',
                      HINT = 'Role changes are performed by an admin, not the account holder.';
        END IF;
        IF NEW.no_show_count IS DISTINCT FROM OLD.no_show_count THEN
            RAISE EXCEPTION 'profiles.no_show_count is system-managed'
                USING ERRCODE = 'insufficient_privilege';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS prevent_profile_privilege_change ON public.profiles;
CREATE TRIGGER prevent_profile_privilege_change
    BEFORE UPDATE ON public.profiles
    FOR EACH ROW
    EXECUTE FUNCTION public.prevent_profile_privilege_change();
