# Implementation plan: POS integrations

**Spec:** [`pos-integrations.md`](pos-integrations.md) — source of truth. This file is the build plan.
**Status:** ready to build
**Founder decisions baked in (2026-06-11):**
1. **Cron topology:** dedicated `pos-backfill` + `pos-retention` cron routes (mirroring `enquiry-retention`/`campaign-retention`), matching the repo's actual one-route-per-concern pattern — **not** a single nightly aggregator (the spec's original assumption was wrong; the repo already runs ~12 separate cron routes).
2. **Guest matching:** hash-match + booking-link + manual-attach all ship in **v1**.
3. **Line items:** Art. 9 gating columns (`line_items_enabled`, `art9_basis_confirmed_at`) added to `pos_connections` in the **first migration**; ingest stays off until a venue opts in.
4. Plan written to this file; spec reconciled to match.

## Repo grounding (precedents to mirror — do not invent paths)

- **OAuth connection + encrypted-token upsert:** `lib/db/schema.ts` `venueOauthConnections` (~L689) + `app/api/oauth/google/{start,callback}/route.ts`. `pos_connections` and the Square/Lightspeed connect flows clone these.
- **Inbound webhook (verify → idempotency → plan-gate → audit):** `app/api/webhooks/resend-inbound/route.ts` + the `inbound_webhook_events` table (~L1672). The POS webhook routes mirror this exactly.
- **RLS + org-id-enforcing trigger:** `drizzle/migrations/0048_greedy_george_stacy.sql` (`enforce_venue_photos_org_id`). The hand-edit template for our four triggers + four RLS policies.
- **Crypto:** `lib/security/crypto.ts` — `encryptPii` / `decryptPii` / `hashForLookup(value, "email"|"phone")` / `constantTimeEqual`. The POS match path calls the **same** `hashForLookup` that `lib/guests/upsert.ts` uses to populate `guests.email_hash`.
- **DSAR single-transaction scrub:** `lib/dsar/scrub.ts` — extended in Commit 8.
- **Outbound HMAC signing to invert for the generic inbound path:** `lib/webhooks/sign.ts` (`verifySignature` is already exported for inbound use).
- **Crash-resumable runner:** `lib/import/runner/` — reused by CSV import + backfill.

## Commit sequence

Conventional commits, one concern each (CLAUDE.md rule 9). Test ships with each.

### 1 — `feat(pos): schema + RLS + org-id triggers`
The single Drizzle migration (§"Migration" below). `lib/db/schema.ts` gains `posConnections`, `posWebhookEvents`, `posOrders`, `guestSpendSummary`, a `posProvider` enum (`square`|`lightspeed_k`|`generic`), the two Art. 9 gating columns on `posConnections` (`lineItemsEnabled boolean default false`, `art9BasisConfirmedAt timestamptz`), and nullable `organisations.posRetentionMonths`.
**Test:** `tests/integration/rls-pos-orders.test.ts` (+ per-venue sibling) — cross-tenant read denial on all four tables, trigger org-id rewrite, deny-by-default writes, venue-scoped manager isolation. Mirror `rls-guests*.test.ts`.

### 2 — `feat(pos): token + secret crypto helper`
`lib/pos/connection.ts` — create/upsert a `pos_connections` row encrypting `access_token_cipher`/`refresh_token_cipher`/`webhook_secret_cipher` via `encryptPii`; read+decrypt for use. `adminDb()` writes.
**Test:** `tests/integration/pos-connection-crypto.test.ts` — round-trip; assert no plaintext token in stored columns.

### 3 — `feat(pos): ingest core — normalise + PAN guard + match + rollup`
- `lib/pos/types.ts` — `NormalisedOrder`.
- `lib/pos/pan-guard.ts` — drop any PAN-shaped field (Luhn + 13–19 digits) pre-persistence; never log the raw value.
- `lib/pos/match.ts` — (1) `hashForLookup(value,"email"|"phone")` → `guests.email_hash`/`phone_hash` in org; (2) **booking-link** — map the POS table/check reference to a `bookings` row at the same venue + service window → `bookings.guest_id`; (3) else null. Honours `organisations.group_crm_enabled` for org-wide vs venue-scoped. Records `match_method`.
- `lib/pos/rollup.ts` — recompute `guest_spend_summary` for the affected guest; full-rebuild export for the rebuild test.
- `lib/pos/ingest.ts` — PAN-guard → upsert `pos_orders` on `(connection_id, external_order_id)` → match → rollup → `audit.log('pos.order.ingested', {non-PII})`.
**Tests:** `pos-pan-guard.test.ts` (PAN dropped, never persisted/logged — PCI SAQ-A); `pos-match-identity.test.ts` (POS-side hash **byte-identical** to guest-side; order links on same email); `pos-match-booking.test.ts` (table/check ref links to the right cover within the service window); `pos-rollup.test.ts` (recompute on upsert + rebuildable from `pos_orders` alone).

