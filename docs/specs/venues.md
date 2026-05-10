# Spec: Venues, services, floor plan

**Status:** shipped
**Depends on:** `auth.md`

## What we're building

A venue is a physical location. Each venue has one or more services (e.g. "Brunch", "Dinner") with a schedule, and a floor plan of areas → tables.

## Entities

- `venues` — belongs to `organisations`. One organisation can have many venues.
- `areas` — groups of tables within a venue (e.g. "Terrace", "Bar").
- `tables` — individual bookable units. Each has a `min_cover` and `max_cover`.
- `services` — named service windows with schedule + turn time.

## User stories

- As an owner I can create a venue and pick a country/timezone/locale.
- As a manager I can draw my floor plan by creating areas and tables; I can rearrange them and set their minimum and maximum party size.
- As a manager I can define services by name, days of week, start/end time, and turn time.
- As a host I can see the floor plan on service day with bookings laid over tables.

## Acceptance criteria

- [x] Venue creation requires name, timezone, locale with defaults. [`app/(dashboard)/dashboard/venues/new/form.tsx`](../../app/(dashboard)/dashboard/venues/new/form.tsx) — name required, `timezone` defaults `Europe/London`, `locale` defaults `en-GB`, plus a `venue_type` radio (cafe / restaurant / bar_pub) that drives the seed template below.
- [x] Floor plan editor supports drag-drop. [`app/(dashboard)/dashboard/venues/[venueId]/floor-plan/table-shape.tsx`](../../app/(dashboard)/dashboard/venues/[venueId]/floor-plan/table-shape.tsx) — pointer-event drag in user-coord space with optimistic positioning + server-action persistence; covered by `floor-plan-visual.md`.
- [x] Tables combinable at booking time when `max_cover` is exceeded. [`lib/bookings/availability.ts`](../../lib/bookings/availability.ts) — combinable rule: two tables combine iff they share an area; unit-tested in `tests/unit/bookings-availability.test.ts`.
- [x] Services carry a JSON `schedule`. `services.schedule` (jsonb) + `services.turn_minutes` defined in [`lib/db/schema.ts`](../../lib/db/schema.ts).
- [x] Turn time default 90 minutes. `services.turnMinutes` column has `.default(90)` in the schema.
- [x] RLS — venues + areas + tables + services all scoped by `organisation_id` (denormalised on each table, populated by trigger). Verified by [`tests/integration/rls-venues-cross-tenant.test.ts`](../../tests/integration/rls-venues-cross-tenant.test.ts).
- [x] Opinionated default templates per `venue_type` for 15-minute activation. [`lib/venues/templates.ts`](../../lib/venues/templates.ts) — cafe (1 area, 6 tables, "Open" Mon–Sun 8–17, 45-min turn) / restaurant (Main + Bar, Lunch + Dinner, 90-min turn) / bar_pub (Inside + Outside, "Open", 60-min turn). Seeded on first venue create.

## Data model

```sql
create table venues (
  id              uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references organisations(id) on delete cascade,
  name            text not null,
  timezone        text not null default 'Europe/London',
  locale          text not null default 'en-GB',
  settings        jsonb not null default '{}',
  created_at      timestamptz not null default now()
);

create table areas (
  id       uuid primary key default gen_random_uuid(),
  venue_id uuid not null references venues(id) on delete cascade,
  name     text not null,
  sort     int  not null default 0
);

create table tables (
  id         uuid primary key default gen_random_uuid(),
  area_id    uuid not null references areas(id) on delete cascade,
  label      text not null,
  min_cover  int  not null default 1,
  max_cover  int  not null,
  shape      text not null default 'rect',
  position   jsonb not null default '{"x":0,"y":0,"w":2,"h":2}'
);

create table services (
  id        uuid primary key default gen_random_uuid(),
  venue_id  uuid not null references venues(id) on delete cascade,
  name      text not null,
  schedule  jsonb not null,
  turn_minutes int not null default 90
);
```

## Opinionated defaults

When a new venue is created, seed a template based on `venue_type`:

- **café**: one area "Inside", six 2–4 cover tables; one service "Open" Mon–Sun 8:00–17:00, 45-minute turn.
- **restaurant**: areas "Main" + "Bar"; services "Lunch" + "Dinner"; 90-minute turn.
- **bar / pub**: area "Inside" + "Outside"; service "Open"; 60-minute turn.

This is how we hit the 15-minute activation target.

## Out of scope

Full visual seat-by-seat drag-and-drop with custom shapes. Grid is enough for MVP.
