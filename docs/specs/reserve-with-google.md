# Spec: Reserve with Google integration

**Status:** draft (blocked by Google partner onboarding)
**Depends on:** `bookings.md`

## What we're building

Inbound bookings from a venue's Google Business Profile via Reserve with Google (RWG). This is critical for independents — it's free traffic from Maps and Search.

## Preconditions

- Apply to Google as a booking partner. Onboarding is a multi-week process with technical and commercial review. Start this in week 1 of the build.
- Google requires a sandbox-passing implementation before production.

## API contract (Actions Center / Booking Server)

Google calls three endpoints on our server:
- `/rwg/v3/HealthCheck`
- `/rwg/v3/CheckAvailability` — returns slots for a venue, service, party size, time range.
- `/rwg/v3/CreateBooking` — creates a booking on our side.

Plus two outbound calls (feeds) from us:
- Merchant feed — list of venues (weekly).
- Availability feed — bookable slots (continuous).

All messages are protobuf over HTTPS with HMAC signatures.

## Acceptance criteria

- [ ] `CheckAvailability` reuses the same availability engine as our widget (no duplication).
- [ ] `CreateBooking` writes a `bookings` row with `source = 'rwg'`.
- [ ] HMAC verified on every inbound call.
- [ ] Feed uploaded to Google's GCS bucket on cron.
- [ ] RWG-sourced bookings never require a deposit (Google's rule).

## Out of scope until later

- RWG's "prepayment" flow (not needed — we don't require deposits for RWG bookings).
- Google Reserve for restaurants with specific dish-level availability.
