# Saha

UAE-first booking platform for racket sports — Padel, Pickleball, Tennis, Squash, and Badminton. Players discover and book courts; facility owners list courts and accept Stripe Connect payouts; admins approve listings and run the platform.

- **Production**: [sahasports.vercel.app](https://sahasports.vercel.app)
- **Public REST API**: [`/api/openapi.json`](https://sahasports.vercel.app/api/openapi.json) — see [docs/API.md](docs/API.md)

## Stack

| Layer | Technology |
| --- | --- |
| Framework | Next.js 16 (App Router, React 19, TypeScript 5 strict) |
| Database | Supabase (PostgreSQL + PostGIS + Auth + Storage) |
| Styling | Tailwind CSS v4 |
| Forms | React Hook Form + Zod |
| Maps | MapLibre GL + react-map-gl (Mapbox tiles) |
| Payments | Stripe + Stripe Connect (Express, AED, 10% platform fee) |
| Email | Resend |
| Messaging | Twilio (WhatsApp confirmations + reminders + Verify OTP) |
| i18n | next-intl — English + Arabic (RTL) |
| Observability | Sentry (Next.js SDK) + Vercel Analytics |
| Auth abuse | Upstash rate-limit (sliding window, fails closed on auth paths) |
| Hosting | Vercel (Fluid Compute) |

## Local Development

### Prerequisites

- Node.js 20+
- A Supabase project (link your own for local dev)
- Vercel CLI for shared secrets: `npm i -g vercel`

### Setup

```bash
git clone https://github.com/MarawanEldeib/saha.git
cd saha
npm install

# Pull shared secrets from Vercel (replaces manual .env.local sharing — see OPS.md SAH-50)
vercel login
vercel link
npm run env:pull

npm run dev
```

Open [http://localhost:3000/en](http://localhost:3000/en) (or `/ar` for Arabic).

### Environment Variables

`npm run env:pull` writes everything from Vercel's "Development" environment into `.env.local`. The full list lives in `.env.example`. Required for the app to boot:

- `NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_ANON_KEY` / `SUPABASE_SERVICE_ROLE_KEY`
- `NEXT_PUBLIC_APP_URL` (set per environment)
- `STRIPE_SECRET_KEY` + `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` + `STRIPE_WEBHOOK_SECRET`
- `RESEND_API_KEY`
- `NEXT_PUBLIC_MAPBOX_TOKEN` (URL-restricted in Mapbox dashboard — see OPS SAH-74)

Optional but recommended in production: `TWILIO_*`, `UPSTASH_REDIS_REST_*`, `SENTRY_*`, `CRON_SECRET`.

### Database

Migrations live in `supabase/migrations/`. Run in order via the Supabase SQL Editor or `supabase db push`. Required Postgres extensions: `postgis`, `pg_trgm` (Settings → Extensions).

To make yourself an admin:

```sql
UPDATE public.profiles SET role = 'admin' WHERE id = '<your-user-uuid>';
```

## Project Structure

```text
src/
├── app/[locale]/           # All routes (en | ar prefix)
│   ├── (auth)/             # Login, register, forgot/reset password
│   ├── map/                # Court discovery map
│   ├── facilities/[id]/    # Facility detail + booking widget
│   ├── bookings/[id]/      # Player booking confirmation + QR
│   ├── events/             # Public events listing
│   ├── account/            # Player profile + wallet
│   ├── dashboard/          # Facility owner workspace
│   └── admin/              # Admin panel (separate UI from owner dashboard)
├── app/api/                # Route handlers
│   ├── stripe/             # Connect, account-session, webhook, disconnect
│   ├── cron/               # reminder-emails, mark-no-shows, review-prompts
│   ├── v1/                 # Public REST API (SAH-35)
│   └── openapi.json/       # OpenAPI 3.1 spec
├── app/llms.txt/           # llms.txt for AI agent discovery
├── components/             # Shared UI components
├── lib/                    # supabase clients, stripe, audit, rate-limit, etc.
├── i18n/                   # next-intl config + routing
├── proxy.ts                # Next.js 16 middleware (auth + CSP + locale)
└── types/database.ts       # Generated Supabase types
```

## User Roles

| Role | Access |
| --- | --- |
| `user` | Browse facilities, book courts, write reviews after a booking |
| `business` | Everything + facility/court/availability management dashboard |
| `admin` | Everything + facility approval, audit log, platform admin (TOTP-gated) |

## Docs

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — one-pager: topology, invariants, data model
- [docs/database.md](docs/database.md) — schema reference
- [docs/deployment.md](docs/deployment.md) — Vercel deploy + env var list
- [docs/API.md](docs/API.md) — public REST API usage
- [docs/MCP.md](docs/MCP.md) — hosted MCP server for Claude Desktop / Cursor / Cline
- [docs/RUNBOOK_ADMIN.md](docs/RUNBOOK_ADMIN.md) — admin SQL playbooks
- [docs/RUNBOOK_STRIPE.md](docs/RUNBOOK_STRIPE.md) — Stripe ops playbooks
- [OPS.md](OPS.md) — manual platform-config steps (Mapbox, Sentry, Twilio, Upstash, Stripe webhook, Google OAuth)
- [docs/GPT_ACTION.md](docs/GPT_ACTION.md) — how to publish the Custom GPT against this API
- [PROJECT_REPORT.md](PROJECT_REPORT.md) — long-form project overview (point-in-time)
- [docs/SAHA-ARCHITECTURE-REVIEW.md](docs/SAHA-ARCHITECTURE-REVIEW.md) — security/engineering review (point-in-time)

## Task Tracking

All work is tracked in [Linear](https://linear.app/saha-platform). Tickets use the `SAH-N` prefix and show up in commits and PR titles.
