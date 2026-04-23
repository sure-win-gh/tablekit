# Spec: Reporting & dashboard insights

**Status:** draft
**Depends on:** `bookings.md`, `payments.md`

## What we're building

A small, opinionated set of reports that matter for independent operators. Not a general-purpose analytics tool.

## Reports (MVP)

1. **Covers by service / day / week / month.**
2. **No-show rate** (total and by service, by deposit rule).
3. **Deposit revenue and refunds.**
4. **Source mix** (direct, widget, RWG, walk-in).
5. **Top returning guests** (count of visits).

## Technical approach

- No external OLAP for now. All reports are Postgres queries with materialised views refreshed nightly via cron.
- Pre-aggregate daily totals into `reporting_daily` to keep dashboard snappy.
- CSV export for every report.

## Acceptance criteria

- [ ] All reports scoped to `organisation_id` via RLS.
- [ ] Export as CSV (UTF-8 BOM for Excel compatibility).
- [ ] Each report loads in under 500ms at 10k bookings per venue.
- [ ] Timezone-aware (report in venue's local time).
