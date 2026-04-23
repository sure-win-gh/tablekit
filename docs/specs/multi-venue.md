# Spec: Multi-venue groups (Plus tier)

**Status:** draft — Plus tier only
**Depends on:** `venues.md`, `auth.md`

## What we're building

Small groups (2–5 venues under one owner) want a single dashboard with group-wide reporting, shared guest CRM (optional), and centralised staff management.

## User stories

- As a group owner I see group-wide booking counts and revenue on one screen.
- As a group owner I can grant a manager access to all venues in the group in one click.
- As a group owner I can opt in to a **shared guest list** so a VIP tagged at venue A is visible at venue B.
- As a manager I can switch between venues with a keyboard shortcut.

## Acceptance criteria

- [ ] Organisation entity already exists (from `auth.md`). Groups are organisations with >1 venue.
- [ ] Group dashboard at `/dashboard/overview` aggregates across venues respecting RLS.
- [ ] Shared guest list is opt-in per organisation via `organisations.group_crm_enabled` (default false).
- [ ] When enabled, guest queries scope by `organisation_id` (not `venue_id`). Marketing consent remains per-venue.
- [ ] Staff permissions: `memberships.venue_ids text[]` optional — null means "all venues in org".

## Out of scope

- Cross-organisation sharing (e.g. two different operators sharing a guest). Never.
- Franchise-style group hierarchies (brand above org above venue). Keep it two-level.