### 4 — `feat(pos): square ingest (OAuth + webhook)`
- `app/api/oauth/square/{start,callback}/route.ts` — clone Google flow (signed state + CSRF cookie + `requireRole("manager")` + `assertVenueVisible` + Plus-tier gate), read-only scopes `PAYMENTS_READ ORDERS_READ MERCHANT_PROFILE_READ CUSTOMERS_READ`.
- `lib/pos/square/verify.ts` — HMAC-SHA256 over `notificationURL + rawBody`, `constantTimeEqual`, header `x-square-hmacsha256-signature`.
- `lib/pos/square/normalise.ts` — `payment.updated`(COMPLETED) + parent order → `NormalisedOrder`.
- `app/api/webhooks/pos/square/route.ts` — verify → dedupe via `pos_webhook_events (provider, external_event_id)` `ON CONFLICT DO NOTHING` → `lib/pos/ingest.ts`. Bad sig → 400; duplicate → 200 no-op.
**Test:** `pos-webhook-square.test.ts` — valid ingests; forged → 400; **replay is a no-op**.

### 5 — `feat(pos): lightspeed ingest behind partner flag`
- `app/api/oauth/lightspeed/{start,callback}/route.ts` — same shape, gated behind `LIGHTSPEED_PARTNER_ENABLED` (partner approval is a go-live blocker).
- `lib/pos/lightspeed/{verify,normalise}.ts` — `Account: CLOSED`/`CHECK_WAS_UPDATED`/`Payment: SUCCESS`; secret from `webhook_secret_cipher`.
- `app/api/webhooks/pos/lightspeed/route.ts`.
**Test:** `pos-webhook-lightspeed.test.ts` — verify + CLOSED-check ingest; flag-off → disabled.

### 6 — `feat(pos): generic signed webhook + CSV importer`
- `app/api/pos/ingest/route.ts` — per-connection secret, verify `X-TableKit-POS-Signature: sha256=<hmac(secret, body)>` via `verifySignature` from `lib/webhooks/sign.ts`. Plus-gated.
- `lib/pos/generic/normalise.ts` — documented minimal JSON → `NormalisedOrder`.
- `lib/pos/csv/` — map columns to `NormalisedOrder`, reusing the import runner. Marketing consent never inferred.
**Test:** `pos-generic-ingest.test.ts` — signed body ingests; bad sig → 400; CSV maps to orders.

