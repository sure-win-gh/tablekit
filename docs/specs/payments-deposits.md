# Spec: Deposits and no-show capture

**Status:** shipped — flow A (deposit at booking + refunds + abandonment janitor) + flow B (card hold + off-session no-show capture) + flow C (no payment) all live.
**Depends on:** `payments.md` (charter), `bookings.md`, `widget.md`, `venues.md`. See also `docs/playbooks/payments.md`.
**Follows:** payments-connect (shipped — see commits `a7a853a`, `0661241`, `4af0181`).

## What we're building

The deposit and card-hold slice of payments. Three flows, all optional per venue, all gated on a connected Stripe account being fully enabled:

- **A. Deposit charged at booking** — fixed amount per cover or flat per booking, captured immediately.
- **B. Card hold (no-show fee)** — no charge at booking; card stored; captured only if the booking becomes `no_show`.
- **C. No payment** — today's default. Booking confirms instantly, no Stripe involvement.

Plus the operator-facing counterparts: deposit-rule CRUD, refund action on a booking, visible payment state on each booking row.

## What's already shipped

Do not re-scope these:

- `stripe_accounts`, `stripe_events` tables (Drizzle schema in `lib/db/schema.ts`). **Note:** connect is per-organisation, not per-venue — the implementer deviated from `payments.md` deliberately; the whole org shares one `acct_*`. This spec inherits that decision.
- Webhook receiver (`app/api/stripe/webhook/route.ts`) with signature verify, idempotent store, handler dispatch, 200-on-handler-error audit semantics.
- Handler registry (`lib/stripe/webhook.ts#registerHandler`) — new events register by dropping a file under `lib/stripe/handlers/` and importing it from `handlers/index.ts`.
- `account.updated` handler.
- Connect onboarding + return flow from the dashboard.
- `paymentsDisabled()` kill switch and `stripeEnabled()` configuration guard.
- `bookings.deposit_intent_id` column (plumbed; currently always null).

## Non-negotiables

Re-read `docs/playbooks/payments.md` before touching card collection. Summary:

1. **SAQ-A.** Card details only via Stripe Elements / Payment Element on the client. No card data on our servers. A CI test greps the codebase for literal 16-digit patterns and fails on match.
2. **3D Secure forced.** `payment_method_options.card.request_three_d_secure: 'any'` on every PaymentIntent and SetupIntent.
3. **Connect Standard, direct charges.** Create Intents with `{ stripeAccount: acct_* }` — the connected account is the merchant of record. No `application_fee_amount` on MVP.
4. **Kill switch.** Every entry point (widget Intent creation, dashboard refund, no-show cron) short-circuits on `paymentsDisabled()`.
5. **Idempotency.** Every handler re-runs safely; keyed off `stripe_events.id` at the webhook layer and row-level UPSERT semantics at the `payments` table.
6. **Amounts in minor units.** `int` pence columns only. Floats are a bug.

## Flows

### Flow A — deposit at booking

1. Widget collects party size / date / time / guest details, calls `POST /api/v1/bookings`. API resolves the applicable `deposit_rules` row; if one matches, booking is created in `requested` state and an `application/json` response carries `{ bookingId, clientSecret, publishableKey }`.
2. Server creates a `PaymentIntent` on the connected account — `capture_method: 'automatic'`, `confirmation_method: 'automatic'`, `metadata: { booking_id, kind: 'deposit' }`, 3DS forced. Writes a `payments` row in `requires_payment_method` state with `kind = 'deposit'`.
3. Widget mounts Stripe Elements, guest enters card, 3DS flow runs if needed, `stripe.confirmPayment` returns success.
4. Webhook `payment_intent.succeeded` → handler flips the booking to `confirmed`, updates `payments.status`, appends a `booking_events` row.
5. On `payment_intent.payment_failed`, booking stays `requested` and widget retries with a new Intent on the same booking.

### Flow B — card hold

1. Same as A through booking creation, but the matching `deposit_rules` row has `kind = 'card_hold'`. Server creates a `SetupIntent` (`usage: 'off_session'`, `payment_method_types: ['card']`, 3DS forced) **and** an `ephemeralKey` + `Customer` on the connected account. Writes a `payments` row with `kind = 'hold'`.
2. Widget confirms the SetupIntent via Elements.
3. Webhook `setup_intent.succeeded` → booking → `confirmed`, `payments` row stores `stripe_customer_id` + `stripe_payment_method_id` for later off-session charging.
4. Cron (`POST /api/cron/no-show-capture`, every 15 min, Vercel Cron) finds bookings where `status = 'confirmed'` AND a `kind='hold'` payment exists AND `start_at + 30 minutes < now()` AND no `seated`/`finished` event. For each: create a new `PaymentIntent` with `{ customer, payment_method, off_session: true, confirm: true, capture_method: 'automatic', amount: rule.amount_minor }` on the connected account. On success, transition booking → `no_show`, write a `payments` row with `kind = 'no_show_capture'`.
5. If the off-session capture fails (e.g. 3DS required, insufficient funds), transition to `no_show` anyway and log the failure on the `payments` row. Operator gets a dashboard notice; no automated retry.

### Flow C — no payment

No change. Booking transitions straight `requested → confirmed` as today.

### Refunds

