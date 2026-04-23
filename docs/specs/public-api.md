# Spec: Public REST API (Plus tier)

**Status:** draft — Plus tier only
**Depends on:** `auth.md`, `bookings.md`

## What we're building

A small, stable REST API for Plus customers to integrate with their own tooling (loyalty systems, EPoS, bespoke websites, analytics pipelines). Scope is intentionally narrow on launch — we grow it based on real demand.

## Why this matters

Independent operators often have a Squarespace site, a Lightspeed till, and a mailing list in Mailchimp. A working API gives us a credible "it plays nicely with your stack" story and limits churn triggers.

## Endpoints (launch set)

All under `https://api.tablekit.uk/v1`. JSON in, JSON out.

- `GET /bookings` — list bookings, filterable by venue, date range, status.
- `GET /bookings/:id`
- `POST /bookings` — create (respecting availability rules).
- `PATCH /bookings/:id` — cancel, reschedule.
- `GET /guests`
- `GET /guests/:id`
- `GET /venues`
- `GET /services`

Write endpoints on guests/venues/services are deferred — the dashboard stays canonical for setup.

## Authentication

- API keys (`sk_live_*`) issued per organisation from the dashboard.
- Keys scoped by `organisation_id`. No cross-org keys.
- Rotate-on-demand button in dashboard. Revocation is immediate.
- Keys hashed at rest (SHA-256). Shown once at creation.

## Rate limits

- 600 requests per minute per key (10/s sustained).
- 429 with `Retry-After` header when exceeded.
- Per-key quota tracked in Upstash Redis.

## Webhooks (outbound)

Plus customers can register webhook endpoints to receive:
- `booking.created`
- `booking.updated`
- `booking.cancelled`
- `booking.seated`
- `booking.no_show`

Delivery:
- Signed with `X-TableKit-Signature: sha256=<hmac(secret, body)>`.
- Retries on 5xx: 5 attempts, exponential backoff over ~24 hours.
- Delivery log visible in dashboard with replay button.

## Acceptance criteria

- [ ] All endpoints versioned (`/v1`). Breaking changes require `/v2`.
- [ ] OpenAPI spec auto-generated from Zod schemas (`zod-to-openapi`). Published at `/v1/openapi.json`.
- [ ] Rate limits enforced at the edge.
- [ ] Writes respect the same RLS and availability engine as the dashboard.
- [ ] Idempotency key (`Idempotency-Key` header) supported on POST / PATCH.
- [ ] All requests logged (method, path, org, status, latency). No request bodies logged.

## Out of scope

- GraphQL.
- Soap / WebDAV / any 2005 protocol.
- Partner marketplace (revisit once we have >100 Plus customers).
