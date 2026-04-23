# Plan: venues

Spec: [docs/specs/venues.md](../../docs/specs/venues.md). Depends on `auth` (already landed).

First data phase that isn't auth-internal. The patterns we set here — denormalised `organisation_id` on every tenant row, role-gated server actions, form-first UI, follow-up phase for polish — will be copied across bookings, guests, waitlist, reporting.

## Scope of this phase vs follow-ups

| Phase | What ships |
|---|---|
| **`venues` (this phase)** | schema, migration, RLS, role-check helper, CRUD server actions for venue/area/table/service, **form-based** floor-plan editor (x/y/w/h as number inputs), template seed on venue creation, dashboard route for venue picker / first-venue CTA, cross-tenant RLS test for all four tables, e2e smoke for create-venue. |
| `venues-floor-plan` (follow-up) | drag-drop editor over the same data model — `@dnd-kit/core` grid, live collision detection, saved position on drop. No new schema. |
| `venues-photos` (later, nice-to-have) | venue hero photo + gallery via Supabase Storage. Out of scope for MVP. |

Keeps the diff reviewable and ships usable venue management in one phase.

---

## Architectural decisions

### D1. Denormalise `organisation_id` onto every tenant-scoped table

**Proposal:** every new tenant table gets a `organisation_id uuid not null` column, even when the parent FK already lets us reach it via join. Pattern becomes:

- `venues.organisation_id` (natural — already on the spec)
- `areas.organisation_id` (from parent venue)
- `tables.organisation_id` + `tables.venue_id` (from parent area)
- `services.organisation_id` (from parent venue)

RLS policies then collapse to a uniform one-hop:

```sql
create policy xxx_member_read on <table>
  for select to authenticated
  using (organisation_id in (select public.user_organisation_ids()));
```

The organisation id is kept in sync via a **BEFORE INSERT/UPDATE trigger** that reads it from the parent — so application bugs can't create org mismatches even accidentally:

```sql
create function public.enforce_areas_org_id() returns trigger ... as $$
begin
  select organisation_id into new.organisation_id from venues where id = new.venue_id;
  return new;
end; $$ ...
```

For `tables` the trigger also backfills `venue_id` from the parent area in one hop.

**Cost:** 16 bytes per row per extra column, one extra lookup per insert. **Value:** every RLS policy is a simple equality (no subquery recursion risk, no 3-level joins as the schema grows), `bookings` in the next phase inherits the same one-hop pattern, ad-hoc admin queries like "all tables for org X" stop needing joins.

**Alternative considered — pure hierarchy (areas.venue_id only, tables.area_id only)**: cleaner schema but every RLS policy for a 3-deep child (e.g. `bookings.table_id → tables.area_id → areas.venue_id → venues.organisation_id`) becomes a chain of subqueries. Fine for `venues`, painful by the time we ship `bookings`. Locking the denormalised pattern in now means we don't have to retrofit.

### D2. Role-check helper lives at `lib/auth/require-role.ts`

**Proposal:** a `requireRole(min: OrgRole)` server helper that every write-path server action calls first. Returns `{ userId, orgId, role }` or redirects / throws. Resolves membership via `withUser` against the active-org cookie.

```ts
type OrgRole = "owner" | "manager" | "host";
const roleLevel = { host: 1, manager: 2, owner: 3 } as const;

export async function requireRole(
  min: OrgRole,
): Promise<{ userId: string; orgId: string; role: OrgRole }> { ... }
```

Venue / area / table / service writes require `manager`. Reads don't require the helper — RLS does the gating.

Billing-adjacent writes (stripe customer linking, plan changes) require `owner`. Not in this phase.

### D3. `venue_type` as a 3-value pgEnum for template seeding

**Proposal:** add `venue_type` to `venues` as `pgEnum("venue_type", ["cafe", "restaurant", "bar_pub"])`. Matches the three template profiles in the spec. Kept as a column (not just a signup-time param) because future reporting segmentation and type-specific defaults will want it.

If the spec later grows types (hotel, club), we add enum values via migration; forward-compatible.

### D4. Template seed runs in the `createVenue` transaction

**Proposal:** the `createVenue` server action opens one `adminDb().transaction(tx => ...)` that:

1. Inserts `venues` with `organisation_id` set.
2. Looks up the template for `venue_type`.
3. Inserts all `areas`, `tables`, `services` rows matching the template.
4. Audit-logs `venue.created`.

Atomic — if any seed insert fails, the venue isn't created. Templates live in a TS module (`lib/venues/templates.ts`) keyed by `venue_type`, each describing areas / tables / services shapes. Easy to diff and extend.

Uses `adminDb` because we already do admin-path work on write (we're not just inserting; we're bootstrapping a subtree). `withUser` isn't needed — we've already proven identity + role with `requireRole`.

### D5. Floor plan v1 is forms, not drag-drop

**Proposal:** `/dashboard/venues/[venueId]/floor-plan` renders the list of areas and tables with inline edit forms. Position is four number inputs (`x`, `y`, `w`, `h`); shape is a `select` (rect / circle). Add / delete buttons. No canvas.

