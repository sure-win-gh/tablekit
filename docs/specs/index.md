# Feature specs

This folder holds the source of truth for every feature. Claude should read the relevant spec **before** writing any code for a feature and update it afterwards if the design changed.

## MVP features (weeks 1–12)

| # | Spec                        | Status | Notes |
|---|-----------------------------|--------|-------|
| 1 | [`auth.md`](auth.md)         | draft  | Sign up, login, organisations, roles |
| 2 | [`venues.md`](venues.md)     | draft  | Venue + service + floor plan model |
| 3 | [`bookings.md`](bookings.md) | draft  | Availability, create/update, status workflow |
| 4 | [`widget.md`](widget.md)     | draft  | Embeddable widget + hosted booking link |
| 5 | [`payments.md`](payments.md) | draft  | Deposits, Stripe Connect, no-show capture — charter |
| 5a| [`payments-deposits.md`](payments-deposits.md) | shipped | Deposits + card hold + refunds + no-show capture (flows A/B/C) |
| 6 | [`messaging.md`](messaging.md) | draft | Email + SMS transactional flow |
| 7 | [`guests.md`](guests.md)     | draft  | Guest profiles, CRM basics, tags |
| 8 | [`waitlist.md`](waitlist.md) | draft  | Walk-in + waitlist |
| 9 | [`reserve-with-google.md`](reserve-with-google.md) | draft | RWG integration |
|10 | [`reporting.md`](reporting.md) | draft | Cover, revenue, no-show reporting |

## Plus-tier features (weeks 13–24)

| # | Spec                                | Notes |
|---|-------------------------------------|-------|
|11 | [`multi-venue.md`](multi-venue.md)   | Group dashboard |
|12 | [`ai-enquiry.md`](ai-enquiry.md)     | LLM-assisted natural-language bookings |
|13 | [`import-export.md`](import-export.md) | Migration from ResDiary / OpenTable / CSV |
|14 | [`public-api.md`](public-api.md)     | REST API + webhooks |

## How to use

1. Before implementing a feature, open its spec and check the acceptance criteria.
2. If the spec is missing a detail you need, update the spec (and commit) before coding.
3. After implementing, update the "Status" line and add a link to the PR in the spec footer.
4. If no spec exists for what you're about to build, create one first (`/spec <name>`).
