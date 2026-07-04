# Spec: Service flow — auto-finish at close + overdue-table prompts

**Status:** in progress (2026-07-03)
**Depends on:** `bookings.md`, `timeline.md`, `floor-plan-visual.md`, `venues.md`

## What we're building

Two related behaviours that stop "seated" bookings rotting overnight and keep the floor state honest during service:

1. **Auto-finish at close.** Seated bookings are automatically transitioned to `finished` once the venue has closed for the night. Runs venue-scoped inline whenever an operator dashboard is open (near-real-time) with a nightly cron as the unconditional backstop.
2. **Overdue-table prompts.** While a dashboard is open, operators get a pop-up at a configurable interval listing seated tables past their booked end time: *"Emma on T4, booked until 21:30 — still seated?"* Per table: **Still seated** (extends the booking's end by the prompt interval, keeping the floor plan and availability honest) or **Mark finished**.

## Why

A forgotten seated booking blocks the table in availability, renders red/overdue on the floor plan forever, skews covers/no-show reporting, and never fires the thank-you message. Operators shouldn't need to remember to click "finish" at 11pm.

## Settings — `venues.settings.serviceFlow`

Typed JSONB slice (no migration), parsed by `lib/venues/service-flow.ts` `parseServiceFlow` — lenient, fully defaulted, same posture as `parseBranding`/`parseProfile`:

```
autoFinishEnabled:     boolean        // default true
overduePromptMinutes:  number | null  // default 15; 5–60; null = never prompt
```

Edited in venue General settings (new "Service flow" fieldset).

## Behaviour

### Auto-finish

- **Inline sweep** — `sweepVenueStaleSeated(venueId)` in `lib/bookings/finish-sweep.ts`, called from the overdue-poll server action (so any open dashboard triggers it every poll). Finishes seated bookings that are (a) from a previous venue-day, or (b) from today once the venue has closed: venue-local now is past the day's last service end (`venueCloseMinutes`, pure, max `schedule.end` across services running that weekday) plus a **60-minute grace**. Gated on `autoFinishEnabled`. No services configured → only rule (a) applies.
- **Cron backstop** — `/api/cron/finish-sweeper` (03:15 UTC, `CRON_SECRET` bearer, same shape as deposit-janitor): `sweepAllStaleSeated()` finishes ANY seated booking with `end_at < now − 3h`, all venues, regardless of the setting's inline gate? **No** — the cron also respects `autoFinishEnabled` per venue (an operator who opts out has said "I close my own tables").
- Every finish goes through the existing `transitionBooking(orgId, actorUserId: null, id, "finished")` — so booking events, audit log (`booking.transitioned`, null actor = system), the thank-you messaging trigger, and the `booking.updated` webhook all fire exactly as a manual finish would. Idempotent by construction: `finished` has no outgoing edges.

### Overdue prompts

- `components/bookings/overdue-prompt.tsx`, mounted in the **venue layout** — appears on any screen under `/dashboard/venues/[venueId]`.
- Polls the `pollOverdueSeated` server action every 60s. **The poll always runs** (it drives the inline auto-finish sweep, which must work even with prompts set to Never); only the modal is gated on `overduePromptMinutes`.
- Modal cadence: shown when overdue tables exist AND at least `overduePromptMinutes` since the last showing (per-venue timestamp in `sessionStorage` — per device/tab-session, deliberately not server state).
- Per-booking actions:
  - **Still seated** → `extendOverdue`: `resizeBookingDuration` with `newEndAt = max(now, endAt) + interval`. Slot-taken (back-to-back booking on the same table) surfaces inline — the operator must resolve the clash by hand.
  - **Mark finished** → `finishOverdue`: `transitionBooking(…, actor = current user, "finished")`.
  - **Dismiss** → snoozes the whole modal one interval; no data change.

## Surfaces

- `lib/venues/service-flow.ts` — parse + defaults (pure; unit-tested).
- `lib/bookings/finish-sweep.ts` — `venueCloseMinutes` (pure; unit-tested) + `sweepVenueStaleSeated` + `sweepAllStaleSeated` (integration-tested).
- `app/api/cron/finish-sweeper/route.ts` + `vercel.json` entry (03:15 UTC).
- `app/(dashboard)/dashboard/venues/[venueId]/overdue-actions.ts` — `pollOverdueSeated` / `finishOverdue` / `extendOverdue` server actions (host role; venue-in-org checked; Zod args).
- `components/bookings/overdue-prompt.tsx` — client modal.
- Venue layout mounts the prompt; venue General settings gains the fieldset.

## Acceptance criteria

- [ ] Seated booking from yesterday → finished by the inline sweep on next dashboard poll and by the cron backstop; audit row has null actor.
- [ ] Seated booking today, venue closed >60 min ago → finished inline; before close → untouched.
- [ ] `autoFinishEnabled: false` → neither sweep touches the venue's bookings.
- [ ] Prompt appears on any venue dashboard page when a seated booking passes `end_at`, re-prompts no more often than the configured interval, and never when set to Never.
- [ ] Still seated extends `end_at` by the interval (junction rows follow via the existing trigger); overlap with the next booking returns slot-taken and leaves data untouched.
- [ ] Settings round-trip without clobbering sibling `settings.*` slices.

## Known limitation

A venue whose last service ends 23:00 or later never reaches "close + 60-min grace" before midnight, so its same-day sweep branch is unreachable — those venues rely on the previous-day rule (tables tidy shortly after venue-local midnight via the inline sweep, or the nightly cron). Overnight service windows aren't modelled anywhere in the app yet; revisit together.

## Out of scope

- Auto-no-show for never-seated bookings (exists separately via the no-show capture sweeper).
- Push/notification delivery of prompts (in-app modal only).
- Per-table or per-service prompt rules — one venue-level interval.
