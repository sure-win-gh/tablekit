# Spec: Timeline view of bookings

**Status:** draft (not started — gap in `bookings.md`)
**Depends on:** `bookings.md`, `venues.md`

## What we're building

A row-per-table, columns-as-time view of today's bookings. The host's "what's happening on my floor right now" tool — at-a-glance who's seated where, what's coming up next, and where the next free slot is.

OpenTable, Resy, and Collins all ship a version of this; for our operators it's the second-most-used screen after the bookings list.

## User stories

- As a host I want to see one row per table with bookings as time-blocks across the row, so I can scan availability for the next free 90 min.
- As a host I want to drag a booking block to a different table (same area, capacity ≥ party) and have it persist via `reassignBookingTable`.
- As a host I want a "now" indicator that updates without a full reload.
- As a host I want to see status colour on each block (confirmed / seated / finished / no-show / cancelled).
- As a host I want to switch between days via the same `?date=` query param the bookings list uses.

## Acceptance criteria

- [ ] New route `/dashboard/venues/[id]/timeline?date=YYYY-MM-DD` (next to `/bookings` in the venue tab nav).
- [ ] Reuses existing `lib/bookings/time` for venue-zone bucketing.
- [ ] Reuses existing `bookings + booking_tables + tables + areas` queries — no new domain helpers.
- [ ] Rows grouped by area (with sticky area headers); tables ordered by label within an area.
- [ ] Drag-to-reassign uses the existing `reassignBookingTable` server action.
- [ ] No new tables, no new migrations.
- [ ] Mobile breakpoint: collapse to the existing list view rather than try to fit timeline on a phone.

## Open questions (resolve in plan-phase)

- Time window: full venue service span (e.g. 11:00–23:00) or rolling ±4h around now? Probably the former — operators want to glance at the dinner pre-shift.
- 15-min granularity for column ticks or 30-min? Match availability engine (15) for consistency.
- Multi-table bookings (8-top on 4+4): show as a wide block spanning rows, or duplicate per table with a "linked" indicator? Pick one.
- Drag-and-drop library: `@dnd-kit/core` is the React-friendly modern option. Or build with HTML5 native dragstart/drop. Decide before planning.

## Out of scope (initial cut)

- Timeline editing (resize a block to extend turn time) — separate phase, needs schema for guest-actual departure time.
- Cross-day rollovers (a 23:00 booking that runs to 01:00 next day) — render as truncated at midnight; full handling is a polish slot.
- Print / export.
