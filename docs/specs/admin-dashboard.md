# Spec: Internal admin dashboard (Tablekit-staff)

**Status:** shipped (2026-04-28) — CSV export + recharts sparklines deferred (see Out of scope)
**Depends on:** `auth.md`, `bookings.md`, `messaging.md`, `payments.md`, `reporting.md` (operator-facing — distinct surface)

## What we're building

A founder-only dashboard for business-wide health: MRR, signups, active venues, bookings volume, messaging volume, ops health, and venue search. Cross-organisation by design — every other surface in the app is per-org with RLS; this is the deliberate exception and lives behind a hard auth gate.

This is **not** the operator-facing reporting (`reporting.md`), which is per-venue and ships today.

## Decisions

- **Auth gate:** env email allowlist (`ADMIN_EMAILS`, comma-separated). Solo-founder appropriate; replace with a `platform_admins` table if/when there's a second staff member.
- **MRR source:** live Stripe API call, in-memory cached 5 min. No `subscriptions` table in v1 — defer that schema work until billing actually ships.
- **Charts:** `recharts`, code-split per route so operator pages don't pay for the bundle.

## Surfaces

Route group `app/(admin)/admin/...` — sibling to `(dashboard)`, `(marketing)`, `(widget)`.

| Page | Purpose |
|---|---|
| `/admin` | Overview — KPI tiles + headline trends |
| `/admin/venues` | Org/venue search + activity scoring |
| `/admin/venues/[orgId]` | Single-org drill-down (metrics + audit log + Stripe status) |
| `/admin/financials` | MRR, churn, subscription mix, Stripe Connect funnel |
| `/admin/operations` | Message delivery health, payment failures, DSARs, webhook health |
| `/admin/feature-adoption` | % orgs using deposits / waitlist / multi-venue / reviews / Connect / ≥1 staff |
| `/admin/audit` | Streamed platform-wide audit feed with filters |

Layout has a distinct red/orange "ADMIN" pill in the top bar so it's never confused with an operator view.

## Auth gate (defense in depth)

- New `lib/admin/auth.ts` exposing `requirePlatformAdmin()`.
- `proxy.ts` extended to gate `/admin/*` at the edge against `process.env.ADMIN_EMAILS`.
- Every `(admin)` server component / action also calls `requirePlatformAdmin()` — belt and braces.
- Every admin login writes `platform_admin.login` to the audit log via `adminDb()`.
- All `(admin)` queries use the existing `adminDb()` (service role, RLS bypass) from `lib/server/admin/db.ts`. The `(admin)` directory is added to the existing `adminDb` import allowlist enforced by `code-reviewer`.

## Metrics

### Overview (the headline)

- **MRR** — today vs 7d ago (live Stripe).
- **Active subscriptions by tier** — free / core / plus.
- **Net new MRR (last 30d)**.
- **Trial → paid conversion rate (last 90d)** — placeholder until trial state lands.
- **Total signups** — today / 7d / 30d, sparkline.
- **Active venues last 7d** — venues with ≥1 confirmed booking.
- **Bookings volume** — today / 7d / 30d, source mix.
- **Messages volume** — email + SMS, last 7d, delivered/failed split.
- **Activation funnel (30d cohort)** — signed up → first venue → first service → first booking → first paid booking. Single best diagnostic for "is onboarding working?".

### Venues page

- Search by org name / slug / venue name / owner email hash / Stripe customer id.
- Results columns: org, plan, venue count, owner email, MRR contribution, last booking, last login, **activity score**.
- **Activity score (0–100)** — weighted from recent bookings + recent logins + recent messages over 14d. At-risk = <30. Cheap to compute, high signal.
- Drill-down: KPIs (bookings 30d, messages 30d, payments 30d), venue list, member list, last 50 audit events, Stripe Connect status, live Stripe subscription, open DSARs, feature flags.

### Financials

