# Phase: `widget` — public booking flow

## Goal

A hospitality guest can visit `https://tablekit.uk/book/<venueId>`, pick a date / party size / time, fill their details, and confirm. No login. The same API that powers this form is the public contract for iframe embeds and Reserve-with-Google later.

`bookings` shipped host-only; this phase adds the anonymous path without changing any of the core domain logic.

## Architectural decisions (locked)

| # | Decision |
|---|---|
| W1 | URL: `/book/<venueId>`. A pretty slug is deferred (adds write-path complexity and isn't needed to ship). |
| W2 | Public reads bypass RLS via `adminDb` wrapped in `lib/public/venue.ts` helpers. No new RLS policies — keeps the security surface tight and the read shape auditable. |
| W3 | Rate limiter = `lib/public/rate-limit.ts`. Uses Upstash Redis if `UPSTASH_REDIS_REST_URL` is set; otherwise a permissive fallback (dev / CI). Limit: **5 booking attempts per IP per 10 min**; **20 reads per IP per min** for the availability path. |
| W4 | Captcha = `lib/public/captcha.ts`. Verifies hCaptcha token if `HCAPTCHA_SECRET` is set; otherwise passes through. Token required at the API boundary; form includes the hCaptcha widget when `NEXT_PUBLIC_HCAPTCHA_SITEKEY` is set. |
| W5 | `POST /api/v1/bookings` — the public contract. JSON in/out. Calls `createBooking` under the hood with `source: "widget"`. Returns `{ bookingId, reference }` on success; `{ error: "..." }` with an appropriate HTTP status otherwise. |
| W6 | No email confirmation this phase — success page only. Messaging phase adds it. |
| W7 | Short booking reference: first 8 chars of the UUID uppercased (`A1B2-C3D4`). Not guaranteed unique but collision is 1-in-many-millions at our scale and the full UUID is the authoritative handle. |
| W8 | `requires_deposit` / `min_party_for_deposit` settings don't exist yet. All widget bookings go straight to `confirmed` — same as host. |
| W9 | No kill switch wiring this phase. `WIDGET_DISABLED` env var is plumbed in `.env.local.example` but the read is deferred to an incident-response phase. |

## Non-goals

- Embed iframe + cross-origin story (later — still same-origin).
- Pretty slug (`/book/wellies-cafe`) — later.
- ToS acceptance UI — deferred; terms page doesn't exist yet.
- Abuse heuristics beyond rate limit + captcha (e.g. velocity across venues) — waitlist phase.
- Guest self-service cancel tokenised link — messaging phase owns the email + token infra.

## Deliverables

1. `lib/public/rate-limit.ts` — Upstash-backed sliding-window limiter with a permissive local fallback.
2. `lib/public/captcha.ts` — hCaptcha server verification, permissive when unset.
3. `lib/public/venue.ts` — `loadPublicVenue(venueId)` + `loadPublicAvailability({venueId, date, partySize})`. Both read via `adminDb` and scrub anything sensitive from the return shape.
4. `app/api/v1/bookings/route.ts` — POST handler. Zod-validates JSON, rate limits, verifies captcha, calls `createBooking`. CORS headers for future embed work (same-origin today).
5. `app/api/v1/availability/route.ts` — GET handler for the slot picker if we want to go client-rendered later. (MVP: the page is server-rendered and does not hit this route.)
6. `app/(widget)/book/page.tsx` — updated placeholder pointing users to the per-venue URL if they arrive without one.
7. `app/(widget)/book/[venueId]/page.tsx` + `forms.tsx` — server-rendered slot picker + guest form, URL-driven (date/party/serviceId/wallStart), post-submit success state.
8. `proxy.ts` — confirm `/book/*` isn't gated.
9. `.env.local.example` — already lists the relevant keys; double-check.
10. Unit tests: rate-limit fallback, captcha fallback, booking-ref formatter.
11. Integration test: `POST /api/v1/bookings` happy path + invalid-captcha rejection + rate-limit rejection under repeated calls.
12. E2E: visit `/book/<venueId>`, create a booking, see the success panel with the reference.

## Tasks

| # | Task |
|---|---|
| 1 | `lib/public/rate-limit.ts` with `rateLimit(key, limit, windowSec)` returning `{ ok, remaining, retryAfterSec? }`. Upstash via fetch (no SDK dep). |
| 2 | `lib/public/captcha.ts` with `verifyCaptcha(token, ip)`. |
| 3 | `lib/public/venue.ts` with `loadPublicVenue` + `loadPublicAvailability`. |
| 4 | `app/api/v1/bookings/route.ts` — POST handler, zod input, rate limit by IP, captcha verify, call createBooking, map domain errors to status codes, return `{ ok, bookingId, reference }`. |
| 5 | `/book/[venueId]/page.tsx` + `forms.tsx` — server-rendered slot grid like the host form, guest fields + optional captcha widget, fetch-driven submit, success state rendered inline. |
| 6 | Update placeholder `/book` page. |
| 7 | Unit tests for rate-limit and captcha fallback paths. |
| 8 | Integration test for the API route. |
| 9 | E2E smoke. |
| 10 | Commits: `feat(widget): public helpers + API route + rate limit + captcha` and `feat(widget): public /book/<venueId> UI + e2e`. |

## Success criteria

- A guest with no login can book at a venue via `/book/<venueId>`.
- The booking lands in the DB with `source = 'widget'` and a `guest.created` or `guest.reused` audit entry.
- Two IP-bound rapid attempts exceed the limit and the API returns 429.
- A bad captcha token fails the API call with 400 (when `HCAPTCHA_SECRET` is set).
- All prior unit + integration + e2e tests still pass.
