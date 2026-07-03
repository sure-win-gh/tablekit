# Spec: Service summary

**Status:** shipped — Plus-gated `/service-summary`: capacity-override table (PR1), per-day panel with capacity/booked/utilisation/open-slots (PR2), month/week calendar heatmap (PR3), four-rule suggestion engine (PR4). UI refresh + day-prep KPIs (2026-07-02).

### 2026-07 refresh notes

- **Day KPI band**: covers booked vs capacity (coral accent ≥95%), bookings, open slots, largest party, high chairs, dietary-note count. The last three come from `getDayPrep` (`lib/services/summary.ts`) — a single day aggregate; `dietary_notes_cipher` is only null-checked, never read or decrypted. RLS-tested in `tests/integration/rls-services.test.ts`.
- **Attention strip**: all fired suggestions surface in one tinted row above the fold ("Worth a look"); per-row badges remain.
- **Calendar**: coral-intensity heat scale (tokens via `color-mix`, same language as the reports peak-times heatmap), compact `h-10` cells, ‹ › month navigation + month label. `heatBucket` thresholds unchanged.
- **Service rows**: single divided card; each row shows window, name, tokenised utilisation bar (ink / coral ≥70% / rose ≥95%), booked/capacity/%, plus previously-hidden detail (bookings count, avg party, open slots, turn minutes) and a Timeline deep-link.
**Depends on:** `bookings.md`, `venues.md`

## What we're building

A capacity-first view of upcoming and historical services. The operator opens it and sees, at a glance, how full each service is against its theoretical capacity — plus a calendar that paints the same picture across a month.

## Why this matters

The existing reports answer "how many covers did we do?" The operator's real planning question is "what's the shape of the next month, where is there headroom, where am I about to overstaff a quiet service?" That needs a forward-looking view anchored on capacity, not historical covers.

## The two surfaces

### 1. Service summary panel (per day)

For a chosen day, list every service with:

- **Capacity** — sum of `max_cover` across active tables (or service-overridden capacity if set).
- **Booked covers** — sum of `party_size` for non-cancelled bookings overlapping the service window.
- **Utilisation** — booked / capacity, with a coloured bar (green < 70%, amber 70–95%, red ≥ 95%).
- **Open slots** — count of remaining available slots from `lib/bookings/availability.ts` for a representative party size (2).
- **Suggestions** — at most one nudge per service, drawn from a small ruleset (see below).

### 2. Calendar heatmap

Month grid (default) and week grid (toggle). Each cell shows the day's aggregate utilisation across all services as a heat colour, with the headline covers number. Clicking a cell deep-links into the day's service summary panel.

## Suggestion ruleset (v1)

Deliberately small and rules-based — no ML. Each rule fires at most once per service per day:

| Rule | Trigger | Suggestion |
|------|---------|------------|
| `underbooked-72h` | Service is <30% booked and starts in <72h | "Consider promoting this service" |
| `oversold-risk` | Service is ≥95% booked and turn-time gaps < 30 min | "Tight turns — review or extend service window" |
| `walk-in-headroom` | Service is <60% booked and walk-in share for this weekday averages >25% | "Reserve a table for walk-ins" |
| `no-show-cluster` | Day has ≥3 bookings from guests with prior no-show flag | "Confirm these guests by SMS" |

Rules live in `lib/services/suggestions/{rule}.ts`, each a pure `(serviceContext) => Suggestion | null`. Easy to add or kill a rule without touching the panel.

## Technical approach

- Capacity is computed at read-time from `tables` + `service_capacity_overrides` (new tiny table — `(service_id, capacity)` for the cases where a service runs at lower capacity than the floor plan implies, e.g. brunch with half the room closed). No denormalisation.
- Booked covers / utilisation: one query per day-range, GROUP BY service, joining bookings overlapping each service window. Index already exists on `(venue_id, start_at)`.
- Heatmap month query: aggregate utilisation per day in a single query, return `{ day, capacity, booked }[]`. Render colour client-side.
- Suggestions are evaluated server-side when the panel loads — not stored. They're a function of current state, so persisting them invites staleness.
- Forward window capped at 90 days; deeper futures rarely have meaningful capacity-vs-booked signal yet.

