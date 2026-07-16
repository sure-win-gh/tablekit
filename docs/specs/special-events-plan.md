# Special events — build plan (working checklist)

Companion to `docs/specs/special-events.md` (the spec — decisions and
invariants live there; this file is the working checklist). Tick items off
as they land; delete this file when Phase 3 ships. Grounded against the real
source as of the spec write-up — file paths + signatures verified, not
guessed.

Gate: **Plus** (`minPlan: "plus"`, `lib/auth/entitlements.ts`). Every existing
Plus feature in that map already uses `"plus"`, so the new `events` entry
slots straight in.

## Phase 1 — date blocking + closure primitive + event CRUD (no ticketing)

Ships the "no standard bookings on this date" value + a general venue-closure
primitive the product lacks today. Link-out is the only ticket path in this
phase.

### 1.1 Schema + migration
- [ ] New migration under `drizzle/` (next number after 0055): `special_events`
      table + `event_status` enum + `bookings.event_id` column + the
      `check ((event_id is null) or (table_id is null))` guard + indexes
      (`special_events_venue_window_idx`, `special_events_org_idx`,
      `bookings_event_idx` partial). SQL in the spec's Data model.
- [ ] Mirror it in `lib/db/schema.ts` (drizzle table def + relations) so the
      snapshot matches — follow the existing table style (denormalised
      `organisation_id`, `created_at`/`updated_at`, `check()` declared in-schema
      per the multi-region hygiene note in `ROADMAP.md §5`).
- [ ] RLS policy for `special_events`: SELECT/UPDATE to members of the row's
      org (+ per-venue scoped roles via the same pattern as `bookings`);
      INSERT service-role only. Add to the RLS test suite
      (`tests/integration/rls-*.test.ts` pattern) — org A cannot read/write
      org B's events. **This is a go-live gate**, same as every tenant table.
- [ ] `pnpm check:rls` green against the new table.

### 1.2 Availability wiring (the load-bearing change)
- [ ] `lib/bookings/availability.ts`: add `closures?: { startAt: Date; endAt: Date }[]`
      to `AvailabilityInput`; in `findSlots`' per-slot loop, drop the candidate
      before `buildTableOptions` when `[startAt, endAt)` overlaps any closure
      (reuse the half-open logic in `isTableOccupied`). Keep it pure.
- [ ] Unit tests in `tests/unit/bookings-availability.test.ts`: window vs
      whole-day closure, venue-timezone edges, turn-time overlap boundaries,
      and the **omitted-closures ⇒ identical-to-today** invariant.
- [ ] `lib/public/venue.ts`: add `loadClosures(venueId, range)` next to the
      occupancy loaders; call it in both the single-day availability loader and
      `loadPublicMonthAvailability`, passing the result into `findSlots`.
- [ ] `lib/public/venue.ts`: extend `DayAvailability` with `"event"`; classify
      a published blocking event as `"event"` ahead of the open/full test in
      `loadPublicMonthAvailability`.
- [ ] `lib/bookings/create.ts`: load closures + pass them into the `findSlots`
      re-run in `createBooking`; add `{ ok: false; reason: "venue-closed" }` to
      `CreateBookingResult`; map it to 409 at the `/api/v1/bookings` boundary.
- [ ] `/api/v1/availability` route: thread closures through (same loader).

### 1.3 Dashboard CRUD (Plus-gated)
- [x] `lib/auth/entitlements.ts`: `events` in the `Feature` union +
      `FEATURES.events` (`minPlan:"plus"`). **Committed.**
- [x] `app/(dashboard)/dashboard/venues/[venueId]/events/page.tsx`:
      `requireRole("manager")` → `getPlan` → `if (isLocked(plan,"events"))
      return <LockedFeature feature="events" currentPlan={plan} />` before any
      query; then `withUser` read of the venue's events formatted in the venue
      timezone. **Committed, ESLint clean.**
- [x] Create + status + delete server actions (`events/actions.ts`,
      `events/types.ts`, `events/forms.tsx`): each does `requireRole("manager")`
      + **throwing** `requirePlan(orgId,"plus")` (real gate; lock is UX-only).
      Create validates via zod, resolves whole-day → full local-day window and
      time-window → `zonedWallToUtc` using the venue tz, slugs the name, inserts
      `draft`/`published` per a "Publish now" checkbox, https-only
      `external_ticket_url`, audit-logged. `setSpecialEventStatus`
      (publish/unpublish/cancel) + `deleteSpecialEvent` (two-step confirm).
- [x] Publish-collision warning: publishing (create-with-publish or the status
      toggle) counts live standard bookings overlapping the event window and
      returns a non-blocking amber warning ("N existing bookings fall inside…").
      Never auto-cancels (per the spec). Shown in the create form + event row.
      **Done, ESLint clean.**
- [x] Sidebar: `Events` item in `sidebar-shell.tsx` (top-level venue nav after
      Waitlist), `locked: isLocked(data.org.plan,"events")`. **Committed.**

