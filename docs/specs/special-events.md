# Spec: Special events (ticketed event days + date blocking)

**Status:** scoping
**Depends on:** `venues.md`, `bookings.md`, `booking-page.md`, `widget.md`, `payments-deposits.md`, `plan-gating-paywall.md`, `messaging.md`, `guests.md`. See also `docs/playbooks/payments.md`, `docs/playbooks/gdpr.md`.
**Build plan:** working checklist in [`special-events-plan.md`](special-events-plan.md) — integration points verified against the real source (`availability.ts`, `create.ts`, `venue.ts`, `entitlements.ts`).

## Scoping assumptions (Ben to confirm — each is reversible)

These were going to be clarifying questions; defaults chosen to match existing patterns in the repo. Flip any before Phase 1 lands.

1. **Native ticketing is the strategic bet (confirmed).** Owning the event-day checkout end-to-end — not linking out to DesignMyNight/Eventbrite — is the competitive edge, so Phase 2 (native Stripe-Connect ticketing) is the point of the feature, not an optional extra. Delivery is still phased (block-dates → native ticketing → menus) so the low-risk blocking piece can land first, but link-out is only ever a Phase-1 stopgap / fallback, never the destination.
2. **Gated Plus (confirmed)** (`hasPlan(plan, "plus")`) — a top-tier differentiator alongside multi-venue, AI enquiries, and campaigns. Free + Core see the locked teaser.
3. **Multiple ticket types per event** (Standard / VIP, Adult / Child …), each with its own price + capacity. An operator who wants one price just creates one type.
4. **Pre-ordered menus / offers deferred to Phase 3.** MVP sells a ticket to the day; menu pre-selection + add-ons attach to the ticket later.
5. **Prepayment reuses the deposits Stripe Connect rails** — the venue is merchant of record on its own connected account, exactly as deposits work today. No new Stripe integration surface.

## What we're building

Operators run premium one-off event days (e.g. **Beaujolais Day** in Swansea) where they do **not** want the normal per-table booking flow. Two things have to happen on such a day:

1. **Standard table bookings are blocked** for that venue over the event window, so the widget / hosted page / API stop offering ordinary slots.
2. **The date is sold as a ticketed event instead** — a dedicated event page where guests buy prepaid tickets (optionally at a premium), settled to the venue's connected account through the payments rails we already have.

A `special_events` row with zero ticket types and `blocks_standard_bookings = true` is, usefully, also a **general venue closure primitive** — something the product has no first-class model for today (holidays, private hire, refurb days). Same table, no ticketing attached.

## Why this matters

Right now the availability engine (`lib/bookings/availability.ts`) has no notion of a closed date, so an operator wanting to hold a ticketed event has to hack it (delete services, disable the venue) and then sell tickets on a competitor platform (DesignMyNight, Eventbrite) — handing the premium transaction, the guest data, and the margin to someone else. Owning the event day keeps the covers, the prepayment, and the guest record inside Tablekit, and turns high-demand dates into the highest-margin days of the year.

## Roadmap

