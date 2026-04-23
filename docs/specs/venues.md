# Spec: Venues, services, floor plan

**Status:** draft
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

- [ ] Venue creation requires name, timezone, locale (defaults to `Europe/London` and `en-GB`).
- [ ] Floor plan editor supports drag-drop in a 2D grid (simple — not pixel-perfect).
- [ ] Tables can be combined at booking time if `max_cover` is exceeded (handled in bookings spec).
- [ ] Services carry a JSON `schedule` like `{"days":["mon","tue",...],"start":"18:00","end":"22:00"}`.
- [ ] Turn time per service, default 90 minutes.
- [ ] RLS: every table scoped by `organisation_id` via `venues.organisation_id`.

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
