# Spec: Booking insights

**Status:** shipped — lead-time histogram (PR1), no-show evolution + channel performance (PR2), period comparison band (PR3). Plus-tier `/reports/insights` surface.
**Depends on:** `reporting.md`, `bookings.md`

## What we're building

A second, deeper analytics surface that sits alongside the MVP reports. Where `reporting.md` answers *what happened yesterday*, Booking Insights answers *how is the business changing*: lead time, the no-show trend, channel mix shifts, and like-for-like period comparisons.

## Why this matters

Operators have asked two questions repeatedly that the MVP reports don't answer well:

1. "Are my no-shows getting worse?" — needs a trend line, not a single number.
2. "Is the widget actually winning bookings vs phone?" — needs channel performance side-by-side, not just a source mix donut.

Existing `reporting.md` deferred week/month/year rollups; Insights is where they land.

## Insights (Plus tier)

1. **Lead time distribution.** Histogram of `created_at → start_at` bucketed (same-day, 1d, 2–3d, 4–7d, 8–14d, 15–30d, 30d+). Filterable by service and party-size band. The "this is a same-day-driven business vs a planned-bookings business" question in one chart.
2. **No-show + cancellation evolution.** Stacked line: no-show rate and cancellation rate per period, with the with-deposit cohort overlaid. Period selector (day / week / month / year).
3. **Channel performance.** Per-source table: bookings created, no-show rate, cancellation rate, average party size, average lead time, and (when payments exist) deposit capture rate. Sources = the existing `bookings.source` enum (`widget`, `rwg`, `phone`, `walk-in`, `api`).
4. **Period comparison.** A toggle that compares the current range against the previous equal-length window (immediately preceding) via a headline band — bookings (±%), no-show rate (±pp), same-day share (±pp). *Shipped as a top-of-page band rather than per-card deltas: the surface uses a free from/to range, not named periods, so "previous equivalent" is the contiguous window of identical duration, and three headline deltas read more cleanly than a delta beside every chart.*

## Technical approach

- Same live-query posture as `reporting.md` — single GROUP BY per insight, on the existing `bookings_venue_start_idx` and the new `bookings_venue_created_idx` (lead-time queries bucket by `created_at`, which isn't covered alongside venue by the start_at index).
- All venue-local day bucketing uses the existing `(… AT TIME ZONE <venue-tz>)::date` idiom. The no-show evolution query returns **daily** rows; week/month/year rollups happen client-side (in `NoShowTrendCard`) so toggling granularity never re-queries — no server-side `date_trunc` needed.
- Comparison period derived in TypeScript from the selected range — query layer stays dumb, the "previous equivalent" maths live in `lib/reports/insights/compare.ts` alongside pure headline-metric extractors.
- Promote to materialised view only if a query crosses the 500ms ceiling at 10k+ bookings per venue (same rule as `reporting.md`).

## Acceptance criteria

- [x] Insights scoped to `organisation_id` via RLS — covered by [`tests/integration/rls-insights.test.ts`](../../tests/integration/rls-insights.test.ts) (mirrors the `rls-reports.test.ts` two-tenant pattern). Will extend with no-show-trend + channel-performance cases in PR2.
- [x] Lead-time histogram correctly buckets by venue-local day (a 23:30 booking created at 00:30 the same operator-day is "same-day", not "1d"). Proven by the "midnight-edge" fixture in `rls-insights.test.ts` — start_at 23:30 BST + created_at 00:30 BST both project to the same venue date, so the row lands in `same-day` rather than `1d`. The SQL idiom is in [`lib/reports/insights/lead-time.ts`](../../lib/reports/insights/lead-time.ts): `(start_at AT TIME ZONE tz)::date - (created_at AT TIME ZONE tz)::date`.
- [x] No-show evolution chart renders weekly/monthly/yearly without re-query. [`lib/reports/insights/no-show-trend.ts`](../../lib/reports/insights/no-show-trend.ts) returns daily rows; `NoShowTrendCard` in `forms.tsx` rolls them up to the picked granularity in the browser (`useMemo` over a local `useState`), so toggling never hits the server. With-deposit cohort overlaid as a second, null-breaking line.
- [x] Channel performance table shows zero rows for absent sources rather than hiding them. [`lib/reports/insights/channel-performance.ts`](../../lib/reports/insights/channel-performance.ts) maps over the closed `BOOKING_SOURCES` list, zero-filling channels the query didn't return; proven by the channel-performance case in `rls-insights.test.ts`. Deposit-capture column hidden when every channel's rate is null.
- [x] Period comparison handles partial periods honestly. [`lib/reports/insights/compare.ts`](../../lib/reports/insights/compare.ts) `previousEquivalentBounds` flags `partial: true` when the current window runs up to/past now; the band then labels itself "current period is to date — last day still in progress". Bounds maths (contiguous, duration-preserving across DST) proven by [`tests/unit/insights-compare.test.ts`](../../tests/unit/insights-compare.test.ts).
- [x] CSV export per insight (UTF-8 BOM + CRLF, reusing [`lib/reports/csv.ts`](../../lib/reports/csv.ts)). Route at `app/(dashboard)/dashboard/venues/[venueId]/reports/insights/export/[insight]/route.ts` handles all three insights (no-show-trend exports daily rows for spreadsheet re-aggregation).
- [x] Each insight loads in under 500ms at 10k bookings per venue. Informally confirmed — each is a single GROUP BY (or two, for the deposit cohort) against `bookings_venue_start_idx` / `bookings_venue_created_idx`. Not codified in CI, same posture as `reporting.md`.

## Surfaces

- `lib/reports/insights/{lead-time,no-show-trend,channel-performance}.ts` — typed query functions taking `(db, venueId, bounds)`. (Granularity is a client-side concern, not a query parameter.)
- `lib/reports/insights/compare.ts` — `previousEquivalentBounds` resolver + pure headline-metric extractors.
- `lib/reports/insights/types.ts` — shared row/enum types (`Granularity`, `BOOKING_SOURCES`, the row shapes).
- `app/(dashboard)/dashboard/venues/[venueId]/reports/insights/page.tsx` — the Insights surface (own sidebar entry, Plus-gated).
- `app/(dashboard)/dashboard/venues/[venueId]/reports/insights/forms.tsx` — client components (charts, date-range + compare nav, comparison band).
- `app/(dashboard)/dashboard/venues/[venueId]/reports/insights/export/[insight]/route.ts` — CSV download per insight.

## Plan tier

Plus tier (£74/mo + VAT). The MVP `reporting.md` reports stay on Core; Insights is one of the Plus differentiators alongside multi-venue and AI enquiry.

## Out of scope

- Predictive forecasting ("you'll do ~80 covers next Friday"). Different problem, different model — revisit after a year of data.
- Custom user-defined cohorts. Three preset breakdowns (service, party-size band, source) cover the operator questions today.
- Cross-venue aggregation. That belongs in the `multi-venue.md` group-overview surface, not here.
- Hourly granularity on the evolution chart — the existing per-service covers report already covers within-day shape.
