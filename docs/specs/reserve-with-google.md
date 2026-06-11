# Spec: Reserve with Google integration

**Status:** paused (2026-04-26; spec refreshed 2026-05-30 against current Google docs).
**Depends on:** `bookings.md`, `payments-deposits.md`

> **Program name.** "Reserve with Google" is the consumer-facing brand. In Google's developer docs the program is now **Actions Center / Reservations End-to-End** (REST + JSON, v3). The legacy "Booking Server v2 + HMAC" model is deprecated — do not implement from old docs.

## What we're building

Inbound bookings from a venue's Google Business Profile via the Actions Center Reservations E2E vertical. Critical for independents — free traffic from Maps and Search, and as of April 2026 the entry point into Google's AI-Mode booking experience in the UK.

## Why this is paused

1. **UK partner intake post-April-2026 is unconfirmed.** Google launched the UK Reservations E2E + AI-Mode booking surface on 2026-04-10 with 8 launch partners already locked in (TheFork, SevenRooms, ResDiary, Mozrest, Foodhub, Dojo, DesignMyNight, OpenTable). Whether Google is currently taking new UK applicants is the gating risk. Confirm before any sprint commits to RWG.
2. **No paying merchants to list yet.** The application asks for 5 sample Google Business Profile links + signed-merchant-agreement status. Tablekit doesn't have either today.
3. **Onboarding SLA unverified.** Google publishes no SLA for Reservations E2E. The adjacent Local Services E2E vertical is 12–16 weeks per Google's own docs — plan accordingly rather than the previous 4–8 week internal guess.

## To pick this back up

1. **Confirm UK intake is open.** Outreach to Google's partner programme (Developer Relations / LinkedIn) or via the partner interest form (<https://services.google.com/fb/forms/reservationsappointmentsonlinebooking-interestform/>) with an explicit cover note. Record the response date + reference here.
2. **Recruit ≥5 paying merchants** willing to be sample GBPs on the application and sign a partner-merchant agreement (template TBD).
3. **Resolve the open questions below** and bump status to `draft`.
4. `/plan` against the fleshed-out spec; rough wave estimate is 6–8 waves: DB schema + source enum → Basic-Auth credentials + REST scaffolding → `BatchAvailabilityLookup` → `CreateBooking` + `UpdateBooking` + `SetMarketingPreference` → outbound feeds + Real-Time Updates + SFTP → smoke + dashboard surfaces → ops docs.

## API contract (Actions Center / Reservations E2E)

REST + JSON over HTTPS. Five inbound RPCs Google calls on our server:

- `GET /v3/HealthCheck/`
- `POST /v3/BatchAvailabilityLookup/` — bulk availability lookups. The legacy `CheckAvailability` is **deprecated**; do not implement it for new partners.
- `POST /v3/CreateBooking/`
- `POST /v3/UpdateBooking/`
- `POST /v3/SetMarketingPreference/`

Partner → Google outbound:

- **Merchant feed** — daily SFTP upload of the venue list. Google provisions the SFTP dropbox during onboarding.
- **Availability feed** — daily SFTP upload of bookable slots; minimum cadence is one upload per day for 7 consecutive days, covering 30 days of forward availability, marked `PROCESS_AS_COMPLETE`.
- **Real-Time Updates / BookingNotification** — separate REST API for booking-mutation deltas between feed uploads (not the feed itself).

**Auth: HTTPS Basic Auth — NOT HMAC.** Username/password are configured in Google's Partner Portal and **expire every 6 months**. Rotation must be planned (calendar reminder + zero-downtime swap). The earlier internal assumption of "HMAC signing both directions" was wrong; ignore it.

## Open questions (resolve before planning)

