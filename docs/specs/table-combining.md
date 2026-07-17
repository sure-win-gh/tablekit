# Table combining (operator-controlled joins)

Status: draft — extends `bookings.md` (availability algorithm) and `floor-plan-visual.md`
(the setup surface). Supersedes the "same-area, no spatial adjacency" combining rule described
in `.claude/plans/bookings.md` D2.

## Why

Combining exists today but is implicit: the availability engine offers **any two tables that
share an `area_id`** as a joined booking (pairs only). That over-offers "across the room" pairs
and can't describe a real floor. Operators need to declare **which specific tables can be
physically pushed together**, and the engine must only ever offer combinations that are
genuinely seatable.

Two layouts drive the model (a flat "these N tables are a group" cannot express them):

- **Chain (1-2-3-4):** table 4 only reaches the group via table 3. If 3 is occupied, `{1,2,4}`
  must **not** be offered.
- **Hub (5-6-7-8):** if 7 is occupied, `{5,6,8}` must **still** be offered.

Both fall out of modelling combinability as an **adjacency graph** — an edge means "these two
tables can be pushed together" — and treating a valid combined booking as a **connected set of
currently-free tables** whose summed capacity fits the party.

## Product decisions

- **Same-area only (v1).** Every edge joins two tables in the same area, so a combined option
  has one `area_id` and the existing `bookings.area_id` invariant + `enforce_booking_tables_denorm`
  junction trigger are untouched. Cross-area joins are deferred.
- **Per-area, declared-edges-only.** An area **with** joins configured offers **only** the
  drawn combinations. An area with **no** joins keeps today's "any same-area pair" behaviour, so
  nothing regresses for venues that never configure this. Configuring an area is explicit (the
  operator is in "Set up table joins" mode drawing lines), not a silent flip.
- **Size cap.** `settings.tableCombining.maxTables` (default **3**), operator-adjustable per
  venue. Bounds enumeration and keeps offers realistic.
- **Combining stays a fallback.** A single sufficient table is always preferred; combinations
  are only offered when no single table fits (unchanged from today).
- **Visual, non-technical input.** Operators tap two tables on the floor plan to draw/remove a
  join line. Join lines are **hidden** unless in "Set up table joins" mode.

## Availability algorithm (updated)

```
for each candidate slot (every 15 min within the service window):
  free = tables not occupied at [slot_start, slot_start + turn_minutes]
  if a single free table fits (min_cover <= party <= max_cover) → offer smallest such single
  else, per area of the free tables:
    if the area has join edges → graph mode:
        offer each CONNECTED set of free tables (over the join edges), up to maxTables,
        whose sum(max_cover) >= party and max(min_cover) <= party
    else → legacy mode: offer any same-area pair that fits
  rank offered options by fewest tables, then least waste (smallest total max_cover that fits)
```

Lives in `lib/bookings/availability.ts` (pure, fully unit-tested). Legacy behaviour is
byte-identical when no edges are supplied.

## Data model

```sql
create table table_combinations (
  id              uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references organisations(id) on delete cascade, -- trigger-set
  venue_id        uuid not null references venues(id) on delete cascade,        -- trigger-set
  area_id         uuid not null references areas(id) on delete cascade,         -- trigger-set
  table_a_id      uuid not null references tables(id) on delete cascade,        -- canonical a < b
  table_b_id      uuid not null references tables(id) on delete cascade,
  created_at      timestamptz not null default now(),
  constraint table_combinations_pair_uq unique (table_a_id, table_b_id),
  constraint table_combinations_canonical check (table_a_id < table_b_id)
);
-- BEFORE INSERT/UPDATE trigger enforce_table_combinations_denorm(): looks up both tables'
-- org/venue/area, RAISEs if the two areas differ, and fills the denormalised columns from
-- table A. Deleting a table cascades away its edges.
-- RLS: member-read only (organisation_id in user_organisation_ids()); all writes via adminDb()
-- server actions.
```

Guardrail lives on `venues.settings` jsonb: `settings.tableCombining.maxTables` (no migration).

`bookings`, `booking_tables`, the `EXCLUDE USING gist` double-booking constraint, and the
junction same-area trigger are **unchanged** — `booking_tables` already stores N tables per
booking, so a 3-table combination books through the existing transactional path.

## Operator UX

On the floor plan (`app/(dashboard)/dashboard/venues/[venueId]/floor-plan/`), which already
scopes the canvas to one area at a time:

- Manager-gated, desktop-only toggle **"Set up table joins"** in the canvas toolbar (alongside
  "Edit", mutually exclusive).
- Join lines render **only** in this mode. Tap table A → tap table B → toggle the join; tap an
  existing line to remove it.
- Plain-language help: *"Draw a line between tables you can push together to seat bigger groups.
  We'll only offer a combined table when every linked table in it is free."* Empty state: *"No
  joins set up here yet — tables in this area combine in pairs automatically. Draw lines to take
  control."*
- A number field *"Most tables you'd ever push together"* (default 3), persisted to
  `settings.tableCombining`.

## Acceptance criteria

- [ ] `table_combinations` table with canonical-pair uniqueness, same-area denorm trigger, and
      member-read RLS. Cross-tenant isolation proven in `tests/integration/`.
- [ ] Engine offers connected free-table sets in a configured area; chain scenario A and hub
      scenario B are encoded as unit tests in `tests/unit/bookings-availability.test.ts`.
- [ ] Per-area mode: an area without edges still auto-pairs; wiring one area doesn't disable
      combining in another.
- [ ] Empty-`combinable` path is behaviourally identical to today (regression test).
- [ ] Offered combinations respect `maxTables`, the `min_cover` floor, and fewest-tables /
      least-waste ranking.
- [ ] Operator can draw/remove joins visually; lines are hidden outside "Set up table joins".
- [ ] A combined option books through the existing transactional path and is protected by the
      GIST double-booking constraint.

## Known limitations (deferred)

- **Branched topologies** (L/star): a connected set may not seat one party in a line. Bounded
  by the size cap + least-waste ranking; left to operator judgement in v1.
- **No seat-loss on join** — capacity is `sum(max_cover)`; pushing two 2-tops that really seats
  3 is not modelled.
- **Same-area only** — a physical row spanning two areas can't be joined until the cross-area
  follow-up (reworks `bookings.area_id` + the junction trigger).

> **Security invariant (do not remove without care):** tenant isolation on `table_combinations`
> rests on the `enforce_table_combinations_denorm` trigger's same-area assertion. Because an area
> belongs to exactly one venue and one org, "both tables share an area" transitively guarantees
> same-venue and same-org. If a future migration loosens this to allow cross-area (or cross-venue)
> joins, that transitive guarantee breaks and the trigger must gain an explicit same-org assertion.
