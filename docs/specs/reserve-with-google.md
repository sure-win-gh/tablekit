# Spec: Reserve with Google integration

**Status:** paused (2026-04-26) — blocked on Google partner onboarding + spec needs fleshing out before code starts.
**Depends on:** `bookings.md`, `payments-deposits.md` (RWG bookings skip the deposit branch)

## What we're building

Inbound bookings from a venue's Google Business Profile via Reserve with Google (RWG). This is critical for independents — it's free traffic from Maps and Search.

## Why this is paused

1. **Google partner onboarding is the long pole.** Multi-week commercial + technical review (4–8 weeks). No code path can be smoke-tested end-to-end without a sandbox slot from Google. Application has not yet been started.
2. **The current spec is a stub.** Three protobuf endpoints + HMAC + two GCS feeds is the largest external surface in the project; the detail below is not enough to plan from.

## To pick this back up

**Before any code:**
1. Start the Google partner application: <https://partnerdash.google.com/apply/reservewithgoogle> (or whichever URL the docs land on at the time). Note the application reference and contact email here.
2. Flesh out this spec — see "Open questions" below — and bump status to `draft`.
3. `/plan` against the fleshed-out spec; the current expectation is roughly 5–7 waves (DB schema → HMAC + protobuf scaffolding → CheckAvailability → CreateBooking → outbound feeds + cron → smoke + dashboard surfaces → ops docs).

## API contract (Actions Center / Booking Server)

Google calls three endpoints on our server:
- `/rwg/v3/HealthCheck`
- `/rwg/v3/CheckAvailability` — returns slots for a venue, service, party size, time range.
- `/rwg/v3/CreateBooking` — creates a booking on our side.

Plus two outbound calls (feeds) from us:
- Merchant feed — list of venues (weekly).
- Availability feed — bookable slots (continuous).

All messages are protobuf over HTTPS with HMAC signatures.

## Open questions (resolve before planning)

- **Protobuf version** to pin (Booking Server v3 is current at time of writing — confirm).
- **Where the .proto files live** in the repo (`lib/rwg/proto/`?) and how they're compiled (`ts-proto`? `protobuf-ts`?).
- **HMAC scheme:** key rotation policy, request/response signing on both directions, how the secret is stored (encrypted env var? Supabase Vault?).
- **Feed schema + cadence:** merchant feed is weekly per the spec; availability feed is "continuous" — what does that mean in practice (every 5 min? on every booking mutation?). Where does GCS auth live (service account JSON in env)?
- **Availability engine reuse:** we already have one for the widget — confirm `CheckAvailability` calls into the same code path, doesn't duplicate.
- **`createBooking` no-deposit branch:** RWG bookings must skip deposit charging regardless of `deposit_rules`. Decide: short-circuit inside `createBooking` when `source === 'rwg'`, or pass `requireDeposit: false` from the route? Pick one and document.
- **Idempotency on inbound CreateBooking:** Google's request ID → our idempotency key. What's the unique constraint? (Likely `(source, external_id)` on `bookings`.)
- **Source enum:** add `'rwg'` to `bookings.source` CHECK constraint. Migration is forward-only; coordinate with whatever else lands in the same release.
- **Error mapping:** RWG expects specific error codes (`SLOT_UNAVAILABLE`, `MERCHANT_NOT_FOUND`, etc). Map our internal `BookingFailureReason` → RWG codes.
- **Dashboard surfaces:** do operators need a "RWG status" panel (last feed upload, last inbound call, error log)? Probably yes — define what fields it shows.

## Acceptance criteria

- [ ] `CheckAvailability` reuses the same availability engine as our widget (no duplication).
- [ ] `CreateBooking` writes a `bookings` row with `source = 'rwg'`.
- [ ] HMAC verified on every inbound call.
- [ ] Feed uploaded to Google's GCS bucket on cron.
- [ ] RWG-sourced bookings never require a deposit (Google's rule).
- [ ] Idempotent on Google's request ID — replays don't double-book.
- [ ] Dashboard panel shows feed health + recent inbound errors.

## Out of scope until later

- RWG's "prepayment" flow (not needed — we don't require deposits for RWG bookings).
- Google Reserve for restaurants with specific dish-level availability.