## Acceptance criteria

- [x] Service summary panel scoped to `organisation_id` via RLS — `getServiceSummary` filters every read by `venueId` inside `withUser`; isolation proven by the `getServiceSummary` cases in [tests/integration/rls-services.test.ts](../../tests/integration/rls-services.test.ts) (user A querying venue B → no rows).
- [x] Utilisation matches "covers / capacity" exactly. `resolveCapacity` (override ?? summed table max_cover) unit-tested in [tests/unit/service-capacity.test.ts](../../tests/unit/service-capacity.test.ts); the booked/capacity maths verified end-to-end in the integration test (Main 8/40=0.2 via override, Brunch 5/10=0.5 via room fallback, cancelled excluded).
- [x] Calendar heatmap loads a month in a single aggregate query. [`lib/services/heatmap.ts`](../../lib/services/heatmap.ts) `getHeatmap` runs one GROUP-BY-day covers query (on `bookings_venue_start_idx`) + computes per-day capacity in TS from the services' schedules — no per-day query. Layout maths (Monday-start grid, leading/trailing pads, leap-Feb, week bucketing, heat thresholds) unit-tested in [tests/unit/heatmap-grid.test.ts](../../tests/unit/heatmap-grid.test.ts). The <400ms figure is informal (same posture as `reporting.md`), not codified in CI.
- [x] Suggestion rules each have trigger + no-trigger unit tests with a `ServiceContext` builder fixture, plus a runner priority/first-wins test — [tests/unit/service-suggestions.test.ts](../../tests/unit/service-suggestions.test.ts). Four pure rules in [lib/services/suggestions/](../../lib/services/suggestions/); [run.ts](../../lib/services/suggestions/run.ts) returns the first hit (priority: oversold → no-show-cluster → underbooked → walk-in). Historical context (weekday walk-in share; per-service prior-no-show count) assembled in [context.ts](../../lib/services/suggestions/context.ts), never stored.
- [x] `service_capacity_overrides` ships with RLS + migration + a tiny dashboard form on the service edit page (no override = falls back to summed table capacity). Migration `0041_green_penance.sql` (table + `enforce_*_org_id` trigger + member-read policy); the "Capacity cap" field on [services/forms.tsx](../../app/(dashboard)/dashboard/venues/[venueId]/services/forms.tsx) upserts/deletes via [services/actions.ts](../../app/(dashboard)/dashboard/venues/[venueId]/services/actions.ts) (blank = override deleted). RLS isolation + trigger proven by [tests/integration/rls-services.test.ts](../../tests/integration/rls-services.test.ts).
- [x] Clicking a heatmap cell deep-links to the day and the panel re-renders without an extra click. Cells are `<Link href="…/service-summary?date=YYYY-MM-DD">`; the RSC reads `?date=` and re-fetches the panel + heatmap for that day. (Shipped at `/dashboard/venues/[venueId]/service-summary`, not the draft's `/reports/service-summary` — it's a top-level venue surface with its own sidebar entry, sibling to Reports/Insights.)

## Surfaces

- `lib/services/summary.ts` — `(db, venueId, date) → ServiceSummaryRow[]` query function.
- `lib/services/heatmap.ts` — `(db, venueId, monthBounds) → DayUtilisation[]` query function.
- `lib/services/suggestions/{underbooked-72h,oversold-risk,walk-in-headroom,no-show-cluster}.ts` — one rule per file.
- `app/(dashboard)/dashboard/venues/[venueId]/services/summary/page.tsx` — combined panel + heatmap.
- `lib/db/schema.ts` — `service_capacity_overrides` table.

## Plan tier

Plus tier (£74/mo + VAT). Capacity planning is the operator-maturity feature; Core users get the existing day-of timeline and floor plan.

## Out of scope

- Multi-venue rollup of utilisation. Belongs on the `multi-venue.md` group dashboard if/when requested.
- "Auto-close service" when 95% full. Capacity-driven booking gating is a separate behaviour change with refund implications — not bundled here.
- Staff-rota integration. We don't model rotas; suggestions live at the service level only.
- Custom suggestion rules per venue. The four rules are opinionated by design — extension via config, not user-editable logic.
