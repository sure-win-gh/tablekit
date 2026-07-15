# Feature specs

This folder holds the source of truth for every feature. Claude should read the relevant spec **before** writing any code for a feature and update it afterwards if the design changed.

## MVP features (weeks 1–12)

| # | Spec                        | Status | Notes |
|---|-----------------------------|--------|-------|
| 1 | [`auth.md`](auth.md)         | shipped | Sign up, login, multi-org membership + sidebar switcher, role + plan + venue gates, RLS, TOTP MFA enforcement for owners/managers, team invite flow. |
| 2 | [`venues.md`](venues.md)     | shipped | Venue + service + floor plan model, opinionated seed templates per venue_type, drag-drop floor plan (see `floor-plan-visual.md`), JSON schedule + per-service turn time, RLS-tested cross-tenant isolation. URL slug routing split out into `venue-slug.md`. |
| 3 | [`bookings.md`](bookings.md) | shipped | Public anonymous create + availability, transactional creation with deposits, GIST exclusion against double-booking, code-enforced state machine + booking_events audit, IP+email rate limits, RLS-tested cross-tenant isolation. |
| 4 | [`widget.md`](widget.md)     | shipped | 959 B gzipped iframe loader + cookieless + SSR-first `/book/[slug]` + zero third-party analytics. CSP header + `prefers-*` respect deferred — see spec. |
| 4a| [`booking-page.md`](booking-page.md) | shipped | Rich TheFork-style hosted `/book` page for Core+: `settings.profile` + Google/internal aggregate rating (P1), photo gallery via Supabase Storage `venue_photos` (P2), stylised month-availability calendar (P3), TripAdvisor badge + opening hours + directions link-out (P4) — plus the **conversational Party→Date→Time→Details wizard** on every surface. Free keeps the simple chrome. Extends `widget.md`. |
| 5 | [`payments.md`](payments.md) | superseded | Original charter — live spec is `payments-deposits.md` below. |
| 5a| [`payments-deposits.md`](payments-deposits.md) | shipped | Deposits + card hold + refunds + no-show capture (flows A/B/C) |
| 6 | [`messaging.md`](messaging.md) | shipped | Email + SMS transactional flow (waitlist_ready ships with waitlist) |
| 7 | [`guests.md`](guests.md)     | shipped | Envelope-encrypted PII (email/last name/phone/DoB/notes), hashed lookup, per-channel marketing consent (off by default), RLS-tested isolation, DSAR erasure with 30-day SLA + scrub job, Plus-tier group-CRM opt-in. |
| 8 | [`waitlist.md`](waitlist.md) | shipped | Walk-in + waitlist |
| 9 | [`reserve-with-google.md`](reserve-with-google.md) | paused | Blocked on Google partner onboarding + spec needs fleshing out — see file |
|10 | [`reporting.md`](reporting.md) | shipped | Covers, no-show rate, deposits, source mix, top guests + CSV export |
|11 | [`timeline.md`](timeline.md) | shipped | Per-table time-blocks view + drag-to-reassign |
|12 | [`floor-plan-visual.md`](floor-plan-visual.md) | shipped | SVG canvas, role-gated edit mode with drag-persist, wheel/button pan+zoom, fit-to-viewport, 30s auto-refresh, multi-table connectors, mobile read-only. |
|13 | [`reviews.md`](reviews.md)   | shipped | Internal review capture + operator dashboard/reply + Google OAuth/sync/reply + escalation + recovery offers + public showcase + AI sentiment (Bedrock Haiku) + AI reply-draft suggestions. Phase 4 (TripAdvisor/Facebook) deferred; Phase 7b cut. |
|14 | [`venue-slug.md`](venue-slug.md) | shipped | Friendly public URLs (`book.tablekit.uk/jane-cafe`); UUID URLs keep working + 308-redirect |

## Plus-tier features (weeks 13–24)

