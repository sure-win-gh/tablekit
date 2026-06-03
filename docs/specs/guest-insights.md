# Spec: Guest insights & segmentation (Plus tier)

**Status:** draft — Phase 4 of the Automation & Engagement plan.
**Depends on:** `marketing-campaigns.md`, `booking-insights.md`, `reporting.md`, `guests.md`, `docs/playbooks/gdpr.md`

## What we're building

Turn the booking + messaging history into **guest segments** operators can both *see* (an engagement panel in the Plus insights surface) and *act on* (target a marketing campaign at a segment instead of the whole consented list). Segments are derived from data we already hold — realised visits, recency, no-show rate, lifetime deposit spend, operator tags — so there's **no new special-category profiling** and no new sub-processor. v1 ships a fixed set of built-in, parameterised segments; operator-saved custom segments are deferred.

## User stories

- As a manager I see, per venue, how many guests fall into each segment (New, Regular, Lapsed, VIP) and the engagement (open/click) of recent campaigns.
- As a manager composing a campaign I pick a segment to narrow the audience; the recipient count + cost estimate update accordingly.
- A segmented send still obeys the Phase-3 consent gate (segment narrows *within* the consented audience, never around it).

## Segments (built-in)

Resolved against venue-scoped realised bookings (`REALISED_STATUSES`) + `guests.tags`:

| Key | Definition (default params) |
|---|---|
| `all` | every guest (consent gate still applies for campaigns) |
| `new` | exactly 1 realised visit at the venue |
| `regular` | ≥ 3 realised visits |
| `lapsed` | has visited, but last realised visit > 90 days ago |
| `vip` | carries the `vip` tag (case-insensitive) on `guests.tags` |

Each is a SQL predicate (`guests.id IN (subquery over bookings …)` or a tag test) composed with the existing audience predicate via `and()`. No per-guest rollup is persisted — computed on read, like the other reports.

## Data model

One additive column (forward-only migration) so a campaign records the segment it targeted (auditability + re-fan-out):

```sql
alter table campaigns add column segment text not null default 'all';
-- CHECK (segment in ('all','new','regular','lapsed','vip'))
```

No new table. Segment definitions live in code (`lib/guests/segments.ts`). (Operator-saved custom `guest_segments` rules are out of scope for v1.)

## API surface

- `lib/guests/segments.ts` — segment registry (`SEGMENTS`), `segmentPredicate(venueId, segment, now)` → SQL, and `segmentSizes(db, venueId, now)` → count per segment.
- `lib/campaigns/recipients.ts` — `audiencePredicate` / `resolveRecipientIds` / `estimateAudience` gain an optional `segment` param, intersected with the consent predicate.
- `lib/campaigns/enqueue.ts` — reads `campaigns.segment` and passes it to `resolveRecipientIds`.
- `lib/reports/guest-engagement.ts` — `getGuestEngagementReport(db, venueId, bounds)` → segment sizes + aggregate campaign sent/opened/clicked rates for the range.
- Insights page (`app/(dashboard)/dashboard/venues/[venueId]/reports/insights/*`) — new `GuestEngagementCard` (segment sizes bar + engagement KPIs), Plus-gated like the rest.
- Campaign composer — a segment `<select>`; the action stores `campaigns.segment` and the audience estimate is per (channel, segment).

## Acceptance criteria

- [ ] Each segment predicate resolves to the expected guest set (integration test against seeded visit/tag fixtures).
- [ ] A campaign targeting a segment only enqueues consented guests **in that segment**; the consent gate is never bypassed (segment is `and`-composed, re-checked at send via the stored `campaigns.segment`).
- [ ] Composer audience estimate + cost reflect the chosen segment.
- [ ] Insights panel shows per-segment sizes + campaign open/click rates for the selected range; Plus-gated.
- [ ] `campaigns.segment` migration is forward-only with a CHECK; existing campaigns default to `all`.
- [ ] No new PII, no new sub-processor; segments use only existing non-special-category data (visits, recency, spend, tags). DSAR unaffected (no new guest-keyed storage).

## Out of scope

- Operator-saved custom segments (`guest_segments` table + rule builder) — built-ins only for v1.
- Segment-driven **automations** (win-back / birthday auto-campaigns) — a fast-follow once segments are proven.
- Per-guest predictive scoring / churn models / any special-category inference.
- RFM quadrant visualisation beyond the segment-size + engagement panel.
