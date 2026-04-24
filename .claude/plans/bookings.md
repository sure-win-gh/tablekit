# Plan: bookings

Spec: [docs/specs/bookings.md](../../docs/specs/bookings.md). Depends on `auth` (shipped), `venues` (shipped), `guests` (not yet) and `payments` (not yet).

This is the core transaction the whole product exists for. Every other phase orbits it. It's also the first phase that touches real guest PII, which forces a decision about prerequisites before any code lands.

---

## The ordering problem (read this first)

The stated MVP order was `auth → venues → bookings → widget → payments → messaging → guests`. That order doesn't survive contact with the spec: `bookings.guest_id` is a foreign key to `guests.id`, and every guest row stores column-encrypted PII (email, phone, last name, DoB, notes) via `lib/security/crypto.ts` — a module that is **currently a throwing stub** pending the envelope-encryption design review.

Three forks, my recommendation marked:

| Approach | Verdict |
|---|---|
| **(a)** Ship `bookings` + stub guest table with plaintext PII, encrypt later | **No.** Any real guest data touching this table is an instant GDPR incident. One-way door. |
| **(b)** Do the big-bang phase: crypto + full guests + bookings in one go | **No.** 40+ commits, un-reviewable diff, and the full `guests` CRM (tags, consent, DSAR, search UI) isn't needed to unblock bookings — just the data layer is. |
| **(c)** Two small prerequisite phases, then bookings — **recommended** | Split `guests` into a minimal "data layer only" phase that unblocks bookings, then stack bookings on top. Crypto goes first. Three small, reviewable phases instead of one unshippable one. |

**Recommended revised order:**

```
✅ auth    ✅ venues    → crypto    → guests-minimal    → bookings    → widget    → payments    → messaging    → guests-crm    → waitlist    → rwg    → reporting
                         NEW         NEW (split)                                                  (replaces `guests`)
```

- **`crypto`** — real envelope encryption in `lib/security/crypto.ts`. Per-org data key wrapped by a master key in Supabase Vault (or env-file for dev). AES-256-GCM. `hashForLookup(email, orgId)` with per-org salt. Unit-tested against known vectors.
- **`guests-minimal`** — `guests` table with the encrypted PII columns, one RLS policy, `findByEmailHash`, `createGuest`, and a cross-tenant test. No UI, no tags, no consent flows, no erasure button. Those land in `guests-crm` later.
- **`bookings`** (this plan) — assumes the above two are in place and consumes them via typed helpers.

**This plan is for `bookings` specifically.** It assumes `crypto` and `guests-minimal` are in place. I'd want a green light to draft the `crypto` plan next, then `guests-minimal`, then execute all three in order. If you want to read the full `bookings` plan anyway — the data model, the availability engine, the state machine — it's below.

---

## Scope of this phase vs follow-ups

| Phase | What ships |
|---|---|
| **`bookings` (this plan)** | `bookings` + `booking_events` schema, denormalised `organisation_id` + triggers, RLS, the pure `availability.ts` engine with 100% unit coverage, state machine helper, **host-side** manual create + read + state-transition actions, a "today's bookings" dashboard page per venue, integration tests (cross-tenant + state machine), e2e smoke. |
| `widget` (next in MVP order) | Public `/api/v1/bookings` POST endpoint, anonymous guest upsert, rate limiting via Upstash, the actual guest-facing booking UI at `book.tablekit.uk`. |
| `payments` | Deposit capture (Stripe Elements + PaymentIntent), `deposit_intent_id` wired, no-show capture cron, refund flow. |
| `messaging` | Transactional emails/SMS on confirm / cancel / reminder; guest-cancel tokenized link; Resend + Twilio. |
| `bookings-availability-v2` (maybe) | Materialised availability cache if real-time slot search proves too slow. Probably never needed for MVP scale. |

Keeping the public API out of this phase is deliberate: hosts should be able to take phone / walk-in bookings first. Exposing the anonymous endpoint to the internet is a separate security surface (rate limits, CAPTCHA, abuse monitoring) and belongs with the widget.