| Phase | Deliverable |
|---|---|
| **1** | `special_events` model + **date blocking** wired into availability + month-calendar "event" day state + dashboard event CRUD (no ticketing) + public event landing card with optional operator "Get tickets" **link-out**. Ships closures + link-out value immediately. |
| **2** | **Native ticketing.** `event_ticket_types` + oversell-safe capacity reservation + public ticket picker → Stripe Connect checkout reusing `payments-deposits` rails + event bookings through the standard pipeline (guest record, confirmation email/SMS, dashboard attendee list, refunds). |
| **2.5 (pre-launch)** | **Area-scoped events.** An event can block specific floor-plan areas instead of the whole venue ("Terrace closed for Beaujolais tasting; Main keeps taking standard bookings"). Whole-venue stays the default and becomes the special case of "all areas". See §Area-scoped events. |
| **3** | **Pre-ordered menus / offers / add-ons** per ticket; **event cancellation with bulk refund**; door **check-in** (QR / attendee list mark-off); event-level revenue in `reporting.md`; **"duplicate event"** (Beaujolais is annual — clone last year's event to a new date). |

## User stories

- As an operator I create a special event on a date, and standard table bookings for that venue are automatically closed for that window.
- As an operator I sell tickets at a premium for the event, in one or more tiers (Standard / VIP), each with its own price and capacity.
- As an operator I can instead just **block a date** (private hire, holiday) with no ticketing, optionally pointing guests at an external link.
- As a diner who lands on the venue's booking page on an event date, I see the event — not "no availability" — and I can buy a ticket in the same few taps as a normal booking.
- As a diner I pay upfront and get a confirmation, exactly as I would for a deposit booking.
- As an operator I see who's coming (an attendee list), and I can refund a ticket from the booking detail view I already use.

## Gating

- New entitlement `events` in `lib/auth/entitlements.ts`, `minPlan: "plus"`. Dashboard `/dashboard/venues/[venueId]/events` renders `<LockedFeature feature="events" />` for Free **and Core** (blurred teaser + upgrade card), per `plan-gating-paywall.md` — the same Plus gate as `enquiries`, `insights`, and `campaigns`.
- The **public** event page renders for everyone — a non-Plus venue simply has no way to create events, so there are none to show. No public paywall branch.
- Server actions + the public purchase route keep a throwing `requirePlan(orgId, "plus")` check so a Free/Core org can't drive event creation or ticket sales by a crafted request (the lock is UX only — same rule as every other gated feature).
- **Plus theming** (`widget.md` §Operator theming) applies to the event page via the existing `WidgetThemeProvider`, unchanged.

## Data model (delta on `bookings` + four new tables)

Pence-only minor units; `float` is a bug (payments playbook rule 6). RLS on every new table mirrors `bookings`: SELECT/UPDATE restricted to members of the row's org (+ per-venue scoped roles); INSERT via service role only. `organisation_id` denormalised on each table for RLS + populated on write like the rest of the schema.

```sql
create type event_status as enum ('draft','published','cancelled');

-- The event itself. Zero ticket types + blocks_standard_bookings = a
-- pure venue closure. One event = one venue (no cross-venue events).
create table special_events (
  id                       uuid primary key default gen_random_uuid(),
  organisation_id          uuid not null references organisations(id) on delete cascade,
  venue_id                 uuid not null references venues(id) on delete cascade,
  slug                     text not null,                 -- public URL segment
  name                     text not null,
  description              text,                          -- ≤ 4000, operator copy
  starts_at                timestamptz not null,          -- event window (venue-local wall time stored UTC, per bookings.md)
  ends_at                  timestamptz not null,
  status                   event_status not null default 'draft',
  blocks_standard_bookings boolean not null default true,
  block_scope              text not null default 'window'
                             check (block_scope in ('window','whole_day')),
  external_ticket_url      text,                          -- https only; link-out mode when set & no ticket types
  hero_photo_path          text,                          -- reuse the public `venue-photos` Supabase bucket
  currency                 char(3) not null default 'GBP',
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  unique (venue_id, slug),
  check (ends_at > starts_at)
);
create index special_events_venue_window_idx on special_events (venue_id, starts_at, ends_at);
create index special_events_org_idx          on special_events (organisation_id);

-- Ticket tiers. quantity_sold is the oversell guard (see below).
create table event_ticket_types (
  id               uuid primary key default gen_random_uuid(),
  organisation_id  uuid not null references organisations(id) on delete cascade,
  event_id         uuid not null references special_events(id) on delete cascade,
  name             text not null,                          -- 'Standard', 'VIP', 'Child'
  price_minor      int  not null check (price_minor >= 0),
  quantity_total   int  not null check (quantity_total > 0),
  quantity_sold    int  not null default 0
                     check (quantity_sold >= 0 and quantity_sold <= quantity_total),
  max_per_order    int  not null default 10 check (max_per_order > 0),
  sort             int  not null default 0,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index event_ticket_types_event_idx on event_ticket_types (event_id);

-- A purchase reuses `bookings` (source='event', event_id set, table_id null,
-- party_size = total tickets). These rows record the tier breakdown so the
-- kitchen/host and reporting can see the mix. unit_price_minor is snapshotted
-- so a later price edit never rewrites history.
create table event_order_items (
  id               uuid primary key default gen_random_uuid(),
  organisation_id  uuid not null references organisations(id) on delete cascade,
  booking_id       uuid not null references bookings(id) on delete cascade,
  ticket_type_id   uuid not null references event_ticket_types(id),
  quantity         int  not null check (quantity > 0),
  unit_price_minor int  not null check (unit_price_minor >= 0),
  created_at       timestamptz not null default now()
);
create index event_order_items_booking_idx on event_order_items (booking_id);
```

Delta on `bookings`:

```sql
alter table bookings add column event_id uuid references special_events(id);
-- event bookings: event_id not null, table_id null, no booking_tables rows,
-- so they never touch the GIST table-exclusion constraint. Standard bookings
-- unchanged. Enforced in lib/bookings/create.ts, asserted by a check:
--   check ((event_id is null) or (table_id is null))
create index bookings_event_idx on bookings (event_id) where event_id is not null;
```

`'event'` is added to the `source` values and to the `BookingSource` type in `lib/bookings/create.ts` (today `"host" | "widget" | "rwg" | "api"`), so event purchases are distinguishable in reporting + the audit trail.

Payments reuse `payments-deposits.md` verbatim — one new value only:

```sql
-- extend the existing kind check
--   kind in ('deposit','hold','no_show_capture','refund','event_ticket')
```

## Date blocking — the availability interaction (Phase 1)

This is the load-bearing change and must not regress standard bookings.

- New pure helper `loadClosures(venueId, range)` (in `lib/public/venue.ts`, next to the existing occupancy loaders) returns the windows of `status='published' AND blocks_standard_bookings=true` events overlapping `range` (whole-day events expand to the venue's local midnight-to-midnight). Backed by `special_events_venue_window_idx`.
- `findSlots` in `lib/bookings/availability.ts` gains an **injected** `closures?: { startAt: Date; endAt: Date }[]` on `AvailabilityInput` (it stays pure — no DB, no clock, per its contract). Inside the per-slot loop, a candidate is dropped before `buildTableOptions` when `[startAt, endAt)` overlaps any closure window — the same half-open overlap test already used by `isTableOccupied`. Omitted/empty ⇒ byte-identical to today. All three call sites pass it: `loadPublicMonthAvailability` + the availability-slot loader in `lib/public/venue.ts`, and the availability re-check inside `createBooking`.
- `DayAvailability` in `lib/public/venue.ts` (today `"open" | "full" | "closed" | "past"`) gains **`"event"`**, classified in `loadPublicMonthAvailability` before the `findSlots` call (a published blocking event on that day ⇒ `"event"`, ahead of the open/full test). An `event` day is not selectable in the standard wizard; the calendar renders it as a labelled chip that deep-links to the event page (`booking-page.md` month calendar + the embed calendar).
- `createBooking`'s `CreateBookingResult` union in `lib/bookings/create.ts` gains `{ ok: false; reason: "venue-closed" }`. The check reuses the `findSlots` re-run already in `createBooking` (it passes the loaded closures, so a blocked slot yields `no-availability`/`venue-closed`) — defence in depth: the slot shouldn't have been offered, but the create path re-checks exactly as it already re-checks table availability against the GIST constraint.
- **Existing standard bookings** made before an event was published are not auto-cancelled. Publishing an event that collides surfaces a dashboard warning listing the affected bookings; the operator decides (move/cancel/refund manually). No silent cancellation.

## Ticketing flow (Phase 2) — reuses deposits rails

Follows Flow A of `payments-deposits.md` (deposit-at-booking) almost exactly; re-read `docs/playbooks/payments.md` before touching card collection. Summary of the deltas:

1. Public event page posts the chosen `{ ticket_type_id, quantity }[]` + guest details to a purchase endpoint. Server resolves the event (must be `published`, window not past) and computes `amount_minor = Σ quantity × price_minor`.
2. **Capacity is reserved inside the existing `db.transaction` in `createBooking`, before payment** — an atomic conditional update per line: `update event_ticket_types set quantity_sold = quantity_sold + $q where id = $id and quantity_sold + $q <= quantity_total`. Zero rows updated → sold out → the whole transaction rolls back (same rollback path as a `slot-taken` EXCLUDE violation today), returning `{ ok:false, reason:"sold-out" }`. This is the event analogue of the `booking_tables` GIST constraint: since event bookings never insert a `booking_tables` row, this conditional counter is what makes overselling structurally impossible under concurrent buyers.
3. Ticket total is resolved **before** the transaction (mirroring how `resolveDepositRequirement` runs before the tx so the Stripe call stays outside it). Booking created `requested` (`source='event'`, `event_id`, `table_id null`, `party_size = Σ q`), `event_order_items` written, a placeholder `payments` row (`kind='event_ticket'`, `requires_payment_method`), all in the one transaction; then — outside it — a `PaymentIntent` on the **connected account**: `capture_method:'automatic'`, 3DS forced (`request_three_d_secure:'any'`), `metadata:{ booking_id, kind:'event_ticket' }`. Response carries `{ bookingId, clientSecret, publishableKey }`, matching the `DepositResponse` shape `createBooking` already returns.
4. Widget mounts Stripe Elements (the existing Payment Element); on `payment_intent.succeeded` the existing handler flips the booking → `confirmed`, updates `payments.status`, appends `booking_events`. Confirmation email/SMS sends through `messaging.md` with an event-ticket template variant (merge tags: event name, date/time, ticket breakdown, venue address).
5. **Reservation release** on the sad paths, reusing the shipped deposit **abandonment janitor**: a `requested` event booking with no successful payment after the grace window is cancelled *and its reserved tickets returned* (`quantity_sold = quantity_sold - $q`, floored at 0). Same for `payment_intent.payment_failed` that the guest never retries. Inventory can never leak.
6. **Refunds** use the existing dashboard refund action (`payments-deposits.md` §Refunds) unchanged. Refunding an event booking optionally returns its tickets to inventory (operator checkbox in the refund modal; default **off** — a refund isn't always a resale).

Kill switch (`paymentsDisabled()`) and `stripeEnabled()` gate every entry point exactly as deposits do: with Stripe off, ticket types can't be created and the event page shows the link-out (or "tickets unavailable") rather than a checkout.

## Surfaces

- **Dashboard** `/dashboard/venues/[venueId]/events`: list (upcoming/past, sold vs remaining), create/edit event (name, date/time window, description, hero photo, block scope, external link), manage ticket types (Phase 2), per-event **attendee list** built from `bookings where event_id = …` (reuses the bookings list components + `GuestBadges`), cancel event, refund (Phase 2/3).
- **Public** `/events/[venueSlug]/[eventSlug]` inside the `(widget)` route group so it inherits the cookieless, SSR-first, themable shell (`widget.md`). Server-rendered event hero + description + date; a ticket picker island (Phase 2) → Stripe Elements → success. Link-out mode renders a "Get tickets" `<a target="_blank">` to `external_ticket_url` (same outbound-link posture as the website/TripAdvisor links — not a sub-processor, per `gdpr.md`).
- **Booking calendar** (hosted page + embed): event days deep-link here instead of offering the standard wizard.

## Acceptance criteria

Phase 1 (blocking + CRUD + link-out):
- [ ] `findSlots` drops slots overlapping an injected closure window; stays pure (no DB) and unit-tested for window vs whole-day, timezone (venue-local), and turn-time overlap edges.
- [ ] `/api/v1/availability` and `loadPublicMonthAvailability` load closures once and offer no standard slots on a blocking event's window; a `published` non-blocking event does not affect availability.
- [ ] Month calendar shows an `event` day state that deep-links to the event page and is not selectable as a standard slot.
- [ ] `/api/v1/bookings` re-checks and rejects a standard booking colliding with a blocking event (409, typed reason) even if a stale slot is submitted.
- [ ] Publishing an event that collides with existing standard bookings warns the operator and lists them; it never auto-cancels.
- [ ] Event + closure CRUD gated `hasPlan(plan,"plus")` at both the page (LockedFeature, locked for Free + Core) and the server action (throwing `requirePlan(orgId,"plus")`). RLS: org A cannot read/write org B's `special_events`. Integration-tested.
- [ ] A closure (zero ticket types, `blocks_standard_bookings=true`) works end-to-end with no payments involvement.

Phase 2 (ticketing):
- [ ] Capacity reservation is oversell-proof under concurrency — a test fires N concurrent purchases against a capacity of M<N and confirms exactly M succeed, `quantity_sold = quantity_total`, no negative inventory.
- [ ] Reserved tickets are released when an event booking is abandoned/fails (janitor test against a fake clock, idempotent — a second sweep releases nothing twice).
- [ ] `event_ticket` PaymentIntents are created on the connected account with 3DS forced; unit test asserts `request_three_d_secure:'any'` and `{ stripeAccount }`. No raw card data (CI grep extended to the new route). SAQ-A preserved.
- [ ] Successful purchase → booking `confirmed`, `event_order_items` persisted with snapshotted prices, confirmation sent, attendee appears in the dashboard list. `payments`/`booking` rows are never written outside a handler or server action (CI grep).
- [ ] Refund from the existing booking detail view works for event bookings; ticket-return-to-inventory honours the operator checkbox; partial refund can't exceed amount-minus-prior-refunds (server-enforced).
- [ ] With Stripe off (`paymentsDisabled()`/`stripeEnabled()` false), ticket creation is blocked and the event page degrades to link-out / "unavailable" — never a broken checkout.

## Area-scoped events (Phase 2.5 — pre-launch)

An event may block a subset of the venue's floor-plan **areas** rather than the whole venue. The Terrace runs the ticketed tasting while Main keeps taking standard bookings.

Decisions and invariants:

- **Data model:** `special_event_areas` junction (`event_id`, `area_id`, denormalised `organisation_id`; PK `(event_id, area_id)`; RLS member-read). **Zero rows = whole venue** — every existing event keeps today's behaviour with no backfill, and whole-venue remains the default in the form.
- **Area deletion is restricted, not cascaded.** The junction's `area_id` FK is `ON DELETE NO ACTION`: deleting an area referenced by an event fails with a clear error and the operator edits the event first. Rationale: cascading could silently empty the junction and flip an area-scoped event to whole-venue — a semantic change no one asked for.
- **Availability semantics:** `ClosureWindow` gains `areaIds: string[] | null` (null = whole venue). In `findSlots`, a whole-venue closure drops the candidate slot outright (today's behaviour, unchanged); an area-scoped closure instead **removes that area's tables from the free set** for the window before options are built. If every area is scoped, the free set empties and the slot disappears — whole-venue is literally the degenerate case, one code path. Same-area combining collapses naturally (combos are built from the free set).
- **`venue-closed` stays whole-venue-only.** The distinct 409 reason (and the widget copy pointing at the event) only fires when a whole-venue closure covers the requested instant. An area-scoped closure that eliminates a specific slot is ordinary `no-availability` — other areas may well have tables, so "the venue is closed" would be wrong.
- **Month calendar — the mixed day.** A day covered only by area-scoped events is *both* bookable and an event day. Day classification: `"event"` **only when a whole-venue blocking event covers the day**; otherwise the day classifies open/full/closed as normal from the remaining tables. The per-day `events` map is populated for *any* day overlapped by a published blocking event (whole-venue or scoped), and the calendar renders scoped-event days as a normal bookable cell plus a slim **event banner** beneath the calendar ("🎟 {name} · {date} — tickets") linking to the event page. Banner, not in-cell dual targets: a 40px grid cell can't hold two tap targets accessibly.
- **Publish-collision warning scopes too:** publishing an area-scoped event counts only standard bookings whose `area_id` is in the scoped set.
- **Tickets stay GA.** Ticket capacity is still an operator-set number, deliberately not derived from the area's covers (an event can pack a terrace beyond its seated capacity, or cap below it). The ticket-type form shows the scoped areas' total covers as a **hint**, never enforcement.
- **Purchase flow untouched.** Reservation, Stripe intent, janitor, webhook — all unaware of areas.

## Out of scope

- **Reserved-seat / table selection for events.** Events sell general-admission ticket counts against event capacity (GA within the scoped areas once Phase 2.5 lands), not specific tables — that's the whole point of bypassing the table-availability engine. Table booking stays the standard flow.
- **Recurring-event engine.** Beaujolais Day is annual, but recurrence is handled by a Phase 3 "duplicate event" clone, not a schedule engine.
- **Waitlist for sold-out events.** Could later reuse `waitlist.md`; not MVP.
- **Dynamic / time-based pricing** (early-bird tiers auto-expiring). Operators create a new tier manually.
- **Cross-venue / multi-venue single event.** One event belongs to one venue.
- **Dedicated ticket PDFs / barcodes.** Phase 3 check-in may add a QR; the confirmation email is the ticket at MVP.
- **Multi-currency.** GBP pence only, column present for forward-compat (same as deposits).

## Deferred (Phase 3 detail)

- Per-ticket **menu / offer pre-selection** + paid add-ons — needs a small menu/option model (`event_menu_options` keyed to ticket type) and per-item choices captured on `event_order_items`; feeds the kitchen via the attendee list. This is the "pre-book offers/menus" ask, held until ticketing is solid.
- **Event cancellation with bulk refund** — cancel a `published` event, stop sales, and fan out refunds across every event booking in one operator action (reuses the refund path per booking; idempotent).
- **Door check-in** — mark attendees arrived from the event's attendee list; optional QR in the confirmation email.
- **Event revenue reporting** — covers + gross ticket revenue per event, folded into `reporting.md`.
