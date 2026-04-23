# Spec: Deposits, pre-auth, no-show capture (Stripe)

**Status:** draft
**Depends on:** `bookings.md`. See also `docs/playbooks/payments.md`.

## What we're building

Optional deposit / pre-authorisation collection at booking time, with automatic capture on no-show and automatic release on completed visits.

## Non-negotiables

1. **We are SAQ-A.** Card data never touches our servers. Always use Stripe Elements or Stripe Checkout.
2. **Venues are merchants of record** via **Stripe Connect Standard**. We are the platform, not the acquirer.
3. **3D Secure is forced** on all UK cards (SCA compliance).

## Flows

### A. Deposit required (e.g. fixed £20/head)

1. Widget posts a `requested` booking to our API.
2. API creates a **Stripe PaymentIntent** with `confirmation_method: manual` and `capture_method: automatic` for the deposit amount.
3. API returns `client_secret` to widget.
4. Widget mounts Stripe Elements; diner authenticates (3DS).
5. Widget calls `stripe.confirmPayment` → Stripe captures the deposit.
6. Stripe webhook `payment_intent.succeeded` → API transitions booking to `confirmed`.

### B. Card hold (no deposit; capture on no-show)

1. Widget posts `requested` booking.
2. API creates a **SetupIntent** (no charge yet, stores the payment method on the Connect account).
3. Widget collects card via Elements; diner authenticates.
4. Booking transitions to `confirmed` on `setup_intent.succeeded`.
5. On no-show (cron job runs 30min past start), API creates and captures a PaymentIntent against the stored payment method.

### C. No deposit (free booking)

No payment flow. Booking transitions straight to `confirmed` after widget submits.

## Acceptance criteria

- [ ] Webhook endpoint verifies Stripe signatures; rejects un-signed requests.
- [ ] Webhook handler is idempotent (use `stripe_event_id` as primary key in `stripe_events` table).
- [ ] All amounts stored in minor units (pence) with `currency` column.
- [ ] Refund endpoint on the dashboard; full refunds only via UI; partial refunds via API + reason log.
- [ ] Connect onboarding — each venue is guided through Stripe Connect onboarding before they can enable deposits.
- [ ] If Connect onboarding incomplete, deposit rules can't be saved.
- [ ] A test in CI verifies that no request body in our codebase ever carries a raw card number.

## Data model

```sql
create table stripe_accounts (
  id              uuid primary key default gen_random_uuid(),
  venue_id        uuid unique not null references venues(id) on delete cascade,
  account_id      text unique not null,      -- acct_xxx
  charges_enabled boolean not null default false,
  payouts_enabled boolean not null default false,
  updated_at      timestamptz not null default now()
);

create table deposit_rules (
  id         uuid primary key default gen_random_uuid(),
  venue_id   uuid not null references venues(id) on delete cascade,
  service_id uuid references services(id),
  min_party  int  not null default 1,
  max_party  int,
  day_of_week int[],
  amount_minor int not null,
  currency    char(3) not null default 'GBP',
  kind        text not null default 'per_cover' -- per_cover | flat
);

create table payments (
  id                   uuid primary key default gen_random_uuid(),
  booking_id           uuid not null references bookings(id) on delete cascade,
  stripe_intent_id     text unique not null,
  kind                 text not null,       -- 'deposit','hold','no_show_capture','refund'
  amount_minor         int not null,
  currency             char(3) not null,
  status               text not null,
  captured_at          timestamptz,
  refunded_at          timestamptz
);

create table stripe_events (
  id       text primary key,        -- evt_xxx
  type     text not null,
  received_at timestamptz not null default now(),
  handled  boolean not null default false
);
```

## Out of scope

- Apple Pay / Google Pay (Stripe handles automatically — nothing for us to do).
- Fraud scoring beyond Stripe Radar defaults.
- Custom payment splits between host and platform (not needed — Connect Standard handles payouts).
