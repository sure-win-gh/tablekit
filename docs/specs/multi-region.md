# Spec: Multi-region data residency + two-entity billing

**Status:** in progress (Phases 0–2 approved; Phases 3–4 gated — see Launch gates)
**Owner:** Ben
**Depends on:** `stripe-billing.md`, `payments-deposits.md`, `docs/playbooks/gdpr.md`

## Summary

Evolve Tablekit from single-region (UK/EU) single-entity (UK) into:

1. **Application layer — one codebase.** One Next.js deployment serves every
   customer. No per-region forks of the app. Ever.
2. **Data layer — region-pinned multi-tenancy.** Each organisation's data lives
   and is processed in exactly one data region: `eu` (Supabase London, the
   existing project) or `us` (a new Supabase US project). Same schema, same
   migrations, same RLS in both.
3. **Billing layer — two legal entities.** US customers contract with and pay
   the US entity via its own Stripe account (USD). Everyone else contracts
   with the UK entity via the existing Stripe account (GBP). The entity also
   books the revenue — this is a legal/accounting boundary, not just a
   payments routing detail.

## Approved decisions (locked 2026-07-03)

| # | Decision | Answer |
|---|----------|--------|
| D1 | Region detection | Explicit country selector at signup. Edge geo headers may **pre-select** the option only — they never decide. Country → `{region, entity}` via one pure, unit-tested function (`lib/regions.ts`). |
| D2 | Rest-of-world default | Everything non-US → UK entity / EU region. (Australia and all other territories included.) |
| D3 | Existing customers | All current orgs grandfathered as `region='eu'`, `billing_entity='uk'`, backfilled as a **constant** in the migration. No IP-based re-detection, no reassignment, no data movement. (No US customers exist — pre-launch.) |
| D4 | Auth topology | Single global Supabase Auth project, co-located with the EU project, for v1. A US user's auth record living in the EU is acceptable: GDPR restricts EU data leaving the EEA; no US law requires US-person data to stay in the US. Avoids the per-region email-uniqueness / password-reset split. |
| D5 | Routing directory | The EU project is the control plane. It holds global auth and the org → region map. A regional DB is never queried until the control plane has resolved the region. |
| D6 | US entity | **Does not exist yet** (no LLC, no US Stripe account). USD price points for Core/Plus TBD. Blocks Phase 4 — see Launch gates. |
| D7 | Region mobility | Region is per-**organisation**, set once at signup, effectively immutable. A multi-venue org cannot straddle regions. Region change = documented support-driven migration (export → re-encrypt under the target region's DEK chain → cancel/recreate the subscription on the other entity; Stripe customers/subscriptions cannot move between accounts). Never a flag flip. |
| D8 | Compute | Single EU Vercel compute region for v1. EU customers' data never leaves the EEA (no transfer question). US data transiting EU compute needs no GDPR safeguard in that direction — documented in `gdpr.md`. Multi-region compute is a later latency decision, not a compliance one. |

## Vocabulary

- **Region** (`Region = "eu" | "us"`) — where an org's *data* lives. Column:
  `organisations.region`.
- **Billing entity** (`BillingEntity = "uk" | "us"`) — which legal entity the
  org *contracts with*, and therefore which Stripe account it lives on.
  Column: `organisations.billing_entity`.
- The two are set together at signup by `regionForCountry()` and never
  diverge in v1 (`eu`↔`uk`, `us`↔`us`), but they are **separate columns**
  because they answer different questions (residency vs. contract/revenue).

## Phases

### Phase 0 — this spec + `gdpr.md` update. *(done with this PR)*

### Phase 1 — region in the data model (zero behaviour change)

- Migration: `organisations.region text NOT NULL DEFAULT 'eu'` and
  `organisations.billing_entity text NOT NULL DEFAULT 'uk'`, both with CHECK
  constraints. Backfill = the defaults (D3).
- `lib/regions.ts`: the single source for region/entity types, the pure
  `regionForCountry(iso2)` mapping (D1/D2), and env-based config accessors.
  `DATABASE_URL_EU` falls back to `DATABASE_URL` so nothing breaks mid-rollout;
  `DATABASE_URL_US` is unset until Phase 4.
- `lib/db/client.ts`: pool becomes a region-keyed registry. Every existing
  caller resolves to `eu`. Behaviour is bit-for-bit identical today.

### Phase 2 — Stripe multi-entity plumbing (aliased to UK, zero behaviour change)

- `stripe(entity)` factory. `STRIPE_SECRET_KEY_UK` falls back to
  `STRIPE_SECRET_KEY`; `_US` unset until Phase 4. Same alias pattern for the
  publishable key, webhook secrets, and price ids
  (`STRIPE_PRICE_{CORE,PLUS,USAGE}_{UK,US}`).
- Per-entity webhook routes: `/api/stripe/webhook/uk` and
  `/api/stripe/webhook/us`. The legacy `/api/stripe/webhook` stays live as the
  UK alias until the Stripe dashboard endpoint is repointed and verified.
- `stripe_events` gains an `entity` column (default `'uk'`) — `evt_*` ids are
  only unique **per Stripe account**; the PK assumption breaks with two
  accounts. Dedup key becomes `(entity, id)`.
- Currency comes from the entity (`uk`→GBP, `us`→USD) — kills the hardcoded
  `"gbp"` in `lib/billing/topup.ts`.
- `billing_entity` threaded through `lib/billing/*` and `lib/stripe/connect.ts`
  via `entityForOrg(orgId)`. Deposits (Connect) accounts are created under the
  org's entity's platform account.

### Phase 3 — signup + region capture *(HELD — do not start)*

- Country selector on `/signup` (geo headers pre-select only).
- Signup creates the org in the correct regional DB, writes
  `region`/`billing_entity`, registers the org in the control-plane routing
  map. Widget/public/API paths resolve venue → region before querying.

### Phase 4 — US bring-up *(HELD — gated below)*

- New Supabase US project; full migration set + `pnpm check:rls` against it.
- Thread entity through the code paths Phase 2 deliberately left on the
  `uk` default (safe while every org is uk): `lib/payments/*` (deposits act
  on connected accounts, which are entity-tied), the admin dashboard's live
  Stripe MRR pull (`lib/server/admin/dashboard/stripe-billing.ts` must
  iterate BOTH accounts), and the widget deposit form's publishable key
  (`NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY_UK`/`_US` picked by venue entity).
- Per-region `TABLEKIT_MASTER_KEY_{EU,US}` (a US key never decrypts EU PII).
- Cron fan-out over both regions; Bedrock pinned to a US region for US
  tenants' enquiries (or the AI enquiry feature withheld in US at launch);
  Sentry/Upstash/Resend/Twilio per-region posture reviewed.
- Feature flag `REGION_US_ENABLED` — the US signup path stays dark until every
  launch gate is green.

## Launch gates (external, run in parallel — NOT code tasks)

These gate `REGION_US_ENABLED`, not the codebase:

1. **US entity + Stripe account.** No LLC exists yet. Entity formation, US
   Stripe account, USD Core/Plus prices, and the intra-group data transfer
   agreement between the two entities all block Phase 4. Owner: Ben.
2. **US sales tax registrations.** State-by-state: economic-nexus thresholds
   and SaaS taxability both vary per state. Stripe Tax calculates/files, but
   the US entity must register in each state where it hits nexus. Owner: Ben
   (handled separately from the code work).

## Invariants (enforced by tests)

- An EU org's rows are unreachable through the US pool and vice versa
  (integration test, both directions, per table with tenant data).
- A wrong-entity Stripe key fails closed (`StripeNotConfiguredError`), never
  falls back to the other entity's key.
- `regionForCountry()` is total: every ISO-3166-1 alpha-2 input maps to
  exactly one `{region, entity}`; `US` → `{us, us}`; everything else →
  `{eu, uk}` (D2).
- Existing-customer flows (billing, deposits, webhooks) are unchanged while
  everything is aliased: with only the legacy env names set, behaviour is
  identical to pre-Phase-1.
- No Stripe key, webhook secret, price id, or DB URL appears in code — env
  only, documented in `.env.local.example` with placeholders.

## Out of scope (v1)

Per-venue regions; self-serve region change; multi-region Vercel compute;
moving existing Stripe customers/subscriptions between accounts; EU↔US
cross-region reporting aggregation (revisit with pseudonymisation when needed).
