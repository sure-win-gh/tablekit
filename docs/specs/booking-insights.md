# Spec: Booking insights

**Status:** in progress — lead-time histogram shipped (PR1); no-show evolution, channel performance, and period comparison still to come.
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
4. **Period comparison.** Any of the four above against the previous equivalent period (this week vs last week, this month vs last month, etc.). Render as ±% delta next to the headline number.

## Technical approach

- Same live-query posture as `reporting.md` — single GROUP BY per insight, on the existing `bookings_venue_start_idx` and the new `bookings_venue_created_idx` (lead-time queries bucket by `created_at`, which isn't currently indexed alongside venue).
- Period buckets computed in Postgres via `date_trunc('week' | 'month' | 'year', start_at AT TIME ZONE <venue-tz>)` so the boundary matches the operator's calendar.
- Comparison period derived in TypeScript from the selected range — keep query layer dumb, do the "previous equivalent" maths in `lib/reports/compare.ts`.
- Promote to materialised view only if a query crosses the 500ms ceiling at 10k+ bookings per venue (same rule as `reporting.md`).

## Acceptance criteria

- [x] Insights scoped to `organisation_id` via RLS — covered by [`tests/integration/rls-insights.test.ts`](../../tests/integration/rls-insights.test.ts) (mirrors the `rls-reports.test.ts` two-tenant pattern). Will extend with no-show-trend + channel-performance cases in PR2.
- [x] Lead-time histogram correctly buckets by venue-local day (a 23:30 booking created at 00:30 the same operator-day is "same-day", not "1d"). Proven by the "midnight-edge" fixture in `rls-insights.test.ts` — start_at 23:30 BST + created_at 00:30 BST both project to the same venue date, so the row lands in `same-day` rather than `1d`. The SQL idiom is in [`lib/reports/insights/lead-time.ts`](../../lib/reports/insights/lead-time.ts): `(start_at AT TIME ZONE tz)::date - (created_at AT TIME ZONE tz)::date`.
- [ ] No-show evolution chart renders weekly/monthly/yearly without re-query (single query, client-side aggregation across periods within the bounds). **PR2.**
- [ ] Channel performance table shows zero rows for absent sources rather than hiding them (so "no widget bookings yet" is visible as a row, not a gap). **PR2.**
- [ ] Period comparison handles partial periods honestly — "this month" vs "last month" labels the delta as *month-to-date* when today < end of month. **PR3.**
- [x] CSV export for the shipped insight (UTF-8 BOM + CRLF, reusing [`lib/reports/csv.ts`](../../lib/reports/csv.ts)). Route at `app/(dashboard)/dashboard/venues/[venueId]/reports/insights/export/[insight]/route.ts`; switch grows with each insight in PR2.
- [ ] Each insight loads in under 500ms at 10k bookings per venue. Informally confirmed — lead-time is a single GROUP BY against the new `bookings_venue_created_idx`. Re-check formally as PR2/PR3 land.

## Surfaces

- `lib/reports/insights/{lead-time,no-show-trend,channel-performance}.ts` — typed query functions taking `(db, venueId, bounds, granularity)`.
- `lib/reports/compare.ts` — bounds → previous-equivalent bounds resolver.
- `app/(dashboard)/dashboard/venues/[venueId]/reports/insights/page.tsx` — Insights tab on the existing reports surface.
- `app/(dashboard)/dashboard/venues/[venueId]/reports/insights/export/[insight]/route.ts` — CSV download per insight.

## Plan tier

Plus tier (£39/mo). The MVP `reporting.md` reports stay on Core; Insights is one of the Plus differentiators alongside multi-venue and AI enquiry.

## Out of scope

- Predictive forecasting ("you'll do ~80 covers next Friday"). Different problem, different model — revisit after a year of data.
- Custom user-defined cohorts. Three preset breakdowns (service, party-size band, source) cover the operator questions today.
- Cross-venue aggregation. That belongs in the `multi-venue.md` group-overview surface, not here.
- Hourly granularity on the evolution chart — the existing per-service covers report already covers within-day shape.