---

## Architectural decisions

### D1. Availability engine: real-time, pure, in-memory

**Proposal:** `lib/bookings/availability.ts` exports `findSlots({ venueId, date, partySize })` that returns a list of `{ startAt, endAt, tableIds }`. It runs at request time, reads services + tables + existing-bookings-for-the-day in three queries, and computes slots in memory. Pure function — no DB inside the slot loop, all the work happens on arrays.

At MVP scale:

- 1 venue × 50 tables × 14-hour service × 15-min slots = 56 slots × 50 tables × (maybe) 100 existing bookings/day. Millisecond work.
- Three queries up front; one response.
- No caching. Add caching when we measure a problem.

**Alternative considered — precomputed availability table**: slot-by-slot rows maintained by triggers or a cron. Avoids recompute. Costs a write-amplification on every booking mutation and a cache-invalidation story nobody wants. Defer until a real customer tells us it's slow.

**Testing:** unit-tested with fixture inputs — "one-service café, no existing bookings", "fully booked", "single combinable gap", "party size > any table". Spec requires 100% coverage on this file; easy to hit given the function is pure.

### D2. Combinable tables: same-area, no spatial adjacency

**Proposal:** two tables are "combinable" iff they live in the same `area_id`. No x/y adjacency check.

The spec says "same area, adjacent", but "adjacent" needs spatial reasoning against the `position` jsonb which our form-based floor plan doesn't maintain reliably. MVP substitute: operators arrange areas so tables within an area genuinely can combine (e.g., a long bench or two nearby 2-tops). If they need finer control, they create smaller areas.

Future (not this phase): a `tables.combinable_with uuid[]` column that operators set explicitly — more operator work, perfect control. Or spatial adjacency from `position` once we have a drag-drop editor with meaningful coordinates.

### D3. State machine: encoded in TS, enforced at write, audited in `booking_events`

**Proposal:** `lib/bookings/state.ts` exports:

```ts
type BookingStatus =
  | "requested" | "confirmed" | "seated" | "finished" | "cancelled" | "no_show";

const TRANSITIONS: Record<BookingStatus, BookingStatus[]> = {
  requested:  ["confirmed", "cancelled"],
  confirmed:  ["seated", "cancelled", "no_show"],
  seated:     ["finished"],
  finished:   [],
  cancelled:  [],
  no_show:    [],
};

export function assertTransition(from: BookingStatus, to: BookingStatus): void { /* throws on invalid */ }
```

Every status change goes through a `transitionBooking(bookingId, to)` server action that:

1. Reads current status (inside the transaction).
2. `assertTransition(current, to)` — throws `InvalidTransitionError` on mismatch.
3. Updates the booking.
4. Inserts a `booking_events` row with `{ type: `status.${to}`, meta: { from } }`.

Terminal states (`finished`, `cancelled`, `no_show`) have empty transition arrays — nothing follows them. Unit-tested.

### D4. Denormalised `organisation_id` (and `venue_id`) on both new tables

**Proposal:** same pattern as `venues`:

- `bookings.organisation_id` + `bookings.venue_id` — backfilled from `service_id` (service → venue → org) via a trigger.
- `booking_events.organisation_id` + `booking_events.booking_id` — backfilled from parent booking via a trigger.

RLS policies stay one-hop equality. Policy template is already established.

### D5. Postgres exclusion constraint for double-booking prevention

**Proposal:** keep the spec's constraint verbatim:

```sql
exclude using gist (table_id with =, tstzrange(start_at, end_at) with &&)
```

Requires `btree_gist` extension for the `with =` operator class on uuid. Enable in the migration. Trade-off: writes that violate it throw a specific Postgres error we catch and turn into a domain `SlotTakenError`. This is more reliable than application-level "check before write" because it survives concurrent writers.