- Dashboard-only. Operator hits **Refund** on a booking's detail view; modal asks for reason (required, free text ≥ 3 chars).
- Full refund via button; partial by typing amount in minor units.
- Server action calls `stripe.refunds.create({ payment_intent }, { stripeAccount })`, writes a `payments` row with `kind = 'refund'` and negative amount, appends to `audit_log` with the operator's user id and reason.
- Webhook `charge.refunded` updates the refund row's status to `succeeded`; a dashboard-initiated refund is considered pending until this fires (Stripe-side delay is usually <1s).

## Acceptance criteria

- [ ] New handlers registered: `payment_intent.succeeded`, `payment_intent.payment_failed`, `setup_intent.succeeded`, `setup_intent.setup_failed`, `charge.refunded`. All idempotent. All no-op on a missing `payments` row (defensive — webhooks can race booking creation).
- [ ] `deposit_rules` CRUD under `app/(dashboard)/dashboard/venues/[venueId]/settings/` — only editable when `stripe_accounts.charges_enabled = true` for the org.
- [ ] Rule resolution is deterministic. Given a booking, the resolver picks at most one rule using this priority: `service_id` match > `day_of_week` match > `min_party`/`max_party` match > default. Ties broken by `created_at desc`. Unit-tested.
- [ ] `POST /api/v1/bookings` returns `requires_deposit: true | false` and, when true, a `clientSecret` + Intent kind. Widget reads both; existing flow C is unchanged when no rule matches.
- [ ] RLS on `deposit_rules` and `payments`: org A cannot read org B's rows. Integration test proves it.
- [ ] No-raw-card CI grep passes (existing check must be extended to scan new routes).
- [ ] 3DS forced on every Intent. Unit test asserts the Stripe call args include `request_three_d_secure: 'any'`.
- [ ] Widget renders the Payment Element only when `stripeEnabled()` is true and the resolved rule is non-null. When Stripe is off, flow A + B silently fall back to flow C.
- [ ] No-show cron: tested against a fake clock, rehearses the window. Cron is idempotent — a second run over the same window performs no new charges.
- [ ] Refund UI blocks partial refunds beyond the original amount minus previous refunds. Enforcement is server-side, not just client-side.
- [ ] `payments` row is never written outside a handler or a server action — never from the widget directly. Grep test in CI.

## Data model (delta on top of what's shipped)

```sql
-- Deposit rule. One-of-many per venue. service_id null = applies to
-- the whole venue. Resolver picks by priority in the acceptance
-- criteria above.
create table deposit_rules (
  id                  uuid primary key default gen_random_uuid(),
  organisation_id     uuid not null references organisations(id) on delete cascade,
  venue_id            uuid not null references venues(id) on delete cascade,
  service_id          uuid references services(id),           -- null = all services
  min_party           int  not null default 1,
  max_party           int,                                    -- null = no ceiling
  day_of_week         int[] not null default '{0,1,2,3,4,5,6}',
  kind                text not null check (kind in ('per_cover','flat','card_hold')),
  amount_minor        int  not null check (amount_minor >= 0),
  currency            char(3) not null default 'GBP',
  refund_window_hours int  not null default 24,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create index deposit_rules_venue_idx on deposit_rules (venue_id);
create index deposit_rules_org_idx   on deposit_rules (organisation_id);

-- Every Stripe movement we've initiated or observed. One row per
-- Intent; refund captures live as their own rows keyed on refund id
-- (stripe_intent_id = re_* in that case).
create table payments (
  id                       uuid primary key default gen_random_uuid(),
  organisation_id          uuid not null references organisations(id) on delete cascade,
  booking_id               uuid not null references bookings(id) on delete cascade,
  kind                     text not null check (kind in ('deposit','hold','no_show_capture','refund')),
  stripe_intent_id         text not null unique,            -- pi_* | seti_* | re_*
  stripe_customer_id       text,                            -- only set for 'hold' + 'no_show_capture'
  stripe_payment_method_id text,                            -- only set for 'hold' + 'no_show_capture'
  amount_minor             int  not null,                   -- negative for 'refund'
  currency                 char(3) not null,
  status                   text not null,                   -- mirrors Stripe status verbatim
  failure_code             text,
  failure_message          text,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now()
);

create index payments_booking_idx on payments (booking_id);
create index payments_org_idx     on payments (organisation_id);
```

RLS policies mirror the `bookings` pattern: SELECT/UPDATE restricted to members of the row's org; INSERT via service role only (all writes go through the admin DB helper, same as `stripe_events`).

`bookings.deposit_intent_id` stays — it's the cheap denormalised pointer for dashboard list views.

## Env and ops

All env vars already exist:

- `STRIPE_SECRET_KEY`, `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY`, `STRIPE_WEBHOOK_SECRET` — set during payments-connect.
- New: `CRON_SECRET` — shared secret Vercel Cron sends in an `Authorization` header; cron route 401s without it. Add to `.env.local.example`.

Cron schedule in `vercel.json`: `*/15 * * * *` → `/api/cron/no-show-capture`.

## Out of scope

- Venue-level override of the 30-minute no-show grace period (hard-coded for MVP; revisit if operators ask).
- Partial-refund automation (e.g. "refund 50% if cancelled within 24h") — operators do it manually.
- Revenue reporting on deposits (lives in `reporting.md`).
- Apple Pay / Google Pay wallets (Stripe handles both automatically once the Payment Element is mounted).
- Multi-currency; all venues are GBP on MVP. Column exists for forward compatibility.
- Dispute handling (`charge.dispute.created`). Store the event, surface in Sentry, manual handling only.