| # | Spec                                | Notes |
|---|-------------------------------------|-------|
|11 | [`multi-venue.md`](multi-venue.md)   | shipped — group overview + cross-venue guests + venue-scoped RLS + ⌘K switcher |
|12 | [`ai-enquiry.md`](ai-enquiry.md)     | shipped — inbound webhook + Bedrock parser + runner/cron + operator inbox + 90-day retention sweep + opt-in auto-send (guardrail-gated) + per-venue sending-domain setup + replies use the verified domain in `From:` when registered. Cron-based verification polling deferred. |
|13 | [`import-export.md`](import-export.md) | shipped — inline CSV+JSON export (bookings + guests, audit-logged, decrypted-at-export) + competitor-format import (OpenTable / ResDiary / SevenRooms) with mapping wizard, two-pass dedupe, crash-resumable runner, marketing-consent always nulled, downloadable rejected-rows report per job. Full-backup zip + signed-URL job deferred. |
|14 | [`public-api.md`](public-api.md)     | shipped — Bearer-auth REST API at `api.tablekit.uk/v1` (bookings + read-extras + idempotency) + webhook subscriptions/deliveries/replay + 90d request log + OpenAPI 3.1 + Stoplight docs at `/docs/api`. |
|15 | [`booking-insights.md`](booking-insights.md) | shipped — Plus-tier `/reports/insights`: lead-time histogram + no-show evolution (client-side day/week/month/year rollup, with-deposit overlay) + per-channel performance table + previous-equal-window comparison band, all CSV-exportable. New `bookings_venue_created_idx`. Extends `reporting.md`. |
|16 | [`service-summary.md`](service-summary.md)   | shipped — Plus-tier `/service-summary`: per-service capacity overrides + per-day capacity-vs-bookings panel (utilisation + open slots) + month/week calendar heatmap + four-rule suggestion engine. New `service_capacity_overrides` table. |
|17 | [`whatsapp.md`](whatsapp.md) | shipped (PR #70) — WhatsApp as a third transactional channel via Twilio. New `messages.channel='whatsapp'` + guest `whatsapp_*` columns. Dormant until enabled per-venue in message-customisation. **Meta = non-EU sub-processor (SCCs/TRA + 30-day notice required before go-live).** |
|18 | [`message-customisation.md`](message-customisation.md) | shipped (PR #70) — operator control of message content + flow: typed `settings.messaging` (per-event enable/channel-order/timing), channel resolver, per-template copy overrides (`message_templates` table, RLS) with safe merge tags + email branding + composer/preview UI. |
|19 | [`marketing-campaigns.md`](marketing-campaigns.md) | shipped (PR #70) — Plus-tier broadcast: `campaigns` + `campaign_sends` + `message_usage` tables (RLS), consent-gated guest-scoped queue + dispatch worker, composer with audience/cost estimate + preview, Resend open/click engagement tracking, pass-through usage metering. `/api/cron/campaign-tick`. Transactional sends also metered; usage surfaced (operator + admin); SMS/WhatsApp gated Core+; `campaign_sends` 24-month retention sweep. |
|20 | [`guest-insights.md`](guest-insights.md) | shipped (PR #70) — Plus-tier guest segments (New/Regular/Lapsed/VIP) derived from realised visits + tags; `campaigns.segment` narrows the audience inside the consent gate; insights engagement panel (segment sizes + email open/click rates). No new PII/sub-processor. |
|22 | [`pos-integrations.md`](pos-integrations.md) | draft — Plus-tier POS ingest: attach order history + spend to guest profiles with near-real-time push. Square (OAuth, `payment.updated`/`order.updated`), Lightspeed K-Series (partner-gated OAuth, `Account: CLOSED`/`CHECK_WAS_UPDATED`), and a generic signed-webhook + CSV path. New tables `pos_connections`, `pos_webhook_events`, `pos_orders`, `guest_spend_summary` (all RLS). Deterministic guest match via `email_hash`/`phone_hash`/booking link; Supabase Realtime to the dashboard; PCI SAQ-A preserved (PAN guard, no card data); DSAR de-link + `line_items_cipher` Art. 9 posture; **provider sub-processor rows + TRA = go-live blockers**. Build plan in [`pos-integrations-plan.md`](pos-integrations-plan.md). |
|21 | [`stripe-billing.md`](stripe-billing.md) | shipped (PR #71) — SaaS billing on the **platform** account (Tablekit = merchant; distinct from Connect/deposits): hosted Checkout upgrade Free→Core/Plus + Customer Portal + webhook plan sync/dunning (`billing_subscriptions`, RLS). **Prepaid messaging credit** (`billing_credit_ledger` + `organisations.credit_balance_pence`): marketing campaigns blocked unless balance covers estimated cost (reserve-on-launch, refund-on-complete); top-up via Checkout. **Transactional** sends never blocked, billed monthly via a Stripe usage meter (`/api/cron/billing-meter-sync`). Hosted-only → PCI SAQ-A. Free-tier 50-booking cap deferred. |
|23 | [`multi-region.md`](multi-region.md) | in progress — multi-region data residency (org-pinned `eu`/`us` Supabase projects, one codebase) + two-entity billing (UK + US Stripe accounts, entity picked at signup by country). Phases 0–2 landing (aliased to EU/UK, zero behaviour change); Phases 3–4 gated on US entity + state sales-tax registrations. |
|24 | [`ai-usage.md`](ai-usage.md) | in progress — per-org monthly Bedrock token ledger (`ai_usage`, RLS) + derived cost + tier-based hard budget cap with queue-paused enforcement in the enquiry runner + operator banner/usage readout. Extends `ai-enquiry.md`. |

## Internal tools

| #  | Spec                                       | Notes |
|----|--------------------------------------------|-------|
| 99 | [`admin-dashboard.md`](admin-dashboard.md) | shipped — founder-only platform metrics, ops health, venue search. Live Stripe pull for MRR; env allowlist auth. CSV export across all headline metrics + recharts-powered sparklines (admin-bundle code-split). |

## Security & hardening (audit follow-ups)

| Spec | Status | Notes |
|------|--------|-------|
| [`password-reset.md`](password-reset.md) | draft | Self-owned reset: 15-min single-use token table (`password_reset_tokens`, RLS deny-all) + `/forgot-password` + `/reset-password`, enumeration-safe, rate-limited, sessions revoked on reset. Supabase does only the final password write. Security audit P2 (req #2). Extends `auth.md`. |

| [`service-flow.md`](service-flow.md) | in progress | Auto-finish seated bookings after close (inline venue sweep + nightly cron backstop) + configurable overdue-table prompts on any dashboard screen. `venues.settings.serviceFlow` slice, no migration. |

## How to use

1. Before implementing a feature, open its spec and check the acceptance criteria.
2. If the spec is missing a detail you need, update the spec (and commit) before coding.
3. After implementing, update the "Status" line and add a link to the PR in the spec footer.
4. If no spec exists for what you're about to build, create one first (`/spec <name>`).
