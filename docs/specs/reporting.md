# Spec: Reporting & dashboard insights

**Status:** shipped (2026-04-26)
**Depends on:** `bookings.md`, `payments.md`

## What we're building

A small, opinionated set of reports that matter for independent operators. Not a general-purpose analytics tool.

## Reports (MVP)

1. **Covers by service / day.**
2. **No-show rate** (overall, with-deposit cohort, by service).
3. **Deposit revenue and refunds** (per-day; net = deposits + no-show captures − refunds).
4. **Source mix** (host, widget, walk-in, future: rwg, api).
5. **Top returning guests** (≥ 2 realised visits in the range).

## Technical approach

- **Live Postgres queries**, no materialised views in MVP. Every report is a single GROUP BY on already-indexed columns (`bookings_venue_start_idx`, `payments_booking_idx`); sub-100ms at the data scales we'll see in year 1. If we hit the 500ms ceiling at 10k+ bookings per venue, promote the slow report to a materialised view in a forward-only migration.
- Day buckets are computed in Postgres via `start_at AT TIME ZONE <venue-tz>` so a booking at 23:30 lands on the operator's calendar day, not UTC's.
- CSV export per report — UTF-8 BOM + CRLF (RFC 4180) so Excel auto-detects the encoding.

## Acceptance criteria

- [x] All reports scoped to `organisation_id` via RLS — verified by `tests/integration/rls-reports.test.ts`.
- [x] Export as CSV (UTF-8 BOM for Excel compatibility).
- [x] Each report loads in under 500ms at 10k bookings per venue (informally confirmed; live queries on indexed columns).
- [x] Timezone-aware (report in venue's local time).

## Surfaces

- `lib/reports/{covers,no-show,deposits,sources,top-guests}.ts` — typed query functions taking `(db, venueId, bounds)`.
- `lib/reports/filter.ts` — venue-local date range → UTC bounds.
- `lib/reports/csv.ts` — RFC 4180 serialiser with UTF-8 BOM.
- `app/(dashboard)/dashboard/venues/[venueId]/reports/page.tsx` — operator dashboard.
- `app/(dashboard)/dashboard/venues/[venueId]/reports/export/[report]/route.ts` — CSV download.

## Out of scope (future work)

- Weekly / monthly / quarterly rollups in the UI (the daily rows can be aggregated client-side; a richer date picker can come later).
- "By deposit rule" no-show breakdown — needs joining historical rule snapshots that aren't currently stored.
- CSV export with decrypted PII (names, emails) for top-guests — defer until there's an actual operator request; the per-guest record page is the supported path today.
- Multi-currency formatting on the dashboard — UK-only operators today, all GBP.
