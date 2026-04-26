# Spec: Timeline view of bookings

**Status:** shipped (2026-04-26)
**Depends on:** `bookings.md`, `venues.md`

## What we're building

A row-per-table, columns-as-time view of today's bookings. The host's "what's happening on my floor right now" tool — at-a-glance who's seated where, what's coming up next, and where the next free slot is.

## What shipped

- Route `/dashboard/venues/[id]/timeline?date=YYYY-MM-DD` next to `/bookings` in the sidebar.
- CSS-grid layout — one row per table, 4 columns per hour (15-min granularity). Day window derived from the venue's services (min start, max end, rounded to whole hours; falls back to 09:00–23:00 with no services).
- Status drives block fill: amber (requested) / blue (confirmed) / emerald (seated) / neutral (finished) / rose (no-show) / stone strike-through (cancelled).
- "Now" indicator — 1px coral vertical line at the current venue-local time. Refreshes on page load (no auto-tick).
- Multi-table bookings render once per occupied row.
- Drag-to-reassign — pick up an active block, drop on another row in the same area → calls `reassignBookingTable` via `reassignFromTimeline` server action. Same-area enforcement client-side (different-area rows dim during drag) + server-side (the existing `enforce_booking_tables_denorm` trigger). Errors surface inline on the row label briefly.
- Click any block → `/bookings` list view for the same date (single-block detail view is a future polish slot).
- Mobile: timeline grid is `min-w-[900px]` inside an `overflow-x-auto` wrapper; "List view" button next to the date nav as the manual fallback.

## Surfaces

- `app/(dashboard)/dashboard/venues/[venueId]/timeline/page.tsx` — server-rendered shell + grid.
- `app/(dashboard)/dashboard/venues/[venueId]/timeline/forms.tsx` — `TimelineDateNav`, `TimelineDragProvider`, `TimelineRow`, `BookingBlock` clients.
- `app/(dashboard)/dashboard/venues/[venueId]/timeline/actions.ts` — `reassignFromTimeline` plain-args server action wrapping `reassignBookingTable`.

## Out of scope (post-ship)

- **Resize a block** to extend turn time — needs schema for guest-actual departure time.
- **Cross-day rollovers** (a 23:00 booking that runs to 01:00 next day) — currently render truncated at the window end.
- **Per-block detail popover / side panel** — clicks bounce out to the bookings list; an inline detail card would let hosts action without leaving the timeline.
- **Live "now" indicator** — server-snapshot only today; a small client poller (or Supabase realtime) would tick the line.
- **Print / export.**
- **Mobile auto-redirect** to the list view at narrow widths — manual button works for now.
