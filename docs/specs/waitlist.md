# Spec: Walk-ins and waitlist

**Status:** shipped — schema + add/seat/cancel domain helpers + dashboard tab + waitlist_ready SMS template all live.
**Depends on:** `bookings.md`, `messaging.md`

## What we're building

Walk-in guests added to a digital waitlist with estimated wait time and SMS notification when a table is ready.

## User stories

- As a host I can add a walk-in in 5 seconds: party size, name, phone.
- As a host I can see the queue ordered by arrival time.
- As a host I can tap "seat now" when a table is available → waitlist entry becomes a `seated` booking.
- As a walk-in guest I receive an SMS with my estimated wait and another when my table is ready.

## Acceptance criteria

- [ ] `waitlists` table with minimal schema.
- [ ] Wait-time estimate = position × avg turn time, capped at 90 minutes.
- [ ] Seating a waitlist entry creates a `bookings` row with `source = 'walk-in'`.
- [ ] One-tap cancel removes entry and sends a goodbye SMS.

## Data model

```sql
create table waitlists (
  id           uuid primary key default gen_random_uuid(),
  venue_id     uuid not null references venues(id) on delete cascade,
  guest_id     uuid not null references guests(id),
  party_size   int not null,
  requested_at timestamptz not null default now(),
  status       text not null default 'waiting',  -- waiting|seated|left|cancelled
  seated_booking_id uuid references bookings(id)
);
```
