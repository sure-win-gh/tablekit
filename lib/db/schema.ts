// Drizzle schema for the TableKit Postgres DB.
//
// Only the tables we actually own live here. `auth.users` (Supabase's
// own) is referenced by FK from `public.users` via raw SQL in the
// migration — Drizzle doesn't model the `auth` schema.
//
// Conventions:
//   - camelCase in TS, snake_case in Postgres (Drizzle maps both)
//   - every table has an explicit `createdAt timestamptz not null default now()`
//   - `citext` for case-insensitive uniqueness (email, slug)
//   - every tenant-scoped table carries a denormalised `organisation_id`
//     populated by a BEFORE INSERT trigger from the parent; RLS
//     policies use that column directly for a one-hop equality check.
//   - FKs are declared here; RLS policies + triggers live in the
//     migration SQL, not the schema (Drizzle can't express them)

import { sql } from "drizzle-orm";
import {
  customType,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

// Case-insensitive text. The `citext` extension is created in the
// migration that ships with this schema.
const citext = customType<{ data: string }>({
  dataType() {
    return "citext";
  },
});

// =============================================================================
// Auth
// =============================================================================

export const orgRole = pgEnum("org_role", ["owner", "manager", "host"]);

export const organisations = pgTable("organisations", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  slug: citext("slug").notNull().unique(),
  plan: text("plan").notNull().default("free"),
  stripeCustomerId: text("stripe_customer_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const users = pgTable("users", {
  // References auth.users(id); FK added in the migration because
  // Drizzle doesn't model the `auth` schema. `on delete cascade` there.
  id: uuid("id").primaryKey(),
  email: citext("email").notNull().unique(),
  fullName: text("full_name"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const memberships = pgTable(
  "memberships",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    organisationId: uuid("organisation_id")
      .notNull()
      .references(() => organisations.id, { onDelete: "cascade" }),
    role: orgRole("role").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.organisationId] }),
    index("memberships_org_idx").on(t.organisationId),
  ],
);

// Append-only log of security-relevant events. Per gdpr.md retention
// table: 2 years. Inserts are restricted by RLS to service_role only —
// writes go through the audit.log() helper under lib/server/admin/.
export const auditLog = pgTable(
  "audit_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organisationId: uuid("organisation_id")
      .notNull()
      .references(() => organisations.id, { onDelete: "cascade" }),
    actorUserId: uuid("actor_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    action: text("action").notNull(),
    targetType: text("target_type"),
    targetId: uuid("target_id"),
    metadata: jsonb("metadata")
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("audit_log_org_created_at").on(t.organisationId, t.createdAt.desc())],
);

// =============================================================================
// Venues
// =============================================================================
//
// `areas`, `tables`, `services` each carry a denormalised
// `organisation_id` synced from their parent by a BEFORE INSERT/UPDATE
// trigger (see the venues migration). That keeps RLS policies one-hop
// and stops the `bookings` phase inheriting 4-deep subquery chains.

export const venueType = pgEnum("venue_type", ["cafe", "restaurant", "bar_pub"]);

export const venues = pgTable(
  "venues",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organisationId: uuid("organisation_id")
      .notNull()
      .references(() => organisations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    venueType: venueType("venue_type").notNull(),
    timezone: text("timezone").notNull().default("Europe/London"),
    locale: text("locale").notNull().default("en-GB"),
    settings: jsonb("settings")
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("venues_org_idx").on(t.organisationId)],
);

export const areas = pgTable(
  "areas",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // Populated by the enforce_areas_org_id trigger from the parent
    // venue. Declared here so TS reads include the column.
    organisationId: uuid("organisation_id")
      .notNull()
      .references(() => organisations.id, { onDelete: "cascade" }),
    venueId: uuid("venue_id")
      .notNull()
      .references(() => venues.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    sort: integer("sort").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("areas_venue_idx").on(t.venueId), index("areas_org_idx").on(t.organisationId)],
);

// `tables` exported under a non-ambiguous alias for callers — `tables`
// is a common local variable name; the TS alias `venueTables` keeps
// imports readable.
export const venueTables = pgTable(
  "tables",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // Populated by the enforce_tables_org_and_venue trigger from the
    // parent area.
    organisationId: uuid("organisation_id")
      .notNull()
      .references(() => organisations.id, { onDelete: "cascade" }),
    venueId: uuid("venue_id")
      .notNull()
      .references(() => venues.id, { onDelete: "cascade" }),
    areaId: uuid("area_id")
      .notNull()
      .references(() => areas.id, { onDelete: "cascade" }),
    label: text("label").notNull(),
    minCover: integer("min_cover").notNull().default(1),
    maxCover: integer("max_cover").notNull(),
    shape: text("shape").notNull().default("rect"),
    position: jsonb("position")
      .notNull()
      .default(sql`'{"x":0,"y":0,"w":2,"h":2}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("tables_venue_idx").on(t.venueId),
    index("tables_org_idx").on(t.organisationId),
    index("tables_area_idx").on(t.areaId),
  ],
);

export const services = pgTable(
  "services",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // Populated by the enforce_services_org_id trigger from the parent
    // venue.
    organisationId: uuid("organisation_id")
      .notNull()
      .references(() => organisations.id, { onDelete: "cascade" }),
    venueId: uuid("venue_id")
      .notNull()
      .references(() => venues.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    // Shape: { days: string[], start: "HH:MM", end: "HH:MM" }
    // Validated at the server-action boundary via Zod.
    schedule: jsonb("schedule").notNull(),
    turnMinutes: integer("turn_minutes").notNull().default(90),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("services_venue_idx").on(t.venueId),
    index("services_org_idx").on(t.organisationId),
  ],
);
