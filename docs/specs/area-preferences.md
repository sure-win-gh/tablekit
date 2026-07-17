# Spec: Area preferences & area availability

**Status:** in progress — engine layer first, UI second
**Depends on:** `venues.md`, `bookings.md`, `booking-page.md`, `widget.md`, `special-events.md` (§Area-scoped events — this feature reuses its closure machinery).

## What we're building

Two sides of the same coin, both riding the area-scoped `ClosureWindow`
machinery shipped with special events:

1. **Guest area preference (widget + hosted page).** A diner who wants the
   terrace (or wants to avoid it) can pick an area on the Time step and see
   only slots with a table there; the booking is then guaranteed to be
   assigned in that area.
2. **Operator area availability.** A venue can mark an area seasonally closed
   ("Outside: closed Nov–Mar") or flip it off ad hoc ("terrace shut today —
   raining"). Blocked areas simply drop out of standard availability; other
   areas book normally.

## Decisions & invariants

- **One engine path.** Area availability compiles into the same
  `ClosureWindow { startAt, endAt, areaIds }` list that event closures use;
  `findSlots` needs no new concepts. Sources stay separate at the loader
  layer: event closures also feed the calendar's `events` deep-link map;
  area-availability closures NEVER do (a rainy-day terrace closure is not an
  event and must not render a banner or event day).
- **Data model = two columns on `areas`** (no new table):
  `bookable boolean not null default true` (the ad-hoc kill switch — off =
  closed until the operator reopens it) and
  `closed_months int[] not null default '{}'` (1–12, venue-local months;
  "winter" = `{11,12,1,2,3}`). Both default to today's behaviour.
- **Months, not date ranges, for v1.** Matches the actual ask ("winter
  months") and gives a 12-chip UI. Date-range windows are a later layer if
  operators ask.
- **Preference is a guarantee, not a hint.** When a guest picks an area, the
  offered slots are filtered to it and `createBooking` assigns only from that
  area's options — if it's gone by submit time the booking fails
  (`no-availability`) rather than silently seating them elsewhere. After
  booking, `reassign.ts` already enforces same-area moves, so the preference
  survives host-side reshuffles for free.
- **Never auto-cancel.** Closing an area (either mechanism) blocks NEW
  bookings only; existing bookings in the area stay and the operator handles
  them — same posture as event publishing.
- **Chips, not a wizard step.** The preference UI is filter chips on the Time
  step ("Any · Inside · Terrace"), derived from the areas that actually have
  a free table that day — so a winter-closed terrace never renders as a
  chip. No `deriveStep` change; `area` is an optional URL param.
- **Ungated.** Core booking UX, all tiers (like the rest of the widget flow).
- **Known nuance:** a day where EVERY area is blocked classifies as `full`
  (not `closed`) on the month calendar — acceptable for v1; `closed` remains
  "no service scheduled".

## Data model (delta)

```sql
alter table areas add column bookable boolean not null default true;
alter table areas add column closed_months integer[] not null default '{}';
-- months are 1–12
alter table areas add constraint areas_closed_months_check
  check (closed_months <@ array[1,2,3,4,5,6,7,8,9,10,11,12]);
```

## Engine

- `lib/bookings/area-availability.ts` — pure, unit-tested:
  `areaAvailabilityClosures(areas, days)` where `days` is the venue-local day
  list `{ ymd, startUtc, endUtc }`. For each day × area: `!bookable` ⇒ closure
  window for that day; `month(ymd) ∈ closed_months` ⇒ same. Emits
  `ClosureWindow`s with `areaIds: [areaId]`.
- Loaders (`loadPublicAvailability`, `loadPublicMonthAvailability`,
  `createBooking`) load the venue's areas alongside tables and concat these
  windows onto the event closures before calling `findSlots`.
- `loadPublicAvailability` gains `areaId?` (filter each slot's options to the
  area; drop slots with none) and returns per-slot `areaIds` + a top-level
  `areas: {id, name}[]` list (areas with ≥1 slot that day) for the chips.
- `createBooking` gains `preferredAreaId?` — options filtered to the area
  before first-fit; empty ⇒ `no-availability`.
- `/api/v1/availability` accepts `area_id`; `POST /api/v1/bookings` accepts
  `preferredAreaId` (both optional, validated as uuid).

## Surfaces (second tranche)

- **Widget Time step:** area chips (rendered only when ≥2 areas have slots);
  choice carried in the `area` URL param and posted as `preferredAreaId`.
- **Floor plan / areas UI:** per-area "Open/Closed" toggle (the weather
  switch) + closed-months chips. Server action `updateAreaAvailability`
  (`requireRole("manager")`, venue-scoped).
- Booking detail/floor views need no change — `bookings.area_id` already
  records where the party sits.

## Build checklist

### A. Engine (backend)
- [ ] Migration `0064_area_availability` + `areas.bookable` /
      `areas.closed_months` in `schema.ts`.
- [ ] `lib/bookings/area-availability.ts` + unit tests (bookable off, closed
      month, open month, timezone day boundaries, both-defaults ⇒ no windows).
- [ ] Wire all three loaders; area windows NEVER enter the calendar `events`
      map.
- [ ] `loadPublicAvailability` `areaId` filter + `areaIds`/`areas` in the
      response; `createBooking.preferredAreaId`; API params.

### B. Surfaces
- [x] Time-step chips ("Any area" + per-area, rendered only when ≥2 areas
      have slots; selected chip inverts) + `area` as a validated wizard param
      (uuid, time-step onwards, clear-forward like `month`; carried on slot
      links + the UUID→slug redirect) + `preferredAreaId` posted by
      `BookingForm`. Empty state copy nudges "another area".
- [x] Operator per-area availability UI on the floor plan (manager-only card
      under the canvas): Taking-bookings/Closed toggle + Jan–Dec closed-month
      chips per area → `updateAreaAvailability` server action (venue-scoped,
      `requireRole("manager")`). No audit log — consistent with the sibling
      area actions (create/update/delete don't audit either).
- [x] Regression: all-defaults venue behaves byte-identically
      (`areaAvailabilityClosures` defaults-emit-nothing unit pin).

**Verification note:** engine (tranche A) test-verified by Ben. Tranche B
edits landed via confirmed diffs but the local workspace VM was offline for
the lint/test sweep — run `pnpm typecheck && pnpm lint && pnpm test` before
merge.

## Out of scope

- Date-range closures (months + kill switch only, v1).
- Per-area pricing/deposits; per-table preference; preference on host flow
  (hosts already pick tables directly).
- Auto-reopen by weather API (operators flip the switch).
