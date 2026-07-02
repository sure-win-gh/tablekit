# Spec: Reporting & dashboard insights

**Status:** shipped (2026-04-26); visual refresh + expanded reports (2026-07-02)
**Depends on:** `bookings.md`, `payments.md`

## What we're building

A small, opinionated set of reports that matter for independent operators. Not a general-purpose analytics tool.

## Reports

### MVP (2026-04)

1. **Covers by service / day.**
2. **No-show rate** (overall, with-deposit cohort, by service).
3. **Deposit revenue and refunds** (per-day; net = deposits + no-show captures − refunds).
4. **Source mix** (host, widget, walk-in, future: rwg, api).
5. **Top returning guests** (≥ 2 realised visits in the range).

### Expanded (2026-07)

6. **Cancellations** — rate, per-day trend, breakdown by `cancelled_reason` (NULL reported as "unspecified").
7. **Peak times** — realised covers by venue-local ISO weekday × hour; rendered as a heatmap.
8. **Occupancy** — realised covers per service vs seats on sale (capacity override ?? whole-room summed `max_cover`, × scheduled sessions in range; reuses `lib/services/capacity.ts`).
9. **Reviews** — count, average rating, per-day trend, source mix, sentiment counts (all platforms pooled).
10. **Spend (POS)** — till revenue by day; avg/order; avg/cover computed only over orders whose till reported a cover count. Empty state when no POS connection. **Operational view, not an accounting export** — `pos_orders` is held for CRM per gdpr.md and swept on a 24-month rolling basis, so older ranges thin out by design.

Note on cancellations: `cancelled_reason` is unconstrained operator free text grouped verbatim into the report + CSV. The cancel dialog carries a "don't include guest details" hint; if reasons ever need to be analytics-grade, constrain them to an enum with a separate free-text detail field excluded from reports.

### Visual refresh (2026-07)

- **KPI band** at the top of the page: covers realised, bookings, no-show rate, cancellation rate, deposit net, avg rating — derived from the already-fetched reports, zero extra queries. Coral accent when no-show ≥ 10% or cancellations ≥ 15%.
- Every report renders as a **chart first** (Recharts, same as Plus Insights), with the raw table behind a "View data" toggle so screen readers and spreadsheet people keep the numbers.
- **Charts on the free page is deliberate**: charts sell the product; Plus stays differentiated by deeper analysis (trends, comparisons, lead time), not prettiness.
- Chart colours are design tokens only (`--color-ink`, `--color-coral`, etc. from `app/globals.css` `@theme`) — no hand-rolled colours.
- Date-range picker gains 7d/30d/90d presets (computed relative to the current `to` date, keeping the venue-local default authoritative).

## Technical approach

- **Live Postgres queries**, no materialised views. Every report is a single GROUP BY on already-indexed columns (`bookings_venue_start_idx`, `payments_booking_idx`, `reviews_venue_idx`, `pos_orders_org_venue_closed_idx`); sub-100ms at the data scales we'll see in year 1. If we hit the 500ms ceiling at 10k+ bookings per venue, promote the slow report to a materialised view in a forward-only migration.
- Day buckets are computed in Postgres via `start_at AT TIME ZONE <venue-tz>` so a booking at 23:30 lands on the operator's calendar day, not UTC's.
- Occupancy's session counting is pure TS calendar math (`countWeekdayOccurrences`) — the range strings are venue-local labels, so no timezone conversion is needed; unit-tested in `tests/unit/reports-occupancy.test.ts`.
- CSV export per report — UTF-8 BOM + CRLF (RFC 4180) so Excel auto-detects the encoding.

## Acceptance criteria

- [x] All reports scoped to `organisation_id` via RLS — verified by `tests/integration/rls-reports.test.ts` (covers all ten reports incl. reviews + POS isolation).
- [x] Export as CSV (UTF-8 BOM for Excel compatibility) for every report.
- [x] Each report loads in under 500ms at 10k bookings per venue (informally confirmed; live queries on indexed columns).
- [x] Timezone-aware (report in venue's local time).
- [x] Raw data stays accessible behind the chart (View data toggle / CSV).

## Surfaces

- `lib/reports/{covers,no-show,deposits,sources,top-guests,cancellations,peak-times,occupancy,reviews,spend}.ts` — typed query functions taking `(db, venueId, bounds)` (occupancy also takes the venue-local range strings for session counting).
- `lib/reports/filter.ts` — venue-local date range → UTC bounds.
- `lib/reports/csv.ts` — RFC 4180 serialiser with UTF-8 BOM.
- `app/(dashboard)/dashboard/venues/[venueId]/reports/page.tsx` — operator dashboard (KPI band + charts).
- `app/(dashboard)/dashboard/venues/[venueId]/reports/export/[report]/route.ts` — CSV download.

## Out of scope (future work)

- Weekly / monthly / quarterly rollups in the UI (the daily rows can be aggregated client-side; a richer date picker can come later).
- "By deposit rule" no-show breakdown — needs joining historical rule snapshots that aren't currently stored.
- CSV export with decrypted PII (names, emails) for top-guests — defer until there's an actual operator request; the per-guest record page is the supported path today.
- Multi-currency formatting on the dashboard — UK-only operators today, all GBP.
- Table/area-level occupancy (needs `booking_tables` join semantics for multi-table bookings — revisit if operators ask).
- Spend-per-booking attribution (POS order ↔ booking matching exists but coverage is too patchy to headline yet).