### 7 — `feat(pos): realtime spend push`
- `lib/realtime/spend-channel.ts` (client) — Supabase Realtime `postgres_changes` on `guest_spend_summary` filtered by `organisation_id`; RLS protects the channel. (New surface — no Realtime wired today.)
- Wire into guest profile spend panel + floor-plan side panel + booking detail dialog; keep the 30s poll as fallback.
- `ALTER PUBLICATION supabase_realtime ADD TABLE public.guest_spend_summary;` (foldable into Commit 1's migration).
**Test:** `pos-realtime-rls.test.ts` — org A never receives org B changes; org-A change arrives.

### 8 — `feat(pos): DSAR de-link + line-item null`
- `lib/dsar/scrub.ts` — inside the existing transaction: null `guest_id` + `match_method` on the guest's `pos_orders`, null `line_items_cipher` on them, delete the `guest_spend_summary` row; after commit `audit.log('pos.order.dsar_scrubbed', {counts/ids})`. Extend `RunErasureScrubResult` with `posOrdersDelinked`.
**Test:** extend `tests/integration/dsar-scrub.test.ts` — assert all of the above + order row survives (de-linked anonymous revenue).

### 9 — `feat(pos): retention + backfill cron`
- `lib/pos/retention.ts` — bounded resumable sweep of `pos_orders` older than `organisations.pos_retention_months ?? 24`.
- `lib/pos/backfill.ts` — page-by-page resumable historical pull (import-runner pattern).
- `app/api/cron/pos-retention/route.ts` + `app/api/cron/pos-backfill/route.ts` (mirror `enquiry-retention`; `Authorization: Bearer ${CRON_SECRET}`); add entries to `vercel.json`.
**Test:** `tests/unit/pos-retention.test.ts` — past-retention swept, in-window survive, bounded + resumable.

### 10 — `feat(pos): connect UI + unmatched orders + manual attach`
- Plus-gated connect/disconnect settings per venue; spend panel components; unmatched-orders list; manual-attach action (`match_method='manual'`, audited).
**Test:** Playwright smoke for connect + spend panel; unit test for manual-attach writing `match_method='manual'`.

### 11 — `docs(pos): gdpr sub-processor rows + 30-day notice`
- `docs/playbooks/gdpr.md` — sub-processor row per provider (Square, Lightspeed) following AWS-Bedrock/WhatsApp precedent + "POS sources" data-category note; schedule 30-day notice. `@gdpr-auditor` clean. `.env.local.example` — document `SQUARE_*`, `LIGHTSPEED_*`, webhook secret names (no values).

## Migration (single)

`pnpm db:generate` after the schema additions emits tables/FKs/uniques/indexes/enum + the `pos_retention_months` + Art. 9 columns. **Hand-edit in** (Drizzle won't generate; copy `0048` block-for-block):

- **Four `BEFORE INSERT/UPDATE` triggers** (`SECURITY DEFINER`, `SET search_path = public`): `enforce_pos_connections_org_id` (from `venue_id`), `enforce_pos_orders_org_id` (from `venue_id`), `enforce_pos_webhook_events_org_id` (from `connection_id` → `pos_connections.organisation_id`), `enforce_guest_spend_summary_org_id` (from `guest_id` → `guests.organisation_id`).
- **Four RLS policies:** `ENABLE ROW LEVEL SECURITY` + `FOR SELECT TO authenticated USING (organisation_id IN (SELECT public.user_organisation_ids()))` on each. **No INSERT/UPDATE/DELETE policy** — deny-by-default; all writes via `adminDb()` from verified webhook/cron paths.
- Uniques: `pos_connections(venue_id, provider)`, `pos_webhook_events(provider, external_event_id)`, `pos_orders(connection_id, external_order_id)`. Indexes per spec. `on delete` rules per spec (`pos_orders.guest_id` → set null; `guest_spend_summary.guest_id` → cascade).
- Realtime publication line (Commit 7).

Reversible: drop the four tables + the added `organisations` column. No backfill of existing data.

## Dependency order

Commit 1 blocks all. 2 blocks 4,5. 3 blocks 4,5,6,7. 8 depends only on 1. 9 depends on 1+3. 10 depends on 3 + (4 or 6). **11 is a hard gate before any production egress** (write early, enforce at go-live). No commit after 1 adds schema (except the foldable Realtime publication).

## Test map

| File | Proves | Commit |
|---|---|---|
| `rls-pos-orders.test.ts` (+per-venue) | cross-tenant + venue isolation, trigger rewrite, deny-by-default writes | 1 |
| `pos-connection-crypto.test.ts` | token/secret cipher round-trip; no plaintext | 2 |
| `pos-pan-guard.test.ts` | PAN dropped pre-persist, never logged (SAQ-A) | 3 |
| `pos-match-identity.test.ts` | POS hash byte-identical to guest hash | 3 |
| `pos-match-booking.test.ts` | table/check ref links to correct cover | 3 |
| `pos-rollup.test.ts` | summary recompute + rebuildable from orders | 3 |
| `pos-webhook-square.test.ts` | valid ingest, forged→400, replay no-op | 4 |
| `pos-webhook-lightspeed.test.ts` | LS verify + CLOSED ingest; flag off→disabled | 5 |
| `pos-generic-ingest.test.ts` | signed ingest, bad sig→400, CSV maps | 6 |
| `pos-realtime-rls.test.ts` | org A never sees org B changes | 7 |
| `dsar-scrub.test.ts` (extended) | de-link + line_items null + summary delete + audit | 8 |
| `pos-retention.test.ts` | swept past-retention, bounded, resumable | 9 |

## Go-live blockers (non-code — founder owns)

1. **Lightspeed partner approval** — build Commit 5 behind `LIGHTSPEED_PARTNER_ENABLED=false`; don't flip until approved.
2. **TRA + SCCs/IDTA before first egress** (Square US-HQ; LS if outside EEA) — per the WhatsApp/Meta precedent. Blocks Commits 4 & 5 going live.
3. **Sub-processor rows + 30-day customer notice** — first production webhook ingest = first egress = clock start. Commit 11 doc work + a calendar commitment.
4. **Read-only scope confirmation** — assert Square/LS OAuth never requests write/refund scopes (code assertion + reviewer check).

## Per-feature close-out (CLAUDE.md rules 2, 6, 8)

Each commit ends with `pnpm typecheck && pnpm lint && pnpm test`; `@code-reviewer` on the diff; `@gdpr-auditor` on any commit touching guest/order/token data (1, 2, 3, 8, 11). `/ship` to commit.
