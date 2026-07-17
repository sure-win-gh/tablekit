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

- [x] `event_ticket_types` + `event_order_items` tables + RLS (member-read) +
      `schema.ts` + migration `0060_native_ticketing`. `bookings` gains
      `event_id`, `service_id`/`area_id` relaxed to nullable, and a
      `bookings_event_or_service_check` (event ⊕ standard) added `NOT VALID`
      then `VALIDATE`d to avoid a long lock. **On disk (main), ESLint clean.**
      **Run `pnpm db:migrate` to apply 0060.**
- [~] `payments.kind` check extended to include `'event_ticket'` (in 0060).
      Still TODO in Tranche B: add `'event'` to `BookingSource` + the
      `bookings.source` values (code, `lib/bookings/create.ts`).
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
- [x] **Reservation release** — `sweepAbandonedEventBookings` in
      `lib/payments/janitor.ts`: cancels stuck `requested` event bookings after
      the 15-min TTL and releases `quantity_sold` (floored at 0). The
      requested→cancelled flip is the idempotency gate so a retry can't
      double-release. Wired into the cron + inline on the purchase route.
      **Done, ESLint clean.**
- [x] Public ticket-picker + checkout (`events/[venueSlug]/[eventSlug]/
      checkout.tsx`): qty steppers per tier (capped at remaining/max-per-order)
      + guest form + hCaptcha → `POST /api/v1/events/purchase` → reuses the
      Connect-aware Stripe **Payment Element** (`loadStripe(pk, {stripeAccount})`
      + `confirmPayment` with 3DS) → success screen. Event page renders the
      checkout when tiers exist, else the external link-out, else "contact the
      venue". `loadPublicEventTicketTypes` added. **Done, ESLint clean.**
- [x] Confirmation email: event-ticket **variant inside `booking.confirmation`**
      (no new template name — avoids a messages CHECK migration). Context gains
      `eventTickets` (per-tier lines + total from `event_order_items`, loaded in
      `load-context.ts`); the email renders "You're booked in for {event}" + a
      ticket receipt ("2× Standard — £90 … Total paid"). Event name already
      flowed via the team's `{{service}}` substitution. **Done, ESLint clean.**
- [x] Dashboard per-event page (`events/[eventId]`): **ticket-types CRUD**
      (create/delete tiers with sold/remaining, price entered in £ → pence;
      delete FK-guarded against sold tiers) + **attendee list** from
      `bookings where event_id` (first_name is plaintext, no decrypt) + sold
      count. Events-list rows link here. **Done, ESLint clean.**
- [x] Refund: `refundBooking` widened to `kind IN (deposit, event_ticket)` —
      it previously matched deposits only, so event tickets were unrefundable
      (real bug). Optional `returnTicketsToInventory` releases `quantity_sold`
      (floored at 0; Stripe's already-refunded rejection is the idempotency
      gate). Surface: the **event attendee list** (the bookings list's services
      inner-join excludes event bookings by design, so the dialog was the wrong
      home) — per-attendee Refund → reason + "Return tickets to inventory"
      checkbox (default off) → confirm; refreshes sold counts in place.
      **Done, ESLint clean.**
- [x] **Oversell test** — `tests/integration/event-oversell.test.ts`: 25
      concurrent buyers vs capacity 5 ⇒ exactly 5 win, `quantity_sold` lands on
      the cap, never over/negative. Exercises the reservation SQL directly (no
      Stripe). Run with `pnpm test:integration`. **Done, ESLint clean.**
- [x] No-raw-card scan: **new** `tests/unit/no-raw-card.test.ts` (no repo-wide
      scan existed — only the POS runtime guard). Walks `app/`+`lib/`+
      `components/` for bare 15–16-digit runs and 4-4-4-4 groups, failing only
      on Luhn-valid matches (via the shared POS card-guard) so ids/epochs don't
      false-positive. Covers every current + future payment surface
      automatically. Passing on the full codebase. **Done.**

## Phase 2.5 — area-scoped events (PRE-LAUNCH, spec §Area-scoped events)

An event blocks specific floor-plan areas instead of the whole venue. Whole-
venue stays the default (junction empty = whole venue — zero backfill).
Decisions live in the spec; this is the build order.

### 2.5a Backend core — DONE
- [x] Schema + migration `0062_event_area_scope`: `special_event_areas`
      junction (PK `(event_id, area_id)`, `organisation_id` denormalised,
      `event_id` FK cascade, `area_id` FK **NO ACTION**) + RLS member-read.
      **Run `pnpm db:migrate` to apply 0062.**
- [x] `lib/bookings/availability.ts`: `ClosureWindow.areaIds` +
      `overlappingClosures` partition in `findSlots` — whole-venue overlap
      drops the slot (unchanged); area-scoped overlap strips those areas'
      tables from the free set. Memo cache keys on free-table ids, so it
      stays correct with no extra work.
- [x] Unit tests (4 new; suite 32/32 green): scoped closure leaves other
      areas bookable; all-areas ≡ whole-venue; `null`/`[]` ≡ whole venue;
      same-area combos die with their scoped area + return outside the window.
- [x] New shared `lib/bookings/closures.ts#loadEventClosures` (joins
      `special_event_areas`, aggregates `areaIds`, empty → null, carries
      slug/name for calendar deep-links) — replaces the three duplicated
      inline queries in `venue.ts` (×2) and `create.ts`.
- [x] `create.ts`: `venue-closed` only for a **whole-venue** closure covering
      the requested instant (`isWholeVenue`); area-scoped miss stays
      `no-availability`.

### 2.5b Calendar + surfaces
- [x] Month loader: day = `"event"` only for whole-venue events; scoped-event
      days classify open/full from remaining tables (findSlots strips scoped
      areas itself); `events` map populated for any blocking-event day
      (whole-venue preferred when both cover a day).
- [x] `MonthCalendar`: scoped-event days render as normal bookable cells; slim
      coral **event banner** under the grid ("🎟 {name} · {date} · tickets →")
      deduped by slug, linking to `/events/<venueKey>/<slug>`. **Done.**
- [x] Dashboard event form: `area_ids` checkbox chips (rendered only when the
      venue has ≥2 areas; unticked = whole venue); create action validates the
      ids belong to the venue and writes event + junction in one transaction.
      Event row + detail page show "Terrace only". **Done.**
- [x] `countCollidingBookings` takes `areaIds` and filters
      `bookings.area_id` when scoped; both publish paths pass the scope.
      **Done.**
- [x] Ticket-type form: "The blocked areas seat ~N covers — a guide, not a
      limit" hint under Capacity (detail page computes from `venueTables`).
      **Done.**
- [x] Public event page: "· Terrace" scope after the time line
      (`loadPublicEventAreaNames`). **Done.**

### 2.5c Gate
- [x] Integration: `rls-special-events.test.ts` extended — junction
      cross-tenant read isolation + authenticated-insert denial. Floor-plan
      `deleteArea` catches 23503 with a clear operator message. (Run
      `pnpm test:integration` to execute.)
- [~] Regression: unit suite 32/32 green (whole-venue closures pinned
      byte-identical). **Ben:** `pnpm typecheck && pnpm lint && pnpm test` +
      `pnpm test:integration` + `pnpm db:migrate` (0062) before merge.

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
