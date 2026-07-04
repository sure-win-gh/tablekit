# Spec: Visual floor plan with booking overlay

**Status:** shipped; service-board polish (2026-07-02)

### 2026-07 polish notes

- **Live info on shapes** — occupied tables render guest first name (width-truncated) · ×party · "til HH:MM" (or "at HH:MM" for soon tables) instead of the static min–max capacity; capacity still shows when empty or in edit mode. Tooltips + `aria-label` carry the same detail. No new queries — data was already client-side in `activeByTableId`/`upcomingByTableId`.
- **Live header strip** — covers on the floor now (multi-table bookings deduped by booking id) + per-state table counts + "updated HH:MM · refreshes every 30s".
- **Auto-refresh pauses in edit mode** — `AutoRefresh` gained a `paused` prop and moved inside the canvas; a 30s `router.refresh()` mid-drag could revert optimistic positions and reset the position-keyed side-panel form. Refreshes immediately on leaving edit mode (ref-guarded so plain mount doesn't double-fetch).
- **First-run overlay** — empty canvas shows a centred prompt (managers get a "Start editing" button on md+; hosts get a pointer to their manager).
- **Keyboard selection** — table shapes (`role="button"`) now handle Enter/Space, with a visible coral focus outline.

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

- [x] Canvas-based rendering — SVG ([`canvas.tsx`](../../app/(dashboard)/dashboard/venues/[venueId]/floor-plan/canvas.tsx)).
- [x] Read-mode by default; edit-mode requires manager+ role. Gated in [`page.tsx`](../../app/(dashboard)/dashboard/venues/[venueId]/floor-plan/page.tsx) via `canEdit = hasRole(auth.role, "manager")` → toggle button disappears for hosts.
- [x] Edit-mode drag persists `tables.position` via the `saveTablePosition` server action ([`actions.ts`](../../app/(dashboard)/dashboard/venues/[venueId]/floor-plan/actions.ts)). One save per drag-end, with `useOptimistic` so the UI moves the moment the pointer is released.
- [x] Booking-status overlay updates on a 30-second SWR refresh ([`auto-refresh.tsx`](../../app/(dashboard)/dashboard/venues/[venueId]/floor-plan/auto-refresh.tsx) — `router.refresh()` on an interval, paused while the tab is hidden). Realtime subscription not pursued; the polling cost is negligible at projected operator concurrency.
- [x] Canvas viewport: wheel zoom anchored to cursor + zoom-in/out buttons + drag-to-pan + "Fit" button. Implemented in `canvas.tsx`.
- [x] Replaces the current `/floor-plan` page — the canvas is the page; the side panel shows table + booking detail when a shape is selected; the old "add area / add table" CRUD landed inline behind the edit-mode toggle.
- [x] Mobile: read-only, no drag. Edit-mode toggle hidden below the `md` breakpoint (`hidden md:inline-flex`); since `editMode` state can only flip via that button, touch-screen drag handlers never fire on phones.

## Open questions (resolve in plan-phase)

- Coordinate system: what's the unit? Pixels (concrete but tied to viewport size) or abstract "grid units" (e.g. 1 unit = 1 metre)? Lean toward grid units so a venue can scale up/down.
- SVG library: bare React SVG is fine for the MVP; if we hit perf at 100+ tables we'll evaluate `react-konva` / `pixijs`. Defer the decision.
- How does a multi-table booking (e.g. T4+T5 = 8-top) visualise? Both tables tinted the same, or a connecting halo? Pick one.
- Realtime update path — Supabase realtime subscriptions are available but we don't use them yet. Adding a subscription channel is a small ops surface; weigh against polling.

## Out of scope (initial cut)

- Multi-floor venues (a basement + ground floor). Treat each as a separate area on the same plane for now.
- Custom shapes beyond rect / circle (booth / banquette layouts). MVP ships with the two existing shapes.
- Heatmaps (e.g. "where do no-shows cluster"). Reporting territory.
