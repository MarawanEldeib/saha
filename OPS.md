# Saha — Operations Runbook

Manual platform-config steps that complement the code. Walk these the first
time you set up a new environment, and again whenever a credential rotates.

---

## SAH-74: Lock the Mapbox token to allowed domains (Urgent)

`NEXT_PUBLIC_MAPBOX_TOKEN` is exposed to the browser by design — that's how
client-side maps work. The risk is that a scraper grabs the token and burns
our quota from their own apps.

**Fix (do this once, takes 60 seconds):**

1. https://account.mapbox.com/access-tokens
2. Open the public token used by `NEXT_PUBLIC_MAPBOX_TOKEN`.
3. Under **URL restrictions**, add:
   - `https://sahasports.vercel.app`
   - `http://localhost:3000` (dev)
4. Save. Mapbox will reject any request from any other origin within
   minutes.

**Verification:** open the DevTools Network panel on `localhost:3000/map`,
confirm the basemap tiles still load. Then visit a different origin (e.g.
a CodeSandbox embedding the map) and confirm Mapbox returns 401.

---

## SAH-78: Vercel BotID — NOT currently implemented

**Status: not wired in code.** An earlier branch added `src/lib/botid.ts` but
it was reverted; there is no `botid` dependency and no call site (verified in
the 2026-07-15 self-audit). This section previously claimed BotID was wired —
that claim was false and has been corrected. Do not document controls that
aren't in the code.

Automated-abuse protection today is the Upstash sliding-window rate limiter
(`src/lib/rate-limit.ts`), which **fails closed** on the auth and
password-reset paths (see `SECURITY.md`).

To actually add BotID later:

1. `npm install botid`, then wrap `loginAction`, `registerAction`,
   `forgotPasswordAction` with the server-side `checkBotId()` call.
2. Vercel Dashboard → saha → Settings → Bot Protection → **Enabled**.
3. Update this section **and** `README.md` to reflect that it is now live.

---

## SAH-100: Staging environment

We currently push everything straight to prod. Add a staging tier so
migrations can be tested before they hit live data.

### One-time setup

1. **Supabase**: create a second project named `saha-staging`. Use the same
   region as prod (usually `eu-central-1`). Note the project ref.
2. **Apply schema**: from the repo root,
   ```sh
   supabase link --project-ref <staging-ref>
   supabase db push    # applies every migration in supabase/migrations/
   ```
3. **Vercel**: Settings → Environments → Create environment "staging".
   Add the same env-var names as production but pointing at:
   - `NEXT_PUBLIC_SUPABASE_URL` → staging project URL
   - `NEXT_PUBLIC_SUPABASE_ANON_KEY` → staging anon key
   - `SUPABASE_SERVICE_ROLE_KEY` → staging service-role key
   - `STRIPE_SECRET_KEY` / `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` →
     **Stripe test-mode** keys (so test card 4242 works).
   - `STRIPE_WEBHOOK_SECRET` → from a fresh Stripe webhook pointing at
     `https://saha-git-staging-…vercel.app/api/stripe/webhook`.
   - `RESEND_API_KEY`, `TWILIO_*` → optional; can reuse prod or stub.
4. **Branch policy**: assign the `staging` env to the `staging` git branch
   in Vercel. Push to `master` still deploys to production.

### Per-deploy routine

- Open PRs against `staging` first when the diff includes a migration.
- Once staging is green and Stripe test flow works, merge `staging` into
  `master` to roll to prod.

This ticket stays Pending until the manual project + env vars exist —
purely an infra task.

---

## SAH-80: Admin TOTP enrolment + AAL2 enforcement

Code path enrolls + verifies TOTP via Supabase Auth's built-in MFA. To
finish wiring:

1. Supabase Dashboard → Authentication → Providers → Multi-factor
   Authentication → enable **TOTP**.
2. Optionally lower the AAL2 timeout (defaults to 24h — short enough for
   admins).

After that, any admin login flips through the enrolment screen on first
sign-in. The middleware refuses to serve `/admin/*` until `aal2`.

---

## SAH-79: WhatsApp OTP via Twilio Verify

Code path uses `TWILIO_VERIFY_SERVICE_SID` to send + check codes via
WhatsApp. To enable:

1. Twilio Console → Verify → Services → Create.
2. Channel: WhatsApp.
3. Copy the Service SID into `TWILIO_VERIFY_SERVICE_SID` env var on
   Vercel.

Without the env var, the phone form falls back to "save phone but show
unverified" so the rest of the platform keeps working.

---

## SAH-76: Upstash rate limiting

1. https://console.upstash.com → create a Redis database (free tier, same
   region as Vercel).
2. Copy `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN` into Vercel.
3. Wired into `loginAction`, `forgotPasswordAction`,
   `createBookingAndCheckoutAction`, review submissions. Without env vars,
   limiting is bypassed (logged once on cold start).

---

## SAH-75: Sentry + Vercel Agent

1. https://sentry.io → create project (Next.js).
2. Copy DSN into `NEXT_PUBLIC_SENTRY_DSN` (client) + `SENTRY_DSN`
   (server).
3. Optionally add `SENTRY_AUTH_TOKEN` to upload source maps from the
   Vercel build.
4. In Vercel → Project → Integrations → enable Vercel Agent for AI code
   reviews on PRs.

---

## SAH-115: Google OAuth login (still pending)

1. Google Cloud Console → create OAuth 2.0 Client ID (Web application).
2. Authorized origins: prod + dev.
3. Redirect URI: `https://<supabase-project>.supabase.co/auth/v1/callback`.
4. Supabase Dashboard → Auth → Providers → Google → paste Client ID +
   Secret + enable.

Code already lands the callback at `/[locale]/auth/callback`.

---

## SAH-50: Shared dev secrets via Vercel CLI

Both devs work off the same set of secrets without trading `.env.local`
files in Slack. Vercel is the source of truth — pull from it.

**One-time setup (per dev):**

```bash
npm i -g vercel
vercel login                    # opens browser, sign in
vercel link                     # pick the saha project
npm run env:pull                # writes .env.local from Vercel "Development" env
```

**When secrets change** (someone adds a key in Vercel dashboard): every
dev re-runs `npm run env:pull`. The script overwrites `.env.local` with
the latest values.

**Where to put new secrets:**

- Local-only test values (Stripe test keys you're experimenting with) →
  edit `.env.local` directly. They won't be overwritten until the next
  `env:pull`.
- Anything bzo or production needs → add it in
  [Vercel Settings → Environment Variables](https://vercel.com/marawans-projects-568c78f5/saha/settings/environment-variables),
  pick the right environment(s) (Development / Preview / Production),
  then everyone runs `env:pull`.

`.env.local` is gitignored — it never gets committed. Production reads
secrets directly from Vercel at runtime, no `.env.local` involved.
