# Spec: Visual floor plan with booking overlay

**Status:** draft (not started — gap in `bookings.md` + `venues.md`)
**Depends on:** `bookings.md`, `venues.md`, `timeline.md` (status-colour vocabulary)

## What we're building

Render the venue's tables on a 2-D canvas using the `tables.position` field (already stored as `{x, y, w, h}` JSON since the venues phase but never visualised). Overlay each table with the current booking's status — a host glances at the screen and sees "T4 is seated, T5 is cancelled, T6 is empty for the next 30 min".

This is the screen the bookings spec at `bookings.md` promises with *"As a host I can see today's bookings laid on the floor plan with statuses"* — currently a stub.

## User stories

- As a host I want to see a top-down view of the venue with tables drawn to scale, so I can match the dashboard to my actual floor.
- As a host I want each table tinted by its current booking status (seated / confirmed / no-show / empty), so I can scan the room without reading labels.
- As a host I want to click a table to see the booking detail in a side panel.
- As a manager I want to drag tables to reposition them (edit-mode toggle; default is read-only viewing).
- As a manager I want to add an area boundary (rectangle outline) to delineate "Inside" from "Patio" on the canvas.

## Acceptance criteria

- [ ] Canvas-based rendering — SVG is the right choice (DOM-inspectable, accessible labels, sharp at any zoom). Avoid `<canvas>` HTML element until a profiling reason emerges.
- [ ] Read-mode by default; edit-mode requires manager+ role and is gated by a toggle.
- [ ] Edit-mode drag persists `tables.position` via a new server action (debounced — one save per drag-end, not per pixel).
- [ ] Booking-status overlay updates on a 30-second SWR refresh OR on Supabase realtime subscription (decide in plan-phase).
- [ ] Canvas viewport: pan + zoom with sensible defaults; "fit to viewport" button.
- [ ] Mobile: read-only, no drag.
- [ ] Replaces the current `/floor-plan` page — the existing CRUD list becomes the side-panel "table details" view in edit-mode.

## Open questions (resolve in plan-phase)

- Coordinate system: what's the unit? Pixels (concrete but tied to viewport size) or abstract "grid units" (e.g. 1 unit = 1 metre)? Lean toward grid units so a venue can scale up/down.
- SVG library: bare React SVG is fine for the MVP; if we hit perf at 100+ tables we'll evaluate `react-konva` / `pixijs`. Defer the decision.
- How does a multi-table booking (e.g. T4+T5 = 8-top) visualise? Both tables tinted the same, or a connecting halo? Pick one.
- Realtime update path — Supabase realtime subscriptions are available but we don't use them yet. Adding a subscription channel is a small ops surface; weigh against polling.

## Out of scope (initial cut)

- Multi-floor venues (a basement + ground floor). Treat each as a separate area on the same plane for now.
- Custom shapes beyond rect / circle (booth / banquette layouts). MVP ships with the two existing shapes.
- Heatmaps (e.g. "where do no-shows cluster"). Reporting territory.
