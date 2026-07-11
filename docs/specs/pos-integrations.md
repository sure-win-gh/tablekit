# Spec: POS integrations — order history + spend on guest profiles

**Status:** draft
**Depends on:** `auth.md`, `guests.md`, `public-api.md`, `bookings.md`. See `docs/playbooks/gdpr.md` (sub-processor list + DSAR) and `docs/playbooks/payments.md` (PCI posture) before starting.
**Build plan:** [`pos-integrations-plan.md`](pos-integrations-plan.md) — ordered commit sequence, migration detail, test map, go-live blockers.
**Tier:** Plus (multi-venue group CRM already gates here; POS sits alongside it).

## What we're building

Inbound integrations that pull **completed order + spend data** out of a venue's till and attach it to the matching guest profile, so an operator can see "this guest has been in 7 times and spent £612" next to a booking — and see it update **near-real-time** while a service is running.

Three ingest paths, one internal model:

1. **Square** — native webhooks (`payment.updated`, `order.updated`) + Orders/Payments API backfill. OAuth Connect.
2. **Lightspeed Restaurant (K-Series)** — native webhooks (`Account: CLOSED` / `CHECK_WAS_UPDATED`, `Payment: SUCCESS`) + API backfill. Partner-gated OAuth.
3. **Generic** — a signed inbound webhook + a nightly CSV importer, so any till (Toast, Epos Now, Square for a venue we haven't OAuth-certified yet, a bespoke system) can push order data without a bespoke connector.

All three normalise into the same `pos_orders` table and the same guest-matching + spend-rollup pipeline. The dashboard is fed by Supabase Realtime so an open guest profile / floor-plan panel updates without a manual refresh.

## Why this matters

Spend history is the single biggest feature gap against OpenTable GuestCenter and SevenRooms. It turns the guest CRM from "who booked" into "who's valuable", which is the thing that justifies the Plus tier and reduces churn. It also makes the VIP tag (`guests.tags`) earn its keep — an operator can sort by realised spend instead of guessing.

## Important — controller/processor + PCI

- The **venue is the data controller** for guest + order data, exactly as in `guests.md`. We are the **processor**. The venue's existing relationship with Square/Lightspeed is their own; we are a *recipient* of data they already control.
- **We never touch card data.** Order totals, tips, line items, and a payment **method label** ("Visa ••4242") are the most we ingest. No PAN, no CVV, no expiry, no full card token. This keeps us in **PCI SAQ-A** exactly as `docs/playbooks/payments.md` requires. If a POS payload contains a PAN-shaped field, the ingest layer drops it before persistence (see Acceptance criteria).
- Square and Lightspeed are the venue's **upstream source**, not an outbound sub-processor of ours — but per the **precedent already set by the Google Business Profile API row** in `docs/playbooks/gdpr.md` (an inbound, OAuth-token-holding connector that is nonetheless listed as a sub-processor), we treat them the same way. **Each POS provider gets a sub-processor-list row** in `gdpr.md` (purpose: order/spend ingest; region; DPA reference; OAuth tokens stored encrypted) **and triggers the standard 30-day customer notice before go-live.** This is the conservative reading and matches how the playbook has actually classified the directly comparable Google connector — do not skip it.

## User stories

- As a manager I can connect our Square (or Lightspeed) account to a venue in two clicks (OAuth) and see historical spend backfill within the hour.
- As a host looking at a booking, I can see the guest's lifetime spend, visit count, average spend, and last order date.
- As a manager watching a busy service, I can see a guest's tab update on their profile shortly after they pay, without refreshing.
- As a venue without a supported till, I can upload a CSV of orders (or POST them to a webhook) and still get spend on profiles.
- As a guest exercising erasure, my order history is scrubbed alongside my profile within the same 30-day DSAR SLA.

## Data model

Four new tables. All org-scoped, all RLS-enabled, all following the `guests.md` encryption conventions (`encryptPii` / `decryptPii` / `hashForLookup` from `lib/security/crypto.ts`).

```sql
-- One connection per (venue, provider). Holds the OAuth grant + webhook secret.
create table pos_connections (
  id                 uuid primary key default gen_random_uuid(),
  organisation_id    uuid not null references organisations(id) on delete cascade,
  venue_id           uuid not null references venues(id) on delete cascade,
  provider           text not null,            -- 'square' | 'lightspeed_k' | 'generic'
  external_account_id text,                     -- Square merchant/location id, LS business id
  access_token_cipher  text,                    -- envelope-encrypted OAuth access token
  refresh_token_cipher text,                    -- envelope-encrypted OAuth refresh token
  token_expires_at   timestamptz,
  webhook_secret_cipher text,                   -- for the generic inbound path + LS verification
  line_items_enabled   boolean not null default false, -- Art.9 opt-in gate (see GDPR section)
  art9_basis_confirmed_at timestamptz,          -- venue confirmed an Art.9(2) basis before enabling line items
  status             text not null default 'active', -- 'active' | 'paused' | 'revoked' | 'error'
  last_synced_at     timestamptz,
  last_error         text,
  created_by_user_id uuid references users(id),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (venue_id, provider)
);

-- Idempotency ledger for every inbound POS webhook (mirrors stripe_events / inbound_webhook_events).
create table pos_webhook_events (
  id              uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references organisations(id) on delete cascade,
  connection_id   uuid not null references pos_connections(id) on delete cascade,
  provider        text not null,
  external_event_id text not null,            -- the POS's own event id
  received_at     timestamptz not null default now(),
  processed_at    timestamptz,
  unique (provider, external_event_id)
);

-- Normalised completed orders. One row per till order/check.
create table pos_orders (
  id                uuid primary key default gen_random_uuid(),
  organisation_id   uuid not null references organisations(id) on delete cascade,
  venue_id          uuid not null references venues(id) on delete cascade,
  connection_id     uuid not null references pos_connections(id) on delete cascade,
  provider          text not null,
  external_order_id text not null,            -- the till's order/check id (dedupe key)
  guest_id          uuid references guests(id) on delete set null, -- nullable: matched when possible
  booking_id        uuid references bookings(id) on delete set null, -- linked when we can tie to a cover
  total_minor       integer not null,         -- pence, gross
  tip_minor         integer not null default 0,
  tax_minor         integer,
  currency          char(3) not null default 'GBP',
  cover_count       integer,
  payment_method_label text,                  -- 'Visa ••4242', 'Cash' — never a PAN
  line_items_cipher text,                     -- envelope-encrypted JSON, optional (can reveal habits)
  closed_at         timestamptz not null,     -- when the check was settled
  match_method      text,                     -- 'email_hash' | 'phone_hash' | 'booking' | 'manual' | null
  raw_provider_ref  text,                     -- opaque pointer for support/debug, no PII
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (connection_id, external_order_id)
);

-- Denormalised per-guest spend rollup (read-hot; recomputed on order upsert).
create table guest_spend_summary (
  guest_id          uuid primary key references guests(id) on delete cascade,
  organisation_id   uuid not null references organisations(id) on delete cascade,
  order_count       integer not null default 0,
  total_spend_minor bigint  not null default 0,
  avg_spend_minor   integer not null default 0,
  last_order_at     timestamptz,
  first_order_at    timestamptz,
  updated_at        timestamptz not null default now()
);

create index on pos_orders (organisation_id, venue_id, closed_at);
create index on pos_orders (guest_id) where guest_id is not null;
create index on guest_spend_summary (organisation_id, total_spend_minor desc);
```

Notes:
- `total_minor` etc. are plain integers (pence) — they are not PII on their own, so they stay queryable for the "top guests by spend" sort. The *linkage* to a named guest is what's sensitive, and that's protected by RLS + the encrypted guest row.
- `line_items_cipher` is **optional and encrypted** — itemised orders can reveal **special-category data under UK GDPR Art. 9** (alcohol volume, dietary/health patterns). It therefore inherits the full Art. 9 posture from `gdpr.md §Special-category`: (a) **default off per connection**, operator must explicitly opt in and is shown the Art. 9 implication; (b) lawful basis is the controller's — we record that the venue has confirmed an Art. 9(2) basis before enabling, we do not assert one on their behalf; (c) it is **envelope-encrypted under the org DEK** like `guests.notes_cipher`; (d) it is **nulled on DSAR erasure** (see DSAR section); (e) it is covered by the retention sweep. If a connection never opts in, no line-item data is stored at all.
- `guest_spend_summary` is a cache. It can always be rebuilt from `pos_orders`; never the source of truth.

## RLS + tenancy

Per CLAUDE.md rule 3, every new table ships with RLS and a cross-tenant test. Pattern matches `venue_photos` (trigger-denormalised `organisation_id` + member-read policy):

- `organisation_id` is **enforced by a `BEFORE INSERT/UPDATE` trigger** that derives it from the parent `venue_id` / `connection_id`, so a forged org id can't be written. (Mirrors `enforce_venue_photos_org_id`.)
- RLS policies:
  - `SELECT` to `authenticated` where `organisation_id IN (SELECT public.user_organisation_ids())`.
  - **All writes go through `adminDb()`** from inside signature-verified webhook handlers / cron — there is no client-side write path, so there are no `INSERT`/`UPDATE` policies for `authenticated` (deny by default).
- Tests: `tests/integration/rls-pos-orders.test.ts` proves org A cannot read org B's orders, spend summary, connections, or webhook events. A per-venue variant proves a venue-scoped manager can't read another venue's orders within the same org.

## Ingest pipeline (shared)

All three paths converge on one internal flow:

```
inbound (webhook | csv | backfill)
  → verify signature / auth
  → dedupe via pos_webhook_events (provider, external_event_id)   [webhook paths]
  → normalise to a NormalisedOrder
  → drop any card-shaped fields (PAN regex guard)
  → upsert pos_orders on (connection_id, external_order_id)
  → match guest (below)
  → recompute guest_spend_summary for the affected guest
  → emit realtime change (below)
  → audit.log('pos.order.ingested', { non-PII metadata })   # dotted convention, matches dsar.scrubbed / guest.erased
```

- **Inline vs cron.** Webhook handlers process **inline** (the work is small — one upsert + one rollup) so the dashboard updates in seconds. The live path therefore does **not** depend on cron at all. Heavy work — initial historical backfill and retention sweeps — is page-by-page and resumable (same crash-resumable pattern as the import runner).
- **Cron topology.** Backfill and retention run as **two dedicated cron routes**, `/api/cron/pos-backfill` and `/api/cron/pos-retention`, mirroring the existing `enquiry-retention` / `campaign-retention` routes. (An earlier draft of this spec assumed Vercel Hobby allows only one cron schedule; that is false for this repo — it already runs ~12 separate cron routes, one per concern, so dedicated POS routes match the established pattern. Logic lives in `lib/pos/retention.ts` / `lib/pos/backfill.ts` so the cron wiring is trivially swappable.) Both accept `Authorization: Bearer ${CRON_SECRET}` and are bounded + resumable.
- **Idempotency** is Postgres-backed (`pos_webhook_events`), consistent with `stripe_events` and `inbound_webhook_events`. No Redis (CLAUDE.md: "No Redis until we need it").

### Guest matching

Deterministic, no plaintext scans (same discipline as `guests.md`):

1. If the POS payload carries a customer email/phone, compute the lookup hash via the **same `hashForLookup(value, "email"|"phone")` call that guest upsert uses** (`lib/guests/upsert.ts`) and match against `guests.email_hash` / `guests.phone_hash` within the same `organisation_id`. **Reconciliation note:** `guests.md` shows a schema comment (`sha256(lower(email) || org_salt)`) that predates the HMAC implementation now in `hashForLookup`. POS matching must call the *exact same function the guest table is populated with* — verify at build time that POS-side and guest-side hashes are byte-identical (a unit test inserts a guest and matches an order on the same email), rather than re-deriving a hash from the stale schema comment.
2. Else, if the order can be tied to a booking (Square/LS table or open-check reference that maps to a `bookings` row at the same venue + service window), link via `booking_id` → `bookings.guest_id`.
3. Else leave `guest_id` null (an **unmatched order** — still counted in venue revenue, just not attributed). Operators get an "unmatched orders" view and a **manual-attach** action (writes `match_method = 'manual'`, audited).
4. `match_method` records how each link was made, for transparency + DSAR.

Group-CRM: if `organisations.group_crm_enabled`, matching is org-wide; otherwise venue-scoped. Reuses the exact gate from `guests.md` / `multi-venue.md`.

## Provider specifics

### Square
- **Auth:** OAuth (Connect). Scopes limited to `PAYMENTS_READ`, `ORDERS_READ`, `MERCHANT_PROFILE_READ`, `CUSTOMERS_READ`. No write scopes.
- **Live signal:** `payment.updated` is the reliable in-venue event — `order.created` only fires for API-created orders, **not** orders rung up on the Square POS app, so we key off payments + `order.updated`. On `payment.updated` (status `COMPLETED`) we fetch the parent order for totals/line items.
- **Signature:** HMAC-SHA256 over `notificationURL + rawBody` using the subscription signature key, compared in constant time; header `x-square-hmacsha256-signature`. (`constantTimeEqual` already exists.)
- **Residency:** Square is US-headquartered and the webhook/API egress **may originate from a US region**. The house rule (see the WhatsApp/Meta precedent in `gdpr.md`) is that any provider that *might* route PII outside the EEA requires **SCCs/IDTA + a transfer risk assessment (TRA) completed before first data egress** — not mere reliance on UK adequacy. Treat the TRA as a **go-live blocker**. (UK adequacy, current to 2028, may turn out sufficient, but that is the *output* of the TRA, not an assumption.) Same applies to Lightspeed if it egresses from outside the EEA.

### Lightspeed Restaurant (K-Series)
- **Auth:** Partner-gated OAuth. Requires Tablekit to be an approved Lightspeed partner — **this is a go-live dependency, flag early** (similar to the Reserve-with-Google partner block in `reserve-with-google.md`).
- **Live signal:** subscribe to `Account: CLOSED` and `CHECK_WAS_UPDATED` (+ `Payment: SUCCESS`). The closed account/check carries the settled total.
- **Signature:** verify per Lightspeed's webhook signing scheme (HMAC over raw body with the registered secret); store the secret in `webhook_secret_cipher`.

### Generic (CSV + signed webhook)
- **Webhook:** `POST api.tablekitapp.com/v1/pos/ingest` — Plus-tier, authenticated with a per-connection secret; body signed `X-TableKit-POS-Signature: sha256=<hmac(secret, body)>` (mirrors our **outbound** signing in `public-api.md`, inverted). A documented minimal JSON shape (external_order_id, total_minor, currency, closed_at, optional email/phone, optional line items).
- **CSV:** reuses the `import-export.md` mapping-wizard + two-pass + crash-resumable runner. Columns map to the same `NormalisedOrder`. Marketing consent is never inferred from a POS upload.

## Real-time to the dashboard

- Use **Supabase Realtime** (Postgres logical replication) — no new sub-processor, it's the database we already run. Subscribe the dashboard to `guest_spend_summary` (and optionally `pos_orders`) filtered by `organisation_id`.
- RLS applies to Realtime, so a client only receives changes for its own org — the same policy that protects the REST read path protects the stream.
- Surfaces that update live: the guest profile spend panel, the floor-plan side panel (extends the existing 30s auto-refresh in `floor-plan-visual.md` with a push for spend), and the booking detail dialog.
- Fallback: if a client can't hold a socket, the existing 30s poll still shows fresh numbers — Realtime is an enhancement, not a hard dependency.

## GDPR / DSAR

- **Lawful basis:** order/spend attribution is legitimate interest of the controller (venue) for guest relationship management; the venue's privacy notice must cover it. We document the data categories received in `docs/playbooks/gdpr.md` **and add a sub-processor-list row per POS provider** (per the Google-connector precedent), each with a DPA reference and confirmed region. Line-item ingest carries the separate Art. 9 basis above.
- **Retention:** order/spend data is "billing-adjacent" but we hold it for CRM, not accounting — default retention configurable per org via `organisations.pos_retention_months` (nullable → default applies), default 24 months rolling (matching the campaign-send sweep precedent). Enforced by the dedicated `/api/cron/pos-retention` route (see Cron topology above).
- **DSAR erasure:** the existing `dsar_requests`-driven sweep (`/api/cron/dsar-scrub` + the inline kick, `SLA_DAYS = 30`) is the clock — POS scrub is wired into it, not a parallel mechanism. `lib/dsar/scrub.ts` is extended so that, **inside the same single transaction** that scrubs the guest, erasing a guest also: nulls `guest_id` and `match_method` on their `pos_orders` (orders survive as de-linked anonymous venue revenue), **nulls `line_items_cipher`** on those orders (Art. 9 data must not survive erasure), deletes their `guest_spend_summary` row, and writes a `pos.order.dsar_scrubbed` audit entry (counts + ids only, no PII). The existing DSAR scrub test (`tests/integration/dsar-scrub.test.ts`) is extended to assert all of the above.
- **No plaintext PII in logs / Sentry / audit metadata** — only ids, counts, amounts (per `gdpr.md` and the existing PII guard hook).

## Tiering + billing

- Plus only. Gate at connection creation + at the cron runners.
- No pass-through cost (unlike SMS) — POS ingest is bandwidth-cheap. No metering needed beyond the existing plan gate.

## Acceptance criteria

- [ ] Four tables created with RLS enabled, org-id enforced by trigger, deny-by-default writes. Cross-tenant + per-venue isolation proven by `tests/integration/rls-pos-orders.test.ts`.
- [ ] Square OAuth connect flow (read-only scopes) + `payment.updated`/`order.updated` webhook with constant-time HMAC verification; bad signature → 400, no write.
- [ ] Lightspeed connect flow behind a partner-approval feature flag; `Account: CLOSED`/`CHECK_WAS_UPDATED` ingest with signature verification.
- [ ] Generic signed webhook (`/v1/pos/ingest`) + CSV importer reusing the `import-export.md` runner.
- [ ] Idempotent ingest: replaying a webhook (same `provider, external_event_id`) is a no-op; proven by test.
- [ ] **Card-data guard:** a PAN-shaped field anywhere in a payload is dropped before persistence and never logged; proven by a unit test feeding a synthetic PAN. Keeps PCI SAQ-A.
- [ ] Deterministic guest matching via `email_hash`/`phone_hash`/booking link; no plaintext scans; unmatched-orders view + audited manual-attach.
- [ ] `guest_spend_summary` recomputed on every order upsert and rebuildable from `pos_orders` alone (rebuild script + test).
- [ ] Supabase Realtime push updates an open guest profile within ~5s of a webhook; RLS confirmed on the channel (org A never receives org B changes).
- [ ] OAuth tokens + webhook secrets (`access_token_cipher`, `refresh_token_cipher`, `webhook_secret_cipher`) are stored via `encryptPii` and round-trip through `decryptPii`; proven by a unit test. No token ever written or logged in plaintext.
- [ ] DSAR erasure de-links `pos_orders` (nulls `guest_id` + `match_method`), nulls `line_items_cipher`, deletes `guest_spend_summary`, audits, within the existing 30-day SLA; covered by extending `tests/integration/dsar-scrub.test.ts`.
- [ ] `docs/playbooks/gdpr.md` updated with a "POS sources" data-category note; `@gdpr-auditor` run clean.
- [ ] Plus-tier gate enforced at connect + cron; Free/Core cannot create a connection.
- [ ] No plaintext PII in logs/Sentry/audit metadata (PII guard hook passes).

## Migration plan

1. One Drizzle migration adds the four tables + indexes + the org-id-enforcing triggers + RLS policies (`pnpm db:generate`, hand-edit the trigger/policy SQL as in `0048_*`). No backfill of existing data — POS data only exists once a venue connects.
2. Extend `organisations` only if a per-org retention override is wanted (a single `pos_retention_months` int, nullable → default applies). Otherwise no change to existing tables.
3. Extend `lib/dsar/scrub.ts` (behavioural, not schema) in the same PR as the DSAR test.
4. Reversible: dropping the four tables + the `organisations` column (if added) fully reverts. Conventional commits, one concern each (`feat(pos): schema + RLS`, `feat(pos): square ingest`, …).

## Security check (run before merge)

- `@code-reviewer` on the diff.
- `@gdpr-auditor` — confirms: **sub-processor rows added** for each POS provider + 30-day notice scheduled, encrypted token/secret storage, DSAR coverage (including `line_items_cipher` null), Art. 9 posture on line items, no plaintext PII in logs.
- Confirm read-only OAuth scopes for Square/Lightspeed (no write/refund scope ever requested).
- Confirm the PAN guard test passes and webhook signature verification rejects forged bodies.
- **TRA completed before first egress** if Square/Lightspeed route PII from outside the EEA (SCCs/IDTA attached), per the WhatsApp/Meta precedent — go-live blocker.

## Out of scope (v1)

- Writing back to the POS (comps, modifying checks, refunds) — read-only only.
- Real-time *open-tab* tracking before payment (we ingest on settle, not per-item-fired).
- Inventory / menu-engineering analytics on line items (separate spec if demanded).
- POS-driven loyalty/points (CLAUDE.md year-1 non-goal: no custom loyalty engine).
- Toast as a certified OAuth connector (US-focused; covered by the generic path until UK demand justifies it).

---

_Sources for provider behaviour verified June 2026: Square Orders/Payments webhooks + HMAC-SHA256 (`x-square-hmacsha256-signature`) validation; Lightspeed Restaurant K-Series webhook events (Account CLOSED / CHECK_WAS_UPDATED, Payment SUCCESS) and partner-gated API access._
