# Feature specs

This folder holds the source of truth for every feature. Claude should read the relevant spec **before** writing any code for a feature and update it afterwards if the design changed.

## MVP features (weeks 1–12)

| # | Spec                        | Status | Notes |
|---|-----------------------------|--------|-------|
| 1 | [`auth.md`](auth.md)         | shipped | Sign up, login, multi-org membership + sidebar switcher, role + plan + venue gates, RLS, TOTP MFA enforcement for owners/managers, team invite flow. |
| 2 | [`venues.md`](venues.md)     | shipped | Venue + service + floor plan model, opinionated seed templates per venue_type, drag-drop floor plan (see `floor-plan-visual.md`), JSON schedule + per-service turn time, RLS-tested cross-tenant isolation. URL slug routing split out into `venue-slug.md`. |
| 3 | [`bookings.md`](bookings.md) | shipped | Public anonymous create + availability, transactional creation with deposits, GIST exclusion against double-booking, code-enforced state machine + booking_events audit, IP+email rate limits, RLS-tested cross-tenant isolation. |
| 4 | [`widget.md`](widget.md)     | shipped | 959 B gzipped iframe loader + cookieless + SSR-first `/book/[slug]` + zero third-party analytics. CSP header + `prefers-*` respect deferred — see spec. |
| 5 | [`payments.md`](payments.md) | superseded | Original charter — live spec is `payments-deposits.md` below. |
| 5a| [`payments-deposits.md`](payments-deposits.md) | shipped | Deposits + card hold + refunds + no-show capture (flows A/B/C) |
| 6 | [`messaging.md`](messaging.md) | shipped | Email + SMS transactional flow (waitlist_ready ships with waitlist) |
| 7 | [`guests.md`](guests.md)     | shipped | Envelope-encrypted PII (email/last name/phone/DoB/notes), hashed lookup, per-channel marketing consent (off by default), RLS-tested isolation, DSAR erasure with 30-day SLA + scrub job, Plus-tier group-CRM opt-in. |
| 8 | [`waitlist.md`](waitlist.md) | shipped | Walk-in + waitlist |
| 9 | [`reserve-with-google.md`](reserve-with-google.md) | paused | Blocked on Google partner onboarding + spec needs fleshing out — see file |
|10 | [`reporting.md`](reporting.md) | shipped | Covers, no-show rate, deposits, source mix, top guests + CSV export |
|11 | [`timeline.md`](timeline.md) | shipped | Per-table time-blocks view + drag-to-reassign |
|12 | [`floor-plan-visual.md`](floor-plan-visual.md) | shipped | SVG canvas, role-gated edit mode with drag-persist, wheel/button pan+zoom, fit-to-viewport, 30s auto-refresh, multi-table connectors, mobile read-only. |
|13 | [`reviews.md`](reviews.md)   | partial | Phase 1, 2, 3a–c, 6, 7a shipped; Phase 4 + 5 deferred; Phase 7b cut |
|14 | [`venue-slug.md`](venue-slug.md) | shipped | Friendly public URLs (`book.tablekit.uk/jane-cafe`); UUID URLs keep working + 308-redirect |

## Plus-tier features (weeks 13–24)

| # | Spec                                | Notes |
|---|-------------------------------------|-------|
|11 | [`multi-venue.md`](multi-venue.md)   | shipped — group overview + cross-venue guests + venue-scoped RLS + ⌘K switcher |
|12 | [`ai-enquiry.md`](ai-enquiry.md)     | shipped — inbound webhook + Bedrock parser + runner/cron + operator inbox + 90-day retention sweep + opt-in auto-send (guardrail-gated) + per-venue sending-domain setup (Resend DKIM/SPF/DMARC verification UI). Using the verified domain in `From:` deferred — see spec. |
|13 | [`import-export.md`](import-export.md) | shipped — inline CSV+JSON export + competitor-format import (OpenTable / ResDiary / SevenRooms) with mapping wizard. Manual UI verification + adapter-signature confirmation tracked separately. |
|14 | [`public-api.md`](public-api.md)     | shipped — Bearer-auth REST API at `api.tablekit.uk/v1` (bookings + read-extras + idempotency) + webhook subscriptions/deliveries/replay + 90d request log + OpenAPI 3.1 + Stoplight docs at `/docs/api`. |

## Internal tools

| #  | Spec                                       | Notes |
|----|--------------------------------------------|-------|
| 99 | [`admin-dashboard.md`](admin-dashboard.md) | shipped — founder-only platform metrics, ops health, venue search. Live Stripe pull for MRR; env allowlist auth. CSV export + recharts deferred. |

## How to use

1. Before implementing a feature, open its spec and check the acceptance criteria.
2. If the spec is missing a detail you need, update the spec (and commit) before coding.
3. After implementing, update the "Status" line and add a link to the PR in the spec footer.
4. If no spec exists for what you're about to build, create one first (`/spec <name>`).
