# Spec: Bookings (availability, create, state machine)

**Status:** shipped
**Depends on:** `auth.md`, `venues.md`, `guests.md`, `payments.md` (for deposits)

## What we're building

The core transaction: a guest wants a table at a time; we check availability against services, tables, turn times and existing bookings; we create a booking; we track its lifecycle through seating to completion.

## State machine

```
requested → confirmed → seated → finished
     ↘         ↘          ↓
      cancelled  no_show
```

- `requested` — created via widget but awaiting deposit capture (if required).
- `confirmed` — deposit captured or not required; SMS/email confirmation sent.
- `seated` — host has marked guests on the table.
- `finished` — service complete.
- `cancelled` — guest or host cancelled. If inside deposit cut-off, deposit is captured.
- `no_show` — past start time + grace period. Triggers deposit capture where applicable.

## Availability algorithm

```
for each candidate slot (every 15 min within the service window):
  needed_capacity = party_size
  find tables with min_cover <= party_size <= max_cover
  exclude tables occupied at [slot_start, slot_start + turn_minutes]
  if a single table fits → offer slot
  if combinable tables exist (same area, adjacent) → offer slot
```

Keep this in `lib/bookings/availability.ts`. Must be pure, well-tested, O(services × tables × slots) at worst.

## User stories

- As a guest on the widget I enter party size, date, time preference; I see offered slots.
- As a guest I submit name, email, phone, any notes, and confirm.
- If the service requires a deposit, I enter card details in Stripe Elements before the booking confirms.
- As a host I can see today's bookings laid on the floor plan with statuses.
- As a host I can mark a booking `seated` / `finished` / `no_show` with one click.

## Acceptance criteria

- [x] Public `POST /api/v1/bookings` endpoint accepts anonymous creation. Implemented at [`app/api/v1/bookings/route.ts`](../../app/api/v1/bookings/route.ts) — body validated by zod, no auth required.
- [x] Availability endpoint returns slots in the venue's timezone (wall-clock) AND UTC ISO timestamps. [`app/api/v1/availability/route.ts`](../../app/api/v1/availability/route.ts) — every slot carries `start_at` (UTC ISO) plus `wall_start` (venue-local).
- [x] Booking creation is transactional — guest record + booking + table assignments + (when required) deposit intent commit together. [`lib/bookings/create.ts`](../../lib/bookings/create.ts) wraps the writes in `db.transaction(async (tx) => …)`; deposit requirement is resolved before the transaction so a failed Stripe intent can roll the row back.
- [x] Double-booking prevented by a Postgres `EXCLUDE USING gist` constraint on `(table_id, tstzrange(start_at, end_at, '[)'))`. Migration 0004 (`busy_the_watchers`) — sits on `booking_tables`, the junction table that holds the `(booking, table)` assignments.
- [x] State transitions are enforced in code; invalid transitions return a typed `{ ok: false; reason: "invalid-transition" }` result. [`lib/bookings/transition.ts`](../../lib/bookings/transition.ts) — caller is the HTTP / server-action boundary which translates the result to a 409 / error toast.
- [x] Every state transition appends a row to `booking_events`. Same `transition.ts` writes the event inside the same transaction as the status flip, so a partial transition can't leave the audit out of sync.
- [x] RLS — organisation members can only read bookings for their own org's venues (and per-venue scoped roles see only their permitted venues). Verified by [`tests/integration/rls-bookings.test.ts`](../../tests/integration/rls-bookings.test.ts).
- [x] Public booking endpoint rate-limited: per-IP (5 / 10 min) AND per-email (3 / hour, hashed). Cloudflare adds the anonymous network layer; the app enforces both via `lib/public/rate-limit.ts` from inside `app/api/v1/bookings/route.ts`.
- [x] Test coverage on `availability.ts` — unit suite at [`tests/unit/bookings-availability.test.ts`](../../tests/unit/bookings-availability.test.ts) (209 lines covering 175 lines of source). Integration coverage in `tests/integration/api-v1-availability.test.ts`.

## Data model

```sql
create type booking_status as enum
  ('requested','confirmed','seated','finished','cancelled','no_show');

create table bookings (
  id              uuid primary key default gen_random_uuid(),
  venue_id        uuid not null references venues(id) on delete cascade,
  service_id      uuid not null references services(id),
  guest_id        uuid not null references guests(id),
  table_id        uuid references tables(id),
  party_size      int not null check (party_size >= 1),
  start_at        timestamptz not null,
  end_at          timestamptz not null,
  status          booking_status not null default 'requested',
  source          text not null,      -- 'widget','rwg','phone','walk-in','api'
  deposit_intent_id text,             -- Stripe payment intent id
  notes           text,
  created_at      timestamptz not null default now(),
  exclude using gist (table_id with =, tstzrange(start_at, end_at) with &&)
);

create table booking_events (
  id         uuid primary key default gen_random_uuid(),
  booking_id uuid not null references bookings(id) on delete cascade,
  type       text not null,
  meta       jsonb not null default '{}',
  created_at timestamptz not null default now()
);
```

## Out of scope

- Multi-resource bookings (rooms + tables). We are a table booking product.
- Fine-grained seat assignment within a table.