- MRR over time (12 weeks).
- **Net new / churned / expansion / contraction MRR** — the four levers; far more useful than total MRR alone.
- Subscription tier mix.
- **Trial cohorts** — trials started 30/60/90 days ago, % converted / still trialing / churned (placeholder until trial state lands).
- **Stripe Connect onboarding funnel** — acct created → details submitted → charges enabled → payouts enabled. Counts at each stage. Backed by `stripe_accounts.{detailsSubmitted,chargesEnabled,payoutsEnabled}`.
- Top 10 orgs by MRR.
- Top 10 orgs by booking volume.

### Operations

- **Message delivery health** — counts by `messages.channel` × `status` last 7d. Bounce rate (Resend) and failure rate (Twilio) with thresholds.
- **Payment failure feed** — `payments.status ∈ (failed, requires_payment_method)` last 7d, grouped by org. Often correlates with a stuck deposit rule.
- **Stripe webhook health** — `stripe_events` count last 24h, last received timestamp per type.
- **Open DSARs** — count, days-to-due histogram, overdue count from `dsar_requests.dueAt`.

### Feature adoption (12-week trend each)

- % orgs with ≥1 deposit rule
- % orgs with ≥1 waitlist entry
- % orgs with ≥2 venues (multi-venue)
- % orgs with reviews ingested
- % orgs that completed Stripe Connect (`payoutsEnabled`)
- % orgs that ever sent a message
- % orgs with ≥1 staff member beyond owner
- **Booking source mix at platform level** — host vs widget vs walk-in (and rwg/api when those land).
- **Venue type mix** — cafe / restaurant / bar_pub.
- **Geographic distribution** — derived from `venues.timezone` / `locale`.

### Audit feed

- Streamed list of last 200 platform-wide events from `audit_log`.
- Filter by action prefix (`auth.*`, `venue.*`, `booking.*`, `stripe.*`, `reviews.*`, `gdpr.*`, `platform_admin.*`).
- Filter by org. Click-through to actor or target.

## Technical approach

- All cross-org SQL is single GROUP BY on already-indexed columns (`bookings_org_start_idx`, `messages_org_booking_idx`, `audit_log_org_created_idx`). Sub-second at year-1 scale.
- **Stripe live-pull** is the slow path: 5-min in-memory cache, page renders cached value with "last refreshed at HH:MM" footer. **Degrades gracefully** — Stripe API failure shows last cached value + warning banner, never errors the page.
- Day buckets in UTC (or Europe/London — pick one). New `lib/admin/filter.ts` is a UTC-fixed sibling of `lib/reports/filter.ts`.
- CSV export reuses generic `lib/reports/csv.ts` (RFC 4180 + UTF-8 BOM + formula-injection guard) — no fork.
- `recharts` code-split per route via dynamic import; verified in DevTools network tab on operator pages.

## Data backing (gap analysis)

**Already in schema** — reusable as-is:

- `organisations`, `users`, `memberships` → signups, tier mix (via `plan` text), staff counts.
- `venues` → counts, type mix, geo (timezone/locale).
- `bookings` → volume, source mix, no-show, status timeline.
- `messages` → delivery health, channel mix.
- `payments` → failure feed, deposit revenue.
- `audit_log` → activity score inputs, audit feed.
- `waitlists`, `reviews`, `stripe_accounts`, `stripe_events`, `dsar_requests` → adoption + ops feeds.

**Live-pulled from Stripe** (cached 5 min):

- Active subscriptions, tier (`price.lookup_key`), MRR / churn / expansion, trial state.

**Not backed yet** — explicit v2 schema work, NOT in v1 scope:

- `subscriptions` table mirroring Stripe (would let us drop the live pull and unlock cohort analysis).
- `organisations.trial_started_at` / `trial_ends_at`.
- Twilio/Resend per-message cost columns on `messages`.

## Surfaces (file paths)

