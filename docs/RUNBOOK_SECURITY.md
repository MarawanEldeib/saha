# Security Runbook

Operational playbook for the RLS authorization hardening from the **2026-07-15
self-audit** (PR #128, commit `bbafb33`). Companion to [`SECURITY.md`](../SECURITY.md),
which documents the authorization model and the full findings list.

Applies to the two database migrations:

- `supabase/migrations/20260715120000_fix_profiles_role_escalation.sql`
- `supabase/migrations/20260715120100_fix_booking_status_bypass.sql`

> **Key point:** merging the code does **not** close these two bugs. They are
> Postgres RLS migrations and only take effect once **applied to the database**.
> Application code changes (below) ship on deploy; the migrations are a separate,
> manual step per environment.

---

## 1. What was fixed

### 🔴 CRITICAL — `profiles.role` self-escalation (`20260715120000`)

The `profiles_update_own` policy was `FOR UPDATE USING (id = auth.uid())` with
**no `WITH CHECK`**. Postgres reuses the `USING` expression as the implicit
check, which only re-verifies `id = auth.uid()` on the new row and leaves every
other column — including `role` — writable. Any signed-in user could send, with
the public anon key and their own session:

```
PATCH /rest/v1/profiles?id=eq.<self>   {"role":"admin"}
```

RLS permitted it; `is_admin()` (which reads `profiles.role`) then returned true,
unlocking every admin-only RLS policy. **Full platform takeover from any account.**

**Fix:** explicit `WITH CHECK (id = auth.uid())` **plus** a `BEFORE UPDATE`
trigger `prevent_profile_privilege_change` that rejects any change to `role` or
`no_show_count` when the caller is one of the PostgREST client roles
(`anon` / `authenticated`).

### 🟠 HIGH — `bookings.status` / price self-bypass (`20260715120100`)

Same missing-`WITH CHECK` bug on `bookings_update_player_or_owner`. `player_id`
stayed pinned (no cross-user takeover), but the booking's own player could
rewrite `status` and `total_price`:

- `update({status:'confirmed'})` → a reserved court with **no payment captured**
- `update({status:'completed'})` → **fabricated loyalty credit + review rights**
  (both gate on a completed booking)

**Fix:** `WITH CHECK` **plus** a `BEFORE UPDATE` trigger
`enforce_booking_update_rules` that allows client roles only the
`pending|confirmed → cancelled` transition and freezes `total_price` / `currency`.
All money/attendance transitions remain service-role-only (Stripe webhook + cron).

### Supporting fixes (application code, same PR — live on deploy, no migration)

- **Rate limiter** fails **closed** on auth / password-reset / OTP in real
  production (`VERCEL_ENV=production`) when Upstash is unavailable — was failing
  open. Requires `UPSTASH_REDIS_REST_URL` / `_TOKEN` in Production.
- **Cron auth** rejects when `CRON_SECRET` is unset (was `Bearer undefined` = open).
- **Open redirect** on login + OAuth callback closed via `safeNextPath()`
  (same-origin paths only).
- **Refund** — persist `stripe_payment_intent_id` in the
  `checkout.session.completed` webhook so app-initiated refunds actually run;
  single-cancel reports `refunded:true` only when `refunds.create` succeeded.

### Why a trigger, not a subquery in `WITH CHECK`

A `BEFORE UPDATE` trigger compares `OLD` vs `NEW` directly, freezes several
columns in one place, and holds no matter how the policy is later edited — no
reliance on the MVCC snapshot semantics of a self-referencing subquery. It gates
on `current_user IN ('anon','authenticated')`, so the legitimate paths are
unaffected: admin role changes run under the **service-role** key
(`adminChangeUserRoleAction`), and the documented `UPDATE … SET role='admin'`
bootstrap runs as a **superuser** — neither is `anon`/`authenticated`.

---

## 2. Applying the migrations

These are **metadata-only** (add a `WITH CHECK`, two functions, two triggers) —
no table rewrite, sub-second locks, effectively zero downtime. Both files are
**idempotent** (`DROP … IF EXISTS` + `CREATE OR REPLACE`), so re-running is safe.

**Pre-flight**

- Run `supabase/tests/security_regression.sql` green on a preview branch first
  (proves it works against a copy of the schema).
- Confirm a recent backup / PITR exists.

**Method B — Dashboard SQL Editor (recommended; targeted, no CLI/DB password).**
Wrap each file so a failure can't half-apply:

```sql
BEGIN;
-- paste the full contents of 20260715120000_fix_profiles_role_escalation.sql
COMMIT;
```

```sql
BEGIN;
-- paste the full contents of 20260715120100_fix_booking_status_bypass.sql
COMMIT;
```

Each returns **Success. No rows returned.**

**Method A — `supabase db push` (only if the migration history is tracked).**
⚠️ `db push` replays *every* local migration not marked applied on the remote —
if prod has been managed via the SQL Editor, its history table may be empty and
`db push` will try to re-run old migrations.

```bash
supabase link --project-ref <ref>   # DB password when prompted
supabase migration list             # compare Local vs Remote
supabase db push                    # only if just the two 20260715 files are pending
```

If many migrations show unapplied, use **Method B** for just these two.

---

## 3. Verifying the fix

### L1 — Structural (catalog check; touches no data)

```sql
-- (a) profiles UPDATE policy now HAS a with_check
select polname,
       pg_get_expr(polqual,      polrelid) as using_expr,
       pg_get_expr(polwithcheck, polrelid) as with_check_expr
from pg_policy
where polrelid = 'public.profiles'::regclass and polname = 'profiles_update_own';
-- PASS: with_check_expr = (id = auth.uid())   [not null]

-- (b) both guard triggers exist and are enabled
select tgname, tgrelid::regclass as on_table, tgenabled
from pg_trigger
where tgname in ('prevent_profile_privilege_change','enforce_booking_update_rules');
-- PASS: two rows, tgenabled = 'O' (enabled)
```

### L2 — Behavioral, transactional (optional)

Run `supabase/tests/security_regression.sql`. It seeds a throwaway user + booking
**inside a transaction that ROLLBACKs**, so it persists nothing. A clean run
finishes with no `ERROR` and emits `PASS …` notices.

### L3 — End-to-end, the attacker's exact path (strongest)

Reproduce the exploit as a real authenticated user via PostgREST — use a
**throwaway non-admin account**, target **your own** id (so RLS passes and the
**trigger** is what rejects), then delete the account after.

```bash
REF=<ref>; ANON=<anon_key>
RESP=$(curl -s -X POST "https://$REF.supabase.co/auth/v1/token?grant_type=password" \
  -H "apikey: $ANON" -H "Content-Type: application/json" \
  -d '{"email":"escalation-test@example.com","password":"<pw>"}')
JWT=$(echo "$RESP" | jq -r .access_token); UID=$(echo "$RESP" | jq -r .user.id)

curl -i -X PATCH "https://$REF.supabase.co/rest/v1/profiles?id=eq.$UID" \
  -H "apikey: $ANON" -H "Authorization: Bearer $JWT" \
  -H "Content-Type: application/json" -H "Prefer: return=representation" \
  -d '{"role":"admin"}'
# PASS (fixed): HTTP/1.1 403, {"code":"42501","message":"profiles.role is not self-assignable"}
# FAIL (vulnerable): HTTP/1.1 200 with "role":"admin"
```

Booking bypass (same user, on a booking they own):

```bash
curl -i -X PATCH "https://$REF.supabase.co/rest/v1/bookings?id=eq.<booking_id>" \
  -H "apikey: $ANON" -H "Authorization: Bearer $JWT" \
  -H "Content-Type: application/json" -d '{"status":"confirmed"}'
# PASS: 403, "booking status transition pending -> confirmed is not permitted for this role"
```

---

## 4. Production application record

| Date | Environment | Migrations | Method | Result |
| --- | --- | --- | --- | --- |
| 2026-07-15 | Production | `20260715120000`, `20260715120100` | SQL Editor (Method B) | ✅ Success |

**Verification performed (L1, prod, 2026-07-15):**

- `profiles_update_own` → `with_check_expr = (id = auth.uid())` ✔
- `prevent_profile_privilege_change` on `public.profiles` → `tgenabled = 'O'` (enabled) ✔
- `enforce_booking_update_rules` on `public.bookings` → `tgenabled = 'O'` (enabled) ✔

**Conclusion:** the CRITICAL (`profiles.role` escalation) and HIGH (`bookings.status`
bypass) findings are **closed in production**.

---

## 5. Rollback (emergency only — re-opens the vulnerability)

```sql
DROP TRIGGER IF EXISTS prevent_profile_privilege_change ON public.profiles;
DROP TRIGGER IF EXISTS enforce_booking_update_rules      ON public.bookings;
-- the WITH CHECK additions are harmless and can stay
```

If a legitimate flow breaks, it points at code using the **user client** where it
should use the **service-role client** — fix that rather than rolling back, since
rollback restores the exploit.

---

## 6. Invariant going forward

> Any `FOR UPDATE` RLS policy on a table with privilege / state / money columns
> **must** have an explicit `WITH CHECK`, and those columns must additionally be
> frozen against the `anon` / `authenticated` roles by a `BEFORE UPDATE` trigger.
> Privileged mutations (role changes, payment/attendance state) run only under the
> service-role key or a superuser.

A `USING`-only UPDATE policy is the root cause of both findings above — treat it
as a review red flag.
