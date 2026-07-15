# Security

This document describes Saha's authorization model, the invariants the code
relies on, and the findings from the self-audit conducted on **2026-07-15**.

## Reporting a vulnerability

Email the maintainer (see `git log`) with steps to reproduce. Please do not open
a public issue for undisclosed vulnerabilities.

---

## Authorization model

Saha is **RLS-first**. Authorization is enforced in the database, not in the UI
or the middleware.

| Layer | Role | Trust |
| --- | --- | --- |
| **Postgres RLS + triggers** | The authoritative boundary. Every core table has RLS enabled; every write is scoped to owner/role by a policy, and privilege-bearing columns are frozen by `BEFORE UPDATE` triggers. | **Load-bearing.** |
| **Server guards** (`assertAdmin`, `getApiUser`, role checks in server actions) | Defence in depth + clearer errors. `assertAdmin()` additionally requires **MFA `aal2`** for every mutating admin action. | Secondary. |
| **Middleware** (`src/proxy.ts`) | UX gate + per-request CSP nonce. Redirects `/dashboard`/`/admin` by role. | **Not** a security boundary — RLS must hold even if middleware is bypassed. |

### The key invariant: no `USING`-only UPDATE policies on privileged tables

A Postgres `FOR UPDATE` policy with a `USING` clause but **no `WITH CHECK`**
reuses `USING` as the check — which validates the *old* row's visibility but
places **no constraint on the new row's column values**. That is how the two
worst findings below happened. The rule going forward:

> Any `FOR UPDATE` policy on a table that has privilege/state/money columns
> **must** have an explicit `WITH CHECK`, and those columns must additionally be
> frozen against the `anon`/`authenticated` PostgREST roles by a `BEFORE UPDATE`
> trigger. Privileged mutations (role changes, payment/attendance state) run
> only under the **service-role** key or a superuser.

Triggers (not subquery-in-`WITH CHECK`) are used because they compare `OLD` vs
`NEW` directly and unambiguously, freeze several columns in one place, and hold
regardless of how a policy is later edited.

### Other controls

- **Auth**: Supabase SSR cookies; server-validated `auth.getUser()` everywhere
  (`getSession()` is never trusted for authz). Admin actions require MFA `aal2`.
- **Rate limiting** (`src/lib/rate-limit.ts`): Upstash sliding window. Auth,
  password-reset and OTP paths **fail closed** — if the backend is unavailable
  in production they deny and page ops, rather than serving unthrottled traffic.
- **CSP** (`src/proxy.ts`): per-request nonce + `strict-dynamic`, no
  `unsafe-inline` for scripts. Static headers (HSTS preload, `X-Frame-Options
  DENY`, `nosniff`, Referrer-Policy, Permissions-Policy) in `next.config.ts`.
- **Input validation**: centralized Zod schemas (`src/lib/validations.ts`);
  100% parameterized DB access (supabase-js query builder / typed RPCs); no
  dynamic SQL.
- **Secrets**: service-role key server-only; Stripe webhook verifies the HMAC
  signature before any side effect and dedupes via `stripe_events`; cron routes
  require `CRON_SECRET` and **fail closed** when it is unset.
- **Audit log**: append-only (`audit_log`; SELECT-only for admins, no
  INSERT/UPDATE/DELETE policy; service-role inserts) covering admin, owner and
  finance mutations.

---

## Self-audit findings — found and fixed (2026-07-15)

| # | Severity | Finding | Fix | Status |
| --- | --- | --- | --- | --- |
| 1 | **Critical** | `profiles_update_own` had no `WITH CHECK`, so any signed-in user could `PATCH /rest/v1/profiles {"role":"admin"}` via the anon key and take over the platform. | Explicit `WITH CHECK` + `prevent_profile_privilege_change` trigger freezing `role`/`no_show_count` for `anon`/`authenticated`. | ✅ Fixed — `migrations/20260715120000_fix_profiles_role_escalation.sql` |
| 2 | **High** | `bookings_update_player_or_owner` had no `WITH CHECK`, so a player could self-set their booking to `confirmed` (unpaid reservation) or `completed` (fabricated loyalty credit + review rights). | Explicit `WITH CHECK` + `enforce_booking_update_rules` trigger: client roles may only cancel; status/price are service-role-only. | ✅ Fixed — `migrations/20260715120100_fix_booking_status_bypass.sql` |
| 3 | Medium | Rate limiter failed **open** (missing Upstash env / backend error → `success:true`), silently disabling auth/OTP/reset throttling. | `failClosed` option; auth, password-reset and OTP call sites now deny on unavailability in production. | ✅ Fixed — `src/lib/rate-limit.ts` + call sites |
| 4 | Medium | Cron auth failed **open**: unset `CRON_SECRET` made `Bearer undefined` authenticate any caller to service-role jobs. | `requireCronAuth()` helper rejects when the secret is falsy; used by all 4 cron routes. | ✅ Fixed — `src/lib/cron-auth.ts` + cron routes |
| 5 | Medium | Open redirect: login and OAuth callback redirected to an unvalidated `next` param. | `safeNextPath()` allows only same-origin paths (blocks `//host`, absolute URLs). | ✅ Fixed — `src/lib/safe-redirect.ts` + call sites |
| 6 | Docs | README/OPS claimed Vercel BotID was code-wired via `src/lib/botid.ts`, which does not exist. | Corrected README and OPS to state BotID is not implemented. | ✅ Fixed |

### Known / under review (not yet fixed)

- **Refund path** — `payments.stripe_payment_intent_id` is never persisted (the
  webhook writes only `stripe_checkout_session_id`), so app-initiated refunds
  silently no-op while single-cancel returns `refunded:true`. Diagnosis
  confirmed; minimal fix proposed (persist the intent id on
  `checkout.session.completed`). Tracked for a follow-up.

---

## Regression test

`supabase/tests/security_regression.sql` proves findings #1 and #2 stay fixed.
Run it against a **non-production** Supabase database (local `supabase start`
or a preview branch — it needs the standard `anon`/`authenticated` roles and
the `auth` schema). It is fully transactional and **rolls back** — nothing
persists:

```bash
psql "$DATABASE_URL" -f supabase/tests/security_regression.sql
```

It seeds a throwaway `user` + booking, impersonates that user as an ordinary
PostgREST caller, and asserts:

1. `UPDATE profiles SET role='admin'` on their own row is **rejected**.
2. `UPDATE bookings SET status='confirmed' | 'completed'` on their own booking is
   **rejected**.
3. Legitimate self-service still works (display-name change; self-cancel).

Any regression aborts the run with `ERROR`; a clean run prints only `PASS`
notices.