- `app/(admin)/layout.tsx` — admin chrome with the "ADMIN" pill.
- `app/(admin)/admin/page.tsx` — overview.
- `app/(admin)/admin/venues/page.tsx`, `.../[orgId]/page.tsx` — search + drill-down.
- `app/(admin)/admin/financials/page.tsx` — MRR, churn, Connect funnel.
- `app/(admin)/admin/operations/page.tsx` — message + payment + webhook + DSAR health.
- `app/(admin)/admin/feature-adoption/page.tsx` — % adoption per feature.
- `app/(admin)/admin/audit/page.tsx` — audit feed.
- `lib/server/admin/auth.ts` — `requirePlatformAdmin()`.
- `lib/server/admin/allowlist.ts` — pure `ADMIN_EMAILS` parser shared with proxy (no `server-only` import).
- `lib/server/admin/dashboard/audit.ts` — platform audit writer (separate from org-scoped `lib/server/admin/audit.ts`).
- `lib/server/admin/dashboard/metrics/{signups,bookings,messages,activation-funnel,feature-adoption,activity-score,top-orgs,connect-funnel,venues-search,operations,platform-audit}.ts` — typed query functions; signature `(db: AdminDb, bounds: Bounds) => Promise<T>`.
- `lib/server/admin/dashboard/stripe-billing.ts` — live Stripe MRR + sub mix with 5-min cache + degraded fallback.
- `lib/server/admin/dashboard/filter.ts` — UTC-fixed sibling of `lib/reports/filter.ts`.
- `lib/server/admin/dashboard/csv.ts` — re-exports `lib/reports/csv.ts` so admin paths don't reach across into operator code.
- `proxy.ts` (extend) — edge gate for `/admin/*`.
- `tests/integration/admin-auth.test.ts` — non-allowlisted email is rejected (defense in depth verified at both proxy and server-component layers).
- `tests/integration/admin-metrics.test.ts` — seeded queries return expected shape.

## Acceptance criteria

- [ ] `/admin/*` unreachable for any user not in `ADMIN_EMAILS` (integration test).
- [ ] Allowlist enforced in proxy **and** in every `(admin)` server component.
- [ ] Every admin login records `platform_admin.login` in audit log via `adminDb()`.
- [ ] Overview loads in <1s at 10k bookings / 1k orgs (Stripe cache hit).
- [ ] Stripe API failure does not break the dashboard — financials degrade to last cached value + warning banner.
- [ ] All queries use `adminDb()`; no operator-RLS leakage from admin pages into operator pages (verified by integration test seeded with two orgs).
- [ ] CSV export for: signups, venues list, bookings volume, messages volume, financials snapshot.
- [ ] `recharts` code-split — operator pages don't load it (verified in DevTools network tab).

## Out of scope (future work)

- **CSV export per metric** — generic `lib/server/admin/dashboard/csv.ts` re-export is in the codebase but no `/admin/export/[metric]/route.ts` is wired yet. Drop in when the founder wants to share data outside the dashboard.
- **Recharts sparklines on overview** — recharts not installed yet. Tables-only suffices for year-1 volumes; add when the page feels too dense for at-a-glance trends.
- **Per-org MRR contribution** — pending confirmation of `organisations.stripe_customer_id` semantics (Connect customer vs billing customer). Add `stripe_billing_customer_id` if needed.
- **`subscriptions` table + Stripe webhook sync** — promote when live-pull becomes a bottleneck or cohort analysis is needed.
- **Trial state columns** on `organisations` — needed for real trial-conversion metrics.
- **Cohort retention by signup month** — needs a denormalised cohort table to be cheap.
- **SMS/Email cost-margin tracking** — needs Twilio/Resend cost columns on `messages`.
- **`platform_audit_log` events surfaced in the audit feed** — currently only `audit_log` (org-scoped) is shown. Add a "Platform admin actions" section once we have more than `login` / `viewed_org` / `searched` events.
- **Impersonation / "view as operator"** — significant security surface; defer.
- **Manual subscription / refund actions** — do those in Stripe directly today; no admin write surface in v1.
- **Push alerts / email digests** — pull-only dashboard for v1.
- **Multi-staff platform-admin management UI** — env allowlist suffices until there's a second staff member.
