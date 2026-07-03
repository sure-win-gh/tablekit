# Spec: Timeline view of bookings

**Status:** shipped (2026-04-26); polish pass (2026-07-02)
**Depends on:** `bookings.md`, `venues.md`

## What we're building

A row-per-table, columns-as-time view of today's bookings. The host's "what's happening on my floor right now" tool — at-a-glance who's seated where, what's coming up next, and where the next free slot is.

## What shipped

- Route `/dashboard/venues/[id]/timeline?date=YYYY-MM-DD` next to `/bookings` in the sidebar.
- CSS-grid layout — one row per table, 4 columns per hour (15-min granularity). Day window derived from the venue's services (min start, max end, rounded to whole hours; falls back to 09:00–23:00 with no services).
- Status drives block fill: amber (requested) / blue (confirmed) / emerald (seated) / neutral (finished) / rose (no-show) / stone strike-through (cancelled).
- "Now" indicator — 1px coral vertical line at the current venue-local time. ~~Refreshes on page load (no auto-tick).~~ *Superseded 2026-07: ticks live, see below.*
- Multi-table bookings render once per occupied row.
- Drag-to-reassign — pick up an active block, drop on another row in the same area → calls `reassignBookingTable` via `reassignFromTimeline` server action. Same-area enforcement client-side (different-area rows dim during drag) + server-side (the existing `enforce_booking_tables_denorm` trigger). Errors surface inline on the row label briefly.
- ~~Click any block → `/bookings` list view for the same date.~~ *Superseded: clicks open the in-place detail modal, see below.*
- Mobile: timeline grid is `min-w-[900px]` inside an `overflow-x-auto` wrapper; "List view" button next to the date nav as the manual fallback.

## Surfaces

- `app/(dashboard)/dashboard/venues/[venueId]/timeline/page.tsx` — server-rendered shell + grid + day-glance header stats.
- `app/(dashboard)/dashboard/venues/[venueId]/timeline/forms.tsx` — `TimelineDateNav`, `TimelineDragProvider`, `TimelineRow`, `BookingBlock`, `NowLine`, `NewBookingModal`, `BookingDetailModal` clients.
- `app/(dashboard)/dashboard/venues/[venueId]/timeline/actions.ts` — `reassignFromTimeline`, `shiftFromTimeline`, `resizeFromTimeline`, `createFromTimeline` server actions.
- `lib/bookings/timeline-span.ts` — pure block-geometry maths (`bookingSpan`: clamping, past-midnight rollover, truncation flag), unit-tested in `tests/unit/timeline-span.test.ts`.

## Shipped since (previously "out of scope")

- **Per-block detail modal** — clicking a block opens `BookingDetailModal` in place (status actions, refund button, no-show outcome, enrichment badges); the bookings-list bounce is gone.
- **Resize a block** — drag the right-edge handle to change end time (optimistic, `useOptimistic`).
- **Drag horizontally on the same table** to shift start time; new-booking modal from an empty-slot selection.
- **Live "now" indicator** (2026-07) — `NowLine` client component re-ticks every minute (position only, no refetch), rendered only when viewing today.
- **Day-glance header stats** (2026-07) — covers · bookings · seated now · to come · high chairs · dietary-note count, derived from already-fetched data (cancelled/no-show excluded); coral accent on the prep signals.
- **Cross-day rollover markers** (2026-07) — a booking running past the window edge (incl. past midnight, where end < start in wall minutes) is clamped visually and marked with `→` + a tooltip carrying the real end time; the marker clears if the block is resized back inside the window.
- **Token palette** (2026-07) — service banner colours moved from raw violet/cyan/fuchsia classes to `@theme` token tints.

## Out of scope (post-ship)

- **Print / export.**
- **Mobile auto-redirect** to the list view at narrow widths — manual button works for now.
- **Supabase-realtime data refresh** — the now-line ticks, but blocks still reflect page-load state; realtime is a separate piece of work.
