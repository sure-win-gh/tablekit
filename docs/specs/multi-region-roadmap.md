# Multi-region roadmap — what's remaining

**Status after 2026-07-03:** Phases 0–2 landed (commits `01dd710..c729d43`).
Everything below is outstanding. Companion to `multi-region.md` (the spec —
decisions and invariants live there; this file is the working checklist).
Tick items off as they land and delete this file when Phase 4 ships.

## 0. Before pushing / deploying Phases 0–2

- [ ] Run the full local gate: `pnpm typecheck && pnpm lint && pnpm test`
      (sandbox verification covered all 87 unit/security files + scoped
      typecheck/lint, but not the full one-shot run).
- [ ] Run the integration suite against a local DB (`pnpm test:integration`)
      — the `stripe_events` (entity, id) round-trip is covered there.
- [ ] Apply migrations 0053 + 0054 to staging (`pnpm db:migrate`), then
      `pnpm check:rls`.
- [ ] Check `stripe_events` row count before running 0054 in prod — the PK
      swap takes ACCESS EXCLUSIVE while it rebuilds the index (fine at small
      volume; note deploy.md's <10s rule).

## 1. Stripe webhook cutover (any time after deploy, low risk)

- [ ] In the Stripe dashboard, repoint the EXISTING webhook endpoint from
      `/api/stripe/webhook` to `/api/stripe/webhook/uk` (same endpoint, same
      `whsec_` — do NOT create a second endpoint with a new secret while
      both routes are live).
- [ ] If/when setting `STRIPE_WEBHOOK_SECRET_UK`: it takes precedence the
      moment it exists, so it must equal the legacy secret until the old
      endpoint is deleted.
- [ ] After a real event is observed arriving at `/uk`: delete
      `app/api/stripe/webhook/route.ts` (the legacy alias).

## 2. Phase 3 — signup + region capture (code; can start any time)

- [ ] Country selector on `/signup` — explicit choice decides (D1); edge geo
      headers (`lib/geo/visitor-region.ts` pattern) may pre-select only.
- [ ] Wire `regionForCountry()` into signup: write `region` +
      `billing_entity` on the new org row.
- [ ] Gate the US option on `regionEnabled("us")` (lib/regions/config.ts) —
      currently nothing calls it; this is the launch-gate enforcement point.
- [ ] Create the org in the correct regional DB (signup currently writes via
      `adminDb()` default-EU — fine until `REGION_US_ENABLED` flips, but the
      routing must exist before it does).
- [ ] Control-plane routing map (D5): org/venue → region lookup in the EU
      project; widget/public/API paths resolve venue → region before
      querying.
- [ ] Region-aware `withUser`/`anonymous`/`adminDb` call sites: resolve the
      session org's / venue's region once per request and pass it through.
- [ ] Tests: signup writes the right pair for US vs non-US; US option hidden
      while `regionEnabled("us")` is false.

## 3. Phase 4 — US bring-up (code; blocked on external gates below)

- [ ] New Supabase project (US region): run full migration set,
      `pnpm check:rls` against it, set `DATABASE_URL_US`.
- [ ] Drop the transitional `stripe_events_id_key` UNIQUE constraint
      (added in 0054) BEFORE the US Stripe account sends its first event.
- [ ] Decide + implement US-entity `stripe_events` residency: US regional DB,
      or document as EU-resident control-plane data in `gdpr.md`.
- [ ] Per-region master keys: `TABLEKIT_MASTER_KEY_EU`/`_US` (a US key must
      never decrypt EU PII). Extend `lib/security/crypto.ts` accordingly.
- [ ] Thread entity through the paths Phase 2 left on the `uk` default:
      - `lib/payments/*` (deposits — connected accounts are entity-tied)
      - `lib/server/admin/dashboard/stripe-billing.ts` (MRR must iterate
        BOTH accounts)
      - widget deposit form publishable key:
        `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY_UK`/`_US` picked by venue entity
- [ ] Cron fan-out: every job in `vercel.json` that touches tenant data runs
      per region (or iterates both pools).
- [ ] US Stripe account config: products/prices (USD, points TBD), usage
      Meter, webhook endpoint → `/api/stripe/webhook/us` + all `_US` envs.
- [ ] Stripe Tax enabled on the US account (registrations are gate E2).
- [ ] AI enquiries: US-pinned Bedrock invocation path for US tenants, or
      withhold the feature in US at launch (rule 8 in gdpr.md — sub-processor
      -equivalent change either way).
- [ ] Observability posture: Sentry (EU-pinned — scrub suffices? dual
      project?), Upstash/Resend/Twilio per-region review; extend
      `platform_audit_log` with region for admin access to US data.
- [ ] `gdpr.md` sub-processor table + `/legal/sub-processors` page: Supabase
      US project row; Stripe Inc. as the US entity's processor (30-day
      notice mechanics). Launch gate, not follow-up.
- [ ] Integration tests: EU org unreachable via US pool and vice versa (per
      tenant-data table, both directions); wrong-entity key fails closed
      end-to-end.
- [ ] Flip `REGION_US_ENABLED` only when every box above + both external
      gates are green.

## 4. External launch gates (Ben, in parallel — not code)

- [ ] **E1:** US legal entity (LLC) formed; US Stripe account opened; USD
      price points for Core/Plus decided; intra-group data transfer
      agreement between UK and US entities executed.
- [ ] **E2:** US sales-tax registrations (state-by-state economic nexus;
      Stripe Tax calculates/files but the entity must register).

## 5. Deferred hygiene (non-blocking, from the review pass)

- [ ] Declare the three CHECK constraints (`organisations_region_check`,
      `organisations_billing_entity_check`, `stripe_events_entity_check`)
      via drizzle `check()` in `schema.ts` so snapshots match the DB and a
      future generate can't collide with the hand-written SQL.
- [ ] Update the stale "import ONLY from lib/server/admin/**" comment in
      `lib/server/admin/db.ts` to name the actually-sanctioned callers
      (`lib/billing/*` etc.).
- [ ] Drop the raw `cause` from `WebhookSignatureError` (pre-existing;
      Stripe's error object carries the raw payload — contradicts gdpr.md
      §Logs "no error chaining").
- [ ] `lib/sms/send.ts` still attaches raw provider errors (pre-existing,
      already noted in gdpr.md:148) — harden when next touched.
- [ ] Optional: have `ensureCustomer` return `{ customerId, entity }` so
      checkout/top-up stop hitting the DB twice per call.
