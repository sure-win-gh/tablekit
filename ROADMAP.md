# Multi-region roadmap — what's remaining

**Status 2026-07-04:** Phases 0–2 landed on `main` (commits
`01dd710..c729d43`), CI green, staging deployed with migrations 0053/0054
applied. Companion to `docs/specs/multi-region.md` (the spec — decisions
and invariants live there; this file is the working checklist).
Tick items off as they land and delete this file when Phase 4 ships.

## 0. Remaining verification before promoting to production

- [x] Full gate `pnpm typecheck && pnpm lint && pnpm test` — covered by CI
      on the push to main (green 2026-07-04).
- [x] Migrations 0053 + 0054 applied to staging (Vercel build step on push).
- [ ] Run the integration suite against a real DB (`pnpm test:integration`)
      — the `stripe_events` (entity, id) round-trip lives there.
- [ ] `pnpm check:rls` against staging (CI only runs it if the
      `DATABASE_URL` secret is wired — confirm it actually ran).
- [ ] Send a Stripe test event at staging `/api/stripe/webhook`: expect 200
      and a `stripe_events` row with `entity='uk'`.
- [ ] Before TAGGING for prod: check `stripe_events` row count — 0054's PK
      swap takes ACCESS EXCLUSIVE while it rebuilds (fine at small volume;
      deploy.md's <10s rule). Skip if staging and prod share the database
      (already applied in that case).

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

**Status 2026-07-15:** signup capture slice landed — the org now records its
region/entity at creation and is written to its own regional pool, gated dark
for US. The request-time routing (control-plane map + per-request region on
existing call sites) is deferred: it is only _exercised_ once a US DB exists,
and every org is `eu` until then. See the two open boxes below.

- [x] Country selector on `/signup` — explicit choice decides (D1); edge geo
      (`visitorCountry()` in `lib/geo/visitor-region.ts`) pre-selects only.
      `app/(marketing)/signup/{page,form}.tsx`.
- [x] Wire `regionForCountry()` into signup: writes `region` +
      `billing_entity` on the new org row. `app/(marketing)/signup/actions.ts`.
- [x] Gate the US option on `regionEnabled("us")` — the form hides the US
      `<option>` and the server `resolveSignupRegion()` **clamps** a US post to
      eu/uk when the gate is closed (fail closed; `captureMessage` on clamp).
- [x] Create the org in the correct regional DB — insert now goes through
      `adminDb(region)`. Resolves to EU today (region is clamped), flips to the
      US project with no code change once `REGION_US_ENABLED` is true.
- [ ] Control-plane routing map (D5): org/venue → region lookup in the EU
      project; widget/public/API paths resolve venue → region before
      querying. **Deferred — Phase 4 prerequisite (unreachable while US dark).**
- [ ] Region-aware `withUser`/`anonymous`/`adminDb` call sites: resolve the
      session org's / venue's region once per request and pass it through.
      **Deferred — includes the signup `audit.log` write, which still targets
      the default (EU) pool; correct today, must follow the org's region once
      US orgs can exist (cross-region FK otherwise).**
- [x] Tests: `resolveSignupRegion()` clamp — US open→us/us, US closed→eu/uk,
      non-US always eu/uk, case/whitespace — in `tests/unit/regions.test.ts`
      (20 passing).

## 3. Phase 4 — US bring-up (code; blocked on external gates below)

- [ ] New Supabase project (US region): run full migration set,
      `pnpm check:rls` against it, set `DATABASE_URL_US`.
- [ ] Drop the transitional `stripe_events_id_key` UNIQUE constraint
      (added in 0054) BEFORE the US Stripe account sends its first event.
- [ ] Decide + implement US-entity `stripe_events` residency: US regional DB,
      or document as EU-resident control-plane data in `gdpr.md`.
- [ ] Per-region master keys: `TABLEKIT_MASTER_KEY_EU`/`_US` (a US key must
      never decrypt EU PII). Extend `lib/security/crypto.ts` accordingly.
- [ ] Thread entity through `lib/payments/*` (deposits — connected accounts
      are entity-tied); Phase 2 left it on the `uk` default.
- [ ] Same for `lib/server/admin/dashboard/stripe-billing.ts` — the MRR
      pull must iterate BOTH accounts.
- [ ] Widget deposit form publishable key:
      `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY_UK`/`_US` picked by venue entity.
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

- [x] Declare the three CHECK constraints (`organisations_region_check`,
      `organisations_billing_entity_check`, `stripe_events_entity_check`)
      via drizzle `check()` in `schema.ts` so snapshots match the DB and a
      future generate can't collide with the hand-written SQL. Migration
      0055 is a guarded, idempotent no-op (DDL already ran in 0053/0054);
      it exists only to advance the snapshot. Done 2026-07-04.
- [x] Update the stale "import ONLY from `lib/server/admin/**`" comment in
      `lib/server/admin/db.ts` — reworded to state the real invariant
      (server-only, RLS-bypass, caller owns tenant scoping). Done 2026-07-04.
- [x] Drop the raw `cause` from `WebhookSignatureError` — constructor now
      takes a fixed developer-authored `reason` string only, so chaining the
      raw payload-carrying Stripe error is structurally impossible. gdpr.md
      §Logs. Done 2026-07-04.
- [ ] `lib/sms/send.ts` still attaches raw provider errors (pre-existing,
      already noted in gdpr.md:148) — harden when next touched. (Same class
      as the `WebhookSignatureError` fix above; left per "when next touched".)
- [x] Have `ensureCustomer` return `{ customerId, entity }` so checkout/
      top-up stop hitting the DB twice per call — entity asserted on every
      path (fail closed). Done 2026-07-04.