### 1.4 Public event page (link-out only this phase)
- [x] `app/(widget)/events/[venueSlug]/[eventSlug]/page.tsx`: resolves the venue
      via `loadPublicVenueByIdOrSlug`, loads the **published** event via new
      `lib/public/events.ts#loadPublicEvent` (adminDb; only `published` rows),
      renders name + date/time (venue tz) + description + a "Get tickets"
      `<a target="_blank">` to `external_ticket_url` (or a "contact the venue"
      fallback) + back-link to `/book`. Under `(widget)` for the cookieless
      shell. **Committed, ESLint clean.**
- [x] Month calendar `event` days deep-link here. `loadPublicMonthAvailability`
      now returns an `events` map (ymd → {slug,name}); `MonthCalendar` renders
      each `event` day as a coral `<a href="/events/<venueKey>/<slug>">`
      (`venueKey` = the id-or-slug from `basePath`). Hosted page + embed.
      **Done, ESLint clean.**
- [x] CSP: `/events/:path*` added to `next.config.ts` headers with the same
      `BOOK_CSP` (Report-Only) as `/book`. **Done.**

### 1.5 Phase-1 gate
- [ ] `pnpm typecheck && pnpm lint && pnpm test` green.
- [ ] A pure closure (zero ticket types, `blocks_standard_bookings=true`) works
      end-to-end with no payments involvement — manual staging rehearsal.

## Phase 2 — native Stripe-Connect ticketing (the competitive edge)

Re-read `docs/playbooks/payments.md` before starting. Reuses the deposits rails
(`payments-deposits.md`) almost verbatim.

- [ ] `event_ticket_types` + `event_order_items` tables + RLS + schema + migration.
- [ ] Extend the `payments.kind` check with `'event_ticket'`; add `'event'` to
      `BookingSource` + the `bookings.source` values.
- [ ] Purchase endpoint: resolve event (published, not past) → compute
      `amount_minor = Σ q × price_minor` → **atomic capacity reservation**
      (conditional `quantity_sold` UPDATE per line) **inside** the existing
      `createBooking` transaction → placeholder `payments` row → PaymentIntent
      on the connected account (3DS forced, `metadata.kind='event_ticket'`),
      Stripe call outside the tx (mirror `resolveDepositRequirement`).
- [ ] New webhook handler registration reuses the existing dispatch
      (`payment_intent.succeeded` already flips `requested→confirmed`; confirm
      the event-ticket branch: increment nothing on success — reservation
      already happened; just confirm + send). Register per the handler-registry
      pattern in `lib/stripe/webhook.ts`.
- [ ] **Reservation release** on the sad paths via the existing deposit
      abandonment janitor: a `requested` event booking with no successful
      payment after the grace window is cancelled **and** its tickets returned
      (`quantity_sold = quantity_sold − q`, floored at 0). Extend the janitor;
      test against a fake clock; idempotent (second sweep releases nothing twice).
- [ ] Public ticket-picker island → Stripe Elements (the existing Payment
      Element) → success; degrade to link-out / "unavailable" when
      `paymentsDisabled()` / `!stripeEnabled()`.
- [ ] Confirmation email/SMS: event-ticket template variant via `messaging.md`
      + `message-customisation.md` (merge tags: event name, date/time, ticket
      breakdown, address).
- [ ] Dashboard per-event **attendee list** from `bookings where event_id`
      (reuse the bookings list components + `GuestBadges`).
- [ ] Refund: works from the existing booking-detail refund action; refund
      modal gets a "return tickets to inventory" checkbox (default off).
- [ ] **Oversell test**: N concurrent purchases vs capacity M<N ⇒ exactly M
      succeed, `quantity_sold = quantity_total`, never negative. This is the one
      genuinely novel invariant — test it hard.
- [ ] No-raw-card CI grep extended to the new purchase route; 3DS-forced unit
      assertion; `payments`/`booking` rows never written outside a handler/
      server action (existing CI greps extended).

## Phase 3 — deferred (see spec)

- [ ] Pre-ordered menus / offers / add-ons per ticket (`event_menu_options`
      keyed to ticket type; choices on `event_order_items`).
- [ ] Event cancellation with bulk refund (fan out the per-booking refund path;
      idempotent).
- [ ] Door check-in (mark attendees arrived; optional QR in the confirmation).
- [ ] Event revenue reporting folded into `reporting.md`.
- [ ] "Duplicate event" — clone last year's event to a new date (Beaujolais is
      annual; recurrence engine stays out of scope).

## External / product gates (Ben — not code)

- [ ] Confirm **Plus** is the final gate (vs Core) before the entitlements entry
      ships — it's a one-line change but sets the sales story.
- [ ] Decide the Phase-1 link-out copy + whether link-out survives past Phase 2
      or is removed once native ticketing is live.