- **Intake status (gating).** Is Google accepting new UK Reservations E2E partners post-April-2026, or is the programme closed pending performance review of the 8 launch partners? Until answered, this spec stays paused.
- **Commercial terms.** Working assumption: free for partners, no revenue share. PPC.land reporting around the April 2026 launch confirms no revenue-share disclosed, but get this in writing during onboarding.
- **Credential rotation.** How do we surface the 6-month Partner Portal password rotation in ops (Vercel env + secrets manager + cron alert?). Decide secret storage: env var, Supabase Vault, or 1Password reference.
- **Feed proto bundle.** Where do the feed schemas live (`lib/rwg/feeds/`?) and how are they generated. Google publishes a "Feeds Proto Bundle" but the canonical `.proto` URL isn't surfaced in current docs (sample code at `maps-booking.googlesource.com/maps-booking-v3/` is ~6 years stale). Likely path: request the current bundle from Google during onboarding, vendor under `lib/rwg/feeds/proto/`, compile with `ts-proto`.
- **SFTP delivery.** Host details (Google-provided), authentication (key pair issued at onboarding), and where the SFTP credentials live.
- **Real-Time Updates auth + retry.** What credentials does the outbound REST use, what's the failure backoff, and where do failed deliveries surface on the ops surface?
- **Availability engine reuse.** `BatchAvailabilityLookup` must call into the same availability engine the widget uses (no duplication). Confirm the engine handles bulk lookups efficiently (today widget is single-slot per request).
- **Deposits.** Google's "no deposit" rule is **superseded** — partner-side prepayments are now permitted under the Reservations E2E integration policy, and Tock has offered paid RWG reservations since Jan 2025. Decide: do RWG bookings respect the per-venue deposit setting (parity with widget) or short-circuit deposits for RWG (lower friction at booking moment)? Document the choice.
- **Idempotency on inbound `CreateBooking`.** Google's request ID → our idempotency key. Likely unique constraint: `(source, external_id)` on `bookings`.
- **`source` enum.** Add `'rwg'` to the `bookings.source` CHECK constraint. Forward-only migration; coordinate with whatever else lands in the same release.
- **RWG error mapping.** Map our internal `BookingFailureReason` → Google's `BookingFailure` cause enum. Canonical values today: `CAUSE_UNSPECIFIED`, `SLOT_UNAVAILABLE`, `SLOT_ALREADY_BOOKED_BY_USER`, `LEASE_EXPIRED`, `OUTSIDE_CANCELLATION_WINDOW`, `PAYMENT_ERROR_CARD_TYPE_REJECTED`, `PAYMENT_ERROR_CARD_DECLINED`, `PAYMENT_OPTION_NOT_VALID`, `PAYMENT_ERROR`, `USER_CANNOT_USE_PAYMENT_OPTION`, `BOOKING_ALREADY_CANCELLED`, `BOOKING_NOT_CANCELLABLE`, `OVERLAPPING_RESERVATION`, `USER_OVER_BOOKING_LIMIT`, `OFFER_UNAVAILABLE`, `PAYMENT_REQUIRES_3DS1`, `UNSUPPORTED_NAME`, `UNSUPPORTED_PHONE_NUMBER`, `BANNED_USER`. There is no `MERCHANT_NOT_FOUND` in this enum — merchant-mismatch is handled at the transport layer (REST 400 / gRPC `INVALID_ARGUMENT`), not via `BookingFailure`.
- **Dashboard surfaces.** Per-venue panel showing last feed upload + last inbound call + recent inbound errors + Basic-Auth credential-expiry countdown.
- **Tenant data + RLS.** Any new RWG tables (e.g. `rwg_inbound_requests`, `rwg_feed_uploads`) ship with RLS policy + cross-tenant integration test in the same migration, per CLAUDE.md rule 3.

## Acceptance criteria

- [ ] `BatchAvailabilityLookup` reuses the existing widget availability engine (no duplication) and handles bulk requests in a single round-trip.
- [ ] `CreateBooking`, `UpdateBooking`, `SetMarketingPreference` all wired and idempotent on Google's request ID.
- [ ] All inbound requests authenticate via HTTPS Basic Auth against credentials stored in our secrets layer; rotation runbook documented.
- [ ] Daily SFTP feed uploads (merchant + availability) succeed; on-call alert if a daily upload is missed.
- [ ] Real-Time Updates push booking mutations to Google within 60 s of write, with retry + on-call alert on persistent failure.
- [ ] RWG-sourced bookings honour the per-venue deposit policy decision (see Open Q).
- [ ] Replayed Google requests don't double-book (idempotent on Google's request ID).
- [ ] Dashboard panel shows feed health + recent inbound errors + Basic-Auth credential-expiry countdown.

## Out of scope

- Google Pay / Google-side prepayment flows. Any deposits use the existing Stripe Connect path.
- Other Actions Center verticals (Business Link, Offers, Waitlists).
- Reservations Optimization API (post-MVP).

## Sources (fetched 2026-05-30)

- Program overview: <https://developers.google.com/actions-center/verticals/reservations/e2e/overview>
- Booking-server implementation: <https://developers.google.com/actions-center/verticals/reservations/e2e/integration-steps/implement-booking-server>
- Booking-server-ready RPC list: <https://developers.google.com/actions-center/verticals/reservations/e2e/integration-steps/booking-server-ready>
- `BookingFailure` enum: <https://developers.google.com/actions-center/verticals/reservations/e2e/reference/booking-server-api-rest/e2e-definitions/bookingfailure-definition>
- Availability feed: <https://developers.google.com/actions-center/verticals/reservations/e2e/integration-steps/feeds/availability-feed>
- Integration policies (deposits): <https://developers.google.com/actions-center/verticals/reservations/e2e/policies/integration-policies>
- Partner interest form: <https://services.google.com/fb/forms/reservationsappointmentsonlinebooking-interestform/>
- UK April 2026 launch context: <https://ppc.land/googles-ai-mode-now-books-uk-restaurants-meet-the-8-partner-platforms/>
- v3 sample repo (stale, reference only): <https://maps-booking.googlesource.com/maps-booking-v3/>
