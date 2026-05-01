# Feature specs

This folder holds the source of truth for every feature. Claude should read the relevant spec **before** writing any code for a feature and update it afterwards if the design changed.

## MVP features (weeks 1–12)

| # | Spec                        | Status | Notes |
|---|-----------------------------|--------|-------|
| 1 | [`auth.md`](auth.md)         | draft  | Sign up, login, organisations, roles |
| 2 | [`venues.md`](venues.md)     | partial | Venue + service + floor plan model; URL slug routing shipped (no slug-specific spec written) |
| 3 | [`bookings.md`](bookings.md) | partial | Day list with search/filter, detail/edit dialog, table picker shipped; full acceptance-criteria sweep still pending |
| 4 | [`widget.md`](widget.md)     | partial | Embeddable iframe loader + `/embed` route + dashboard snippet shipped; remaining acceptance criteria pending |
| 5 | [`payments.md`](payments.md) | draft  | Deposits, Stripe Connect, no-show capture — charter |
| 5a| [`payments-deposits.md`](payments-deposits.md) | shipped | Deposits + card hold + refunds + no-show capture (flows A/B/C) |
| 6 | [`messaging.md`](messaging.md) | shipped | Email + SMS transactional flow (waitlist_ready ships with waitlist) |
| 7 | [`guests.md`](guests.md)     | partial | Per-guest profile + consent + erasure shipped; erasure scrub job shipped; remaining CRM acceptance criteria pending |
| 8 | [`waitlist.md`](waitlist.md) | shipped | Walk-in + waitlist |
| 9 | [`reserve-with-google.md`](reserve-with-google.md) | paused | Blocked on Google partner onboarding + spec needs fleshing out — see file |
|10 | [`reporting.md`](reporting.md) | shipped | Covers, no-show rate, deposits, source mix, top guests + CSV export |
|11 | [`timeline.md`](timeline.md) | shipped | Per-table time-blocks view + drag-to-reassign |
|12 | [`floor-plan-visual.md`](floor-plan-visual.md) | partial | SVG canvas + booking-status overlay shipped; edit-mode drag-persist + pan/zoom + viewport-fit pending |
|13 | [`reviews.md`](reviews.md)   | partial | Phase 1, 2, 3a–c, 6, 7a shipped; Phase 4 + 5 deferred; Phase 7b cut |

## Plus-tier features (weeks 13–24)

| # | Spec                                | Notes |
|---|-------------------------------------|-------|
|11 | [`multi-venue.md`](multi-venue.md)   | shipped — group overview + cross-venue guests + venue-scoped RLS + ⌘K switcher |
|12 | [`ai-enquiry.md`](ai-enquiry.md)     | not started — LLM-assisted natural-language bookings |
|13 | [`import-export.md`](import-export.md) | partial — inline CSV+JSON export for guests + bookings shipped; competitor-format import (ResDiary / OpenTable / CSV) not yet |
|14 | [`public-api.md`](public-api.md)     | not started — REST API + webhooks |

## Internal tools

| #  | Spec                                       | Notes |
|----|--------------------------------------------|-------|
| 99 | [`admin-dashboard.md`](admin-dashboard.md) | shipped — founder-only platform metrics, ops health, venue search. Live Stripe pull for MRR; env allowlist auth. CSV export + recharts deferred. |

## How to use

1. Before implementing a feature, open its spec and check the acceptance criteria.
2. If the spec is missing a detail you need, update the spec (and commit) before coding.
3. After implementing, update the "Status" line and add a link to the PR in the spec footer.
4. If no spec exists for what you're about to build, create one first (`/spec <name>`).
