# Spec: Multi-venue groups (Plus tier)

**Status:** shipped (2026-04-26) — minus the operator-facing grant UI for `memberships.venue_ids` (settable via SQL today; UI is a follow-up).
**Depends on:** `venues.md`, `auth.md`

## What we're building

Small groups (2–5 venues under one owner) want a single dashboard with group-wide reporting, shared guest CRM (optional), and centralised staff management.

## User stories

- As a group owner I see group-wide booking counts and revenue on one screen — `/dashboard/overview`.
- As a group owner I can grant a manager access to all venues in the group, OR scope them to a subset, by setting `memberships.venue_ids`.
- As a group owner I can opt in to a **shared guest list** so a guest at venue A is visible at venue B.
- As a manager I can switch between venues with `⌘K` from any venue page.

## Acceptance criteria

- [x] Organisation entity already exists (from `auth.md`). Groups are organisations with >1 venue.
- [x] Group dashboard at `/dashboard/overview` aggregates today's bookings + covers + deposit revenue across venues respecting RLS.
- [x] Shared guest list is opt-in per organisation via `organisations.group_crm_enabled` (default false). Migration 0012.
- [x] When enabled, guest queries scope by `organisation_id`. Marketing consent remains per-venue (per `email_unsubscribed_venues` / `sms_unsubscribed_venues` arrays on guests, unchanged).
- [x] Staff permissions: `memberships.venue_ids uuid[]` optional — null means "all venues in org". Migration 0013.
- [x] RLS: `user_visible_venue_ids()` SQL helper joins memberships → venues. Used by SELECT policies on venues, bookings, booking_tables, booking_events, waitlists. 6-test integration spec at [tests/integration/rls-membership-venue-scope.test.ts](../../tests/integration/rls-membership-venue-scope.test.ts).
- [x] Venue switcher with ⌘K keyboard shortcut, click-outside / Esc / arrows / Enter behaviour.

## Surfaces

- `/dashboard/overview` — group-wide aggregates, per-venue cards.
- `/dashboard/organisation` — owner-only group settings (today: just `group_crm_enabled`).
- `/dashboard/guests` — cross-venue guest list, gated by `group_crm_enabled`.
- Venue layout breadcrumb pill: VenueSwitcher (⌘K), Organisation, Privacy requests.

## Out of scope (post-ship)

- Cross-organisation sharing (e.g. two different operators sharing a guest). Never.
- Franchise-style group hierarchies (brand above org above venue). Keep it two-level.
- **Operator UI to set `memberships.venue_ids`.** Today the column is settable via SQL only. A team-management page (invite, role, venue scope) is the next natural slot — likely lives on `/dashboard/organisation`.
- **Per-venue RLS on payments / messages / dsar_requests.** These tables stay org-scoped — they have no `venue_id` column today. A follow-up adds the denorm + tightens these policies.
- **Per-venue RLS on config tables** (areas, services, deposit_rules, tables). Restricting them is a UX concern, not security — a host scoped to one venue should still understand the org's overall config.