**Important wrinkle:** the constraint only applies when `table_id` is not null. `requested` bookings (awaiting deposit) and walk-ins where a table hasn't been chosen yet can carry `table_id = NULL` — Postgres exclusion constraints skip nulls by default. Fine.

### D6. Host-only creation in this phase; public API lives with `widget`

**Proposal:** the server action to create a booking in this phase is **host-side only**: `requireRole("host")` or higher, called from a dashboard form. It still creates a `guests` row via the `guests-minimal` helpers (upsert by `email_hash`), but the calling context is an authenticated operator recording a phone booking or walk-in.

The spec's `POST /api/v1/bookings` for anonymous widget traffic is deferred to the `widget` phase — same create path, different auth gate (rate-limited + CAPTCHA, no org session).

Reasons to split:

- Rate limiting (Upstash) and CAPTCHA (hCaptcha) are a moving surface and belong with the UI that actually needs them.
- A host manually recording bookings is the biggest day-one operator win — they can stop using their paper diary the moment this ships.

### D7. Deposits deferred to `payments`

**Proposal:** `deposit_intent_id` column exists but stays null in this phase. Services with a `requires_deposit` flag (not in the current schema — lands with `payments`) can't be created yet. Booking state starts at `requested` only if we add a deposit flow; for now, host-created bookings go straight to `confirmed`.

No Stripe code in this phase.

### D8. Time handling: store UTC, display in venue timezone