Drag-drop is genuinely valuable UX but a significant interaction cost to build and a fresh dependency (`@dnd-kit/core`). Splitting it to a follow-up keeps this phase shippable in a few days; drag just wraps the same CRUD.

### D6. URL-explicit "active venue" — no cookie needed for this phase

**Proposal:** every venue-scoped route lives under `/dashboard/venues/[venueId]/...`. No active-venue cookie. Users navigate explicitly. When multi-venue UX matters (group dashboards, Plus tier, `multi-venue` spec) we'll add a picker + cookie pattern mirroring active-org.

### D7. Soft-delete or hard-delete venues?

**Proposal:** hard-delete for this phase, with FK `on delete cascade` from venues → areas/tables/services (mirrors auth's approach). Soft-delete complicates RLS (policies have to filter `deleted_at is null` everywhere) and GDPR erasure is already handled at the org level. Revisit if customers ask; they usually don't delete venues.

### D8. Out of scope for this phase

- **Drag-drop floor plan** — follow-up `venues-floor-plan`.
- **Area reorder UI** — `sort` column is there, but the only way to set it is via an API call / SQL until the drag-drop phase.
- **Venue photos / branding** — `settings` jsonb has room for it. Lands when we ship the public booking widget.
- **Closures / holiday schedule** — spec doesn't mention; lands with `bookings` availability logic or its own phase.
- **Per-table attributes** (window seat, accessibility, outdoor) — premature; lands when an operator actually asks.
- **Service pricing / deposit rules per service** — lands with the `payments` phase.

---

## Data model (this phase)

```sql
-- New enum
create type venue_type as enum ('cafe', 'restaurant', 'bar_pub');

create table venues (
  id               uuid primary key default gen_random_uuid(),
  organisation_id  uuid not null references organisations(id) on delete cascade,
  name             text not null,
  venue_type       venue_type not null,
  timezone         text not null default 'Europe/London',
  locale           text not null default 'en-GB',
  settings         jsonb not null default '{}',
  created_at       timestamptz not null default now()
);
create index venues_org_idx on venues(organisation_id);

create table areas (
  id               uuid primary key default gen_random_uuid(),
  organisation_id  uuid not null,
  venue_id         uuid not null references venues(id) on delete cascade,
  name             text not null,
  sort             int  not null default 0,
  created_at       timestamptz not null default now()
);
create index areas_venue_idx on areas(venue_id);
create index areas_org_idx on areas(organisation_id);

create table tables (
  id               uuid primary key default gen_random_uuid(),
  organisation_id  uuid not null,
  venue_id         uuid not null,           -- denormalised from area
  area_id          uuid not null references areas(id) on delete cascade,
  label            text not null,
  min_cover        int  not null default 1,
  max_cover        int  not null,
  shape            text not null default 'rect',
  position         jsonb not null default '{"x":0,"y":0,"w":2,"h":2}',
  created_at       timestamptz not null default now()
);
create index tables_venue_idx on tables(venue_id);
create index tables_org_idx on tables(organisation_id);

create table services (
  id               uuid primary key default gen_random_uuid(),
  organisation_id  uuid not null,
  venue_id         uuid not null references venues(id) on delete cascade,
  name             text not null,
  schedule         jsonb not null,     -- { days: string[], start: "HH:MM", end: "HH:MM" }
  turn_minutes     int  not null default 90,
  created_at       timestamptz not null default now()
);
create index services_venue_idx on services(venue_id);
create index services_org_idx on services(organisation_id);
```

### Triggers

```sql
-- areas: copy organisation_id from parent venue
create function public.enforce_areas_org_id() returns trigger
  language plpgsql security definer set search_path = public as $$
begin
  select organisation_id into new.organisation_id from venues where id = new.venue_id;
  return new;
end; $$;
create trigger enforce_areas_org_id before insert or update of venue_id on areas
  for each row execute function public.enforce_areas_org_id();

-- tables: copy organisation_id + venue_id from parent area
create function public.enforce_tables_org_and_venue() returns trigger
  language plpgsql security definer set search_path = public as $$
begin
  select a.organisation_id, a.venue_id
    into new.organisation_id, new.venue_id
  from areas a where a.id = new.area_id;
  return new;
end; $$;
create trigger enforce_tables_org_and_venue before insert or update of area_id on tables
  for each row execute function public.enforce_tables_org_and_venue();

-- services: copy organisation_id from parent venue (same shape as areas)
create function public.enforce_services_org_id() returns trigger ...;
create trigger enforce_services_org_id before insert or update of venue_id on services
  for each row execute function public.enforce_services_org_id();
```

### RLS policies (same shape on every table)

```sql
alter table venues   enable row level security;
alter table areas    enable row level security;
alter table tables   enable row level security;
alter table services enable row level security;

-- Repeat for each table, substituting the name:
create policy venues_member_read on venues
  for select to authenticated
  using (organisation_id in (select public.user_organisation_ids()));
-- No insert/update/delete policies for authenticated — writes go
-- through server actions backed by adminDb() (mirrors auth phase).
```

---

## Tasks (ordered, each its own commit)

1. **`feat(venues): drizzle schema + enum + helper function`**
   - [lib/db/schema.ts](../../lib/db/schema.ts) — add `venueType` pgEnum, `venues`, `areas`, `tables`, `services` table definitions with `organisationId` on each.
   - Types export cleanly for reuse in server actions.

2. **`feat(venues): migration — tables, triggers, RLS policies`**
   - `pnpm db:generate` produces Drizzle SQL; hand-append the three `enforce_*` functions + triggers, RLS enable, and read policies.
   - `pnpm db:migrate` + `pnpm check:rls` stays green; `check:rls` now reports 8 tables (4 auth + 4 venues), all with RLS + policies.

3. **`feat(auth): requireRole helper`**
   - [lib/auth/require-role.ts](../../lib/auth/require-role.ts) — `requireRole(min)` returning `{ userId, orgId, role }` or redirecting. Used by every subsequent write action.
   - Small unit test (mocked) that asserts the `owner > manager > host` ordering.

4. **`feat(venues): templates + createVenue action`**
   - [lib/venues/templates.ts](../../lib/venues/templates.ts) — three template objects keyed by `venue_type`. Pure data; no logic.
   - `app/(dashboard)/venues/new/actions.ts` — Zod boundary, `requireRole("manager")`, single adminDb transaction: insert venue + template rows, audit-log.
   - `audit.log({ action: "venue.created", ... })` with the new `AuditAction` union extended.

5. **`feat(venues): /dashboard/venues list + new venue form`**
   - `app/(dashboard)/venues/page.tsx` — RSC that lists org venues via `withUser`. Empty state → link to `/venues/new`.
   - `app/(dashboard)/venues/new/page.tsx` + `form.tsx` — useActionState form with name, venue_type select, timezone, locale. Submits to the action from step 4.

6. **`feat(venues): venue settings page`**
   - `app/(dashboard)/venues/[venueId]/settings/page.tsx` + action — edit name / timezone / locale / settings jsonb. `requireRole("manager")`.
   - Sign-out link + breadcrumb back to `/venues`.

7. **`feat(venues): areas + tables CRUD (form-based floor plan)`**
   - `app/(dashboard)/venues/[venueId]/floor-plan/page.tsx` — RSC listing areas grouped, each with its tables.
   - Actions for create/update/delete area and create/update/delete table.
   - Forms edit label, min_cover, max_cover, shape, position x/y/w/h inline. Minimal but complete.

8. **`feat(venues): services CRUD`**
   - `app/(dashboard)/venues/[venueId]/services/page.tsx` + actions.
   - Schedule editor: day-of-week checkboxes, start/end time inputs, turn_minutes number. Zod validates HH:MM format and `start < end`.

9. **`feat(venues): dashboard picker`**
   - Update `app/(dashboard)/dashboard/page.tsx` — if org has zero venues, show "Create your first venue" CTA. If one venue, redirect to it. If multiple, show picker list.

10. **`test(venues): cross-tenant RLS integration tests`**
    - Extend `tests/integration/` or add a new file — same pattern as auth's test but across all 4 new tables.
    - Additional assertion: inserting into another org's scope (set `organisation_id` to org B while user is A) is rejected by RLS write-side.

11. **`test(e2e): create-venue + template seed smoke`**
    - Playwright: sign in as a pre-seeded user (reuse auth.spec.ts's pattern), navigate `/venues/new`, pick `cafe`, submit, assert the seeded area "Inside" + services "Open" show on the subsequent pages.
    - Cleanup: admin-delete the venue in `afterAll` (org cleanup cascades).

---

## Open questions before coding

Answer these and I'll execute:

1. **Scope split confirmed?** `venues` (this one — CRUD + forms + seed + tests) with `venues-floor-plan` (drag-drop) as the follow-up?
2. **D1 (denormalise `organisation_id` on every tenant table, enforced via trigger) OK?** This is the big one — it locks the pattern for every future spec. Alternative: pure parent-FK hierarchy, joins in RLS policies.
3. **D3 (`venue_type` enum with `cafe | restaurant | bar_pub`) OK?** Any type I should add before we ship?
4. **D5 (form-based floor plan v1; drag-drop deferred) OK?**
5. **Roles:** venue / area / table / service writes require `manager`. Confirming this matches your mental model of who does what (owner and manager can set up the venue; host can't).
6. **Settings jsonb:** I'll leave it unstructured for v1. OK to evolve it as we add features (branding, closure rules, etc.), or do you want a typed `settings` shape from day one?

## Exit criteria

- A new operator can sign up, create a venue with a template, see the areas/tables/services land in the DB, and edit each.
- `pnpm check:rls` reports 8 tables green.
- Cross-tenant integration test extended for venues/areas/tables/services — user A never sees org B's.
- `pnpm test:e2e` includes the create-venue smoke.
- `gdpr-auditor` and `code-reviewer` subagents run clean (nothing guest-PII-shaped in this phase, but the `organisation_id` denormalisation pattern will be audited against future phases).

## Next after this

`bookings` — the first phase that actually does the thing TableKit exists for. Inherits the denormalised-org pattern from here.
