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
//   - FKs are declared here; RLS policies + triggers live in the
//     migration SQL, not the schema (Drizzle can't express them)

import { sql } from "drizzle-orm";
import {
  customType,
  index,
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