**Proposal:** `start_at` / `end_at` are `timestamptz`, stored UTC. The availability engine takes a `date` (local calendar date in the venue's timezone), explodes it into slots, converts to UTC for storage and comparison. Display everywhere formats with `Intl.DateTimeFormat(venue.locale, { timeZone: venue.timezone })`.

Helper: `lib/bookings/time.ts` with `venueLocalDayRange(date, timezone) → [startUtc, endUtc]` and `formatForVenue(dateUtc, venue)`.

DST transitions: `tstzrange` + UTC means the two-day-a-year wobble is handled correctly at the range level; display will show the local wall-clock time the operator expects.

### D9. Out of scope for this phase (explicit)

- Public `/api/v1/bookings` (→ `widget` phase).
- Rate limiting / Upstash wiring (→ `widget`).
- Deposit capture, no-show automatic capture, refunds (→ `payments`).
- Outbound confirmation / cancellation emails + SMS (→ `messaging`).
- Guest-cancel tokenized link (→ `messaging`).
- Full guest CRM — tags, consent UI, DSAR, erasure button, search page (→ `guests-crm`).
- Walk-in + waitlist flows (→ `waitlist`).
- Recurring bookings, group bookings across multiple tables (not on the MVP roadmap).
- Floor-plan-with-live-bookings-overlay (→ follow-up `venues-floor-plan` plus a booking-overlay phase).

---

## Data model (this phase)

```sql
create type booking_status as enum
  ('requested','confirmed','seated','finished','cancelled','no_show');

create extension if not exists btree_gist;  -- gist `with =` on uuid

create table bookings (
  id                 uuid primary key default gen_random_uuid(),
  organisation_id    uuid not null,          -- denormalised; trigger
  venue_id           uuid not null,          -- denormalised; trigger
  service_id         uuid not null references services(id),
  area_id            uuid not null references areas(id),
  guest_id           uuid not null references guests(id),
  party_size         int  not null check (party_size between 1 and 20),
  start_at           timestamptz not null,
  end_at             timestamptz not null,
  status             booking_status not null default 'confirmed',
  source             text not null,         -- 'host' | 'widget' | 'rwg' | 'api'
  deposit_intent_id  text,                  -- stays null until payments phase
  notes              text,                  -- host-authored; plaintext for now
  booked_by_user_id  uuid references users(id) on delete set null,
  cancelled_at       timestamptz,
  cancelled_reason   text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

-- Junction. One row per (booking, table). The denormalised time range
-- + org/venue/area keep RLS one-hop and let the EXCLUDE constraint do
-- the real work of preventing double-booking.
create table booking_tables (
  booking_id       uuid not null references bookings(id) on delete cascade,
  table_id         uuid not null references tables(id),
  organisation_id  uuid not null,           -- denormalised; trigger
  venue_id         uuid not null,           -- denormalised; trigger
  area_id          uuid not null,           -- denormalised; trigger
  start_at         timestamptz not null,    -- denormalised; sync trigger
  end_at           timestamptz not null,    -- denormalised; sync trigger
  primary key (booking_id, table_id),
  constraint no_double_book
    exclude using gist (table_id with =, tstzrange(start_at, end_at, '[)') with &&)
);

create table booking_events (
  id               uuid primary key default gen_random_uuid(),
  organisation_id  uuid not null,          -- denormalised; trigger
  booking_id       uuid not null references bookings(id) on delete cascade,
  type             text not null,
  actor_user_id    uuid references users(id) on delete set null,
  meta             jsonb not null default '{}',
  created_at       timestamptz not null default now()
);
```

Triggers:

- `enforce_bookings_org_and_venue` — BEFORE INSERT/UPDATE OF service_id/area_id on bookings: copy org/venue from service, verify area belongs to the same venue.
- `enforce_booking_tables_denorm` — BEFORE INSERT on booking_tables: copy org/venue/area/start_at/end_at from the parent booking. RAISE EXCEPTION if the table's area differs from the booking's area (enforces same-area combinable rule).
- `sync_booking_tables_on_time_change` — AFTER UPDATE OF start_at/end_at on bookings: propagate to booking_tables.
- `clear_booking_tables_on_cancel` — AFTER UPDATE OF status on bookings: if NEW.status = 'cancelled', delete from booking_tables where booking_id = NEW.id. (no_show is terminal-after-time so the junction row doesn't need clearing.)
- `enforce_booking_events_org_id` — BEFORE INSERT/UPDATE OF booking_id: copy org_id from the parent booking.

RLS: `*_member_read` on bookings / booking_tables / booking_events. No insert/update/delete policies for authenticated — writes go via server actions on adminDb.

---

## Tasks (ordered, each its own commit)

1. **`feat(bookings): drizzle schema + booking_status enum`**
   - Extend `lib/db/schema.ts` with `bookingStatus` pgEnum, `bookings`, `bookingEvents`.
   - Add relations to schemas it FKs into (guests, services, tables).

2. **`feat(bookings): migration — tables, triggers, RLS, exclusion constraint`**
   - `pnpm db:generate`, then hand-append: `create extension btree_gist`, the two `enforce_*` triggers, RLS enable + read policies, and the `no_double_book` exclusion constraint.

3. **`feat(bookings): pure availability engine`**
   - `lib/bookings/availability.ts` — `findSlots({ venueId, date, partySize })` with the in-memory algorithm.
   - `lib/bookings/time.ts` — `venueLocalDayRange`, `formatForVenue`.
   - Unit tests covering every spec-listed case (empty day, fully booked, combinable, min/max cover bounds, turn time). Coverage set to 100% on these two files via vitest's `--coverage` threshold.

4. **`feat(bookings): state machine helper`**
   - `lib/bookings/state.ts` — `BookingStatus`, `TRANSITIONS`, `assertTransition`. Exports a typed `InvalidTransitionError`.
   - Unit tests that enumerate every pair and assert the transition-matrix matches the spec diagram.

5. **`feat(bookings): create + transition server actions`**
   - `app/(dashboard)/dashboard/venues/[venueId]/bookings/actions.ts`:
     - `createBooking` — Zod boundary, `requireRole("host")`, guest upsert via `lib/guests/helpers.ts` (from `guests-minimal`), availability re-check inside the transaction (belt + braces), exclusion-constraint violation → `SlotTakenError`, insert booking at `confirmed` state, audit `booking.created`, insert initial `booking_events` row.
     - `transitionBooking` — `requireRole("host")`, `assertTransition`, update, insert event, audit.

6. **`feat(bookings): host-side today's-bookings dashboard page`**
   - `app/(dashboard)/dashboard/venues/[venueId]/bookings/page.tsx` — RSC listing today's bookings in venue-local time, grouped by service, showing status + party + guest first name. Query keeps guest PII hash-based — first name is plaintext, everything else is decrypted only for the owning org via `lib/security/crypto.ts`.
   - Status-transition buttons (Confirm / Seat / Finish / Cancel / No-show) call `transitionBooking`.

7. **`feat(bookings): new-booking form`**
   - `app/(dashboard)/dashboard/venues/[venueId]/bookings/new/*` — page + form + action.
   - Fields: date, time, party size, guest (name / email / phone — upsert), optional notes. Shows available slots after party + date are chosen.

8. **`feat(bookings): link from venue layout nav`**
   - Add "Bookings" tab between "Floor plan" and "Services" in the `[venueId]/layout.tsx` tabs.

9. **`test(bookings): integration — cross-tenant + double-booking + state transitions`**
   - Cross-tenant: user A never sees org B's bookings or events.
   - Exclusion constraint: two concurrent inserts for the same table + overlapping ranges — one succeeds, the other rejects with the PG error that maps to `SlotTakenError`.
   - Transitions: every valid pair succeeds + writes a `booking_events` row; every invalid pair throws.
   - Trigger enforcement: deliberate wrong `organisation_id` on booking + `booking_events` inserts, verify the trigger fixes both.

10. **`test(e2e): host creates and confirms a booking`**
    - Seed user + org + venue + service + table + a single guest via admin API / raw SQL.
    - UI flow: navigate `/bookings/new`, pick date / party / slot, fill guest details, submit, land on bookings list, mark seated, mark finished. Assert audit + state at each step.

---

## Decisions locked (as of execution)

1. ✅ **Three-phase split approved** — `crypto` and `guests-minimal` have shipped. This plan now drives execution.
2. ✅ **Combinable tables: same-area-only**. Implementation: a `booking_tables` junction (booking × table), with denormalised `starts_at` / `ends_at` for the `EXCLUDE USING gist` constraint. A CHECK pattern (via a trigger) enforces all tables in a single booking share one `area_id`. This upgrades D2's availability-engine stance with the corresponding schema reality.
3. ✅ **Host-only creation** this phase. Widget phase owns the public path.
4. ✅ **Deposits deferred to `payments`**. Host-created bookings go straight to `confirmed`. The state machine still reserves `requested` so deposits can slot in later without a migration.
5. ✅ **Store UTC, render venue-local**. Helper lives in `lib/bookings/time.ts`.
6. ✅ **Party-size cap: 20**. Private-events / large-party workflow (set menus, deposit forfeit) is a separate phase.
7. ✅ **Silent guest upsert** — already implemented in `guests-minimal`. The `new-booking` form calls `upsertGuest` directly.
8. ✅ **Master key: `TABLEKIT_MASTER_KEY` env var**. Vault / KMS migration is a production-hardening phase; `lib/security/crypto.ts` public API stays stable.

## Exit criteria

- Host can sign in, navigate to a venue, click "Bookings", create a booking for a specific service / time / party, and see it in the day list. Subsequent clicks mark it through the state machine.
- No Postgres-level double-booking possible for a given table + time range. Integration test proves it under concurrent writes.
- `pnpm check:rls`: 10 tables, all green (8 existing + 2 new).
- `pnpm test` unit coverage: 100% on `lib/bookings/availability.ts` and `lib/bookings/state.ts`.
- `pnpm test:integration`: cross-tenant + exclusion + state transitions all pass.
- `pnpm test:e2e`: create-and-progress smoke passes.
- `gdpr-auditor` subagent runs clean — every guest PII touchpoint goes through the `crypto` module.

---

## Next after this

`widget` — the guest-facing booking UI + public API + rate limits. Inherits `availability.ts` and the create path from here; adds the anonymous flow.
