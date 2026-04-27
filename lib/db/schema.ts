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
  boolean,
  char,
  customType,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

// Raw bytes for the wrapped DEK (bytea). Drizzle's `bytea` helper
// returns strings by default; we want Buffers everywhere to keep the
// crypto layer typed.
const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return "bytea";
  },
});

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
  // Envelope encryption state. `wrappedDek` is this org's DEK sealed
  // with the master key (AES-256-GCM, `iv || tag || ciphertext` = 60
  // bytes). Nullable so organisations predating the crypto phase don't
  // fail the migration; `lib/security/crypto.ts` provisions lazily on
  // first encrypt/decrypt. `dekVersion` is forward-looking for key
  // rotation — only `1` exists today.
  wrappedDek: bytea("wrapped_dek"),
  dekVersion: integer("dek_version").notNull().default(1),
  // Plus-tier opt-in for cross-venue guest visibility. Default off so
  // existing single-venue orgs don't surprise-aggregate. Toggled by
  // owners on /dashboard/organisation. Storage on guests is already
  // org-scoped; the flag controls UI surfaces (group-wide guests
  // list, "also visited at" hints) rather than the data model.
  groupCrmEnabled: boolean("group_crm_enabled").notNull().default(false),
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
    // Per-venue scoping for managers / hosts. NULL means "all venues
    // in the org" (the legacy behaviour, also the default when an
    // owner promotes a member without specifying). A non-NULL array
    // restricts the caller's RLS-visible scope to those venues; the
    // user_can_access_venue() helper consumes this.
    venueIds: uuid("venue_ids").array(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.organisationId] }),
    index("memberships_org_idx").on(t.organisationId),
  ],
);

// Append-only log of security-relevant events. Per gdpr.md retention
// table: 2 years. Inserts are restricted by RLS — writes go through
// the audit.log() helper under lib/server/admin/.
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
    // Free-form external id — accepts our own UUIDs as well as Stripe
    // `acct_*` / `pi_*` / `seti_*`, Twilio SIDs, Resend message ids, etc.
    targetId: text("target_id"),
    metadata: jsonb("metadata")
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("audit_log_org_created_at").on(t.organisationId, t.createdAt.desc())],
);

// Platform-staff audit log. Distinct from public.audit_log (which is
// org-scoped). Records cross-org actions taken by Tablekit staff via
// the /admin dashboard.
//
// PLATFORM-ONLY — never add an organisation_id column or any column
// that joins this row back into operator-visible data. Writes happen
// exclusively via lib/server/admin/dashboard/audit.ts using adminDb().
// RLS policy on this table denies authenticated and anon outright —
// see migration 0020.
export const platformAuditLog = pgTable(
  "platform_audit_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    actorEmail: citext("actor_email").notNull(),
    action: text("action").notNull(),
    targetType: text("target_type"),
    targetId: uuid("target_id"),
    metadata: jsonb("metadata")
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("platform_audit_log_created_at_idx").on(t.createdAt.desc())],
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

// =============================================================================
// Guests
// =============================================================================
//
// Org-scoped. The guests-minimal phase ships only the columns bookings
// needs:
//   - first_name: plaintext for dashboard readability
//   - <field>_cipher: AES-256-GCM via lib/security/crypto.ts
//   - email_hash: HMAC-SHA256 lookup hash for `(org_id, email_hash)`
//     uniqueness and silent upsert dedup
//   - erased_at: plumbed so bookings can filter; DSAR scrub job lands
//     with the `guests-dsar` phase
//
// DoB, notes, phone hash, marketing suppression state are added by the
// features that need them.

export const guests = pgTable(
  "guests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organisationId: uuid("organisation_id")
      .notNull()
      .references(() => organisations.id, { onDelete: "cascade" }),
    firstName: text("first_name").notNull(),
    lastNameCipher: text("last_name_cipher").notNull(),
    emailCipher: text("email_cipher").notNull(),
    emailHash: text("email_hash").notNull(),
    phoneCipher: text("phone_cipher"),
    // Stripe Customer id on the org's connected account (cus_*). Null
    // until the guest's first payment flow. Reused across subsequent
    // bookings so repeat guests don't clutter the operator's Stripe
    // dashboard.
    stripeCustomerId: text("stripe_customer_id"),
    // Per-venue unsubscribe arrays. Storing venue ids (rather than a
    // global flag) lets the same guest opt out of one operator's
    // emails without affecting others — important because guests can
    // book at multiple venues across orgs.
    emailUnsubscribedVenues: uuid("email_unsubscribed_venues")
      .array()
      .notNull()
      .default(sql`ARRAY[]::uuid[]`),
    smsUnsubscribedVenues: uuid("sms_unsubscribed_venues")
      .array()
      .notNull()
      .default(sql`ARRAY[]::uuid[]`),
    // Hard-invalid markers — set by Resend bounce / Twilio failure
    // webhooks. Once true, dispatch skips the channel for all venues
    // until manually cleared.
    emailInvalid: boolean("email_invalid").notNull().default(false),
    phoneInvalid: boolean("phone_invalid").notNull().default(false),
    marketingConsentAt: timestamp("marketing_consent_at", { withTimezone: true }),
    erasedAt: timestamp("erased_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Dedup key for upsert + the primary lookup path. Partial index so
    // erased rows don't block a future re-signup under the same email.
    uniqueIndex("guests_org_email_hash_unique")
      .on(t.organisationId, t.emailHash)
      .where(sql`${t.erasedAt} is null`),
    index("guests_org_idx").on(t.organisationId),
  ],
);

// =============================================================================
// Bookings
// =============================================================================
//
// The transaction the product exists for. See .claude/plans/bookings.md
// for the full write-up. Shape notes:
//
//   - `bookings` holds the reservation, `booking_tables` (junction)
//     holds which tables it occupies. This lets one booking combine
//     two or more tables in the same area (8-top on 4 + 4).
//   - Double-booking prevention lives on `booking_tables` via an
//     EXCLUDE USING gist constraint (migration, not schema).
//   - `booking_events` is the append-only audit trail for state
//     changes + free-text notes added by hosts.
//   - `organisation_id` / `venue_id` are denormalised on every row
//     and kept in sync by triggers. No RLS subquery chains.

export const bookingStatus = pgEnum("booking_status", [
  "requested",
  "confirmed",
  "seated",
  "finished",
  "cancelled",
  "no_show",
]);

export const bookings = pgTable(
  "bookings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organisationId: uuid("organisation_id")
      .notNull()
      .references(() => organisations.id, { onDelete: "cascade" }),
    venueId: uuid("venue_id")
      .notNull()
      .references(() => venues.id, { onDelete: "cascade" }),
    serviceId: uuid("service_id")
      .notNull()
      .references(() => services.id),
    areaId: uuid("area_id")
      .notNull()
      .references(() => areas.id),
    guestId: uuid("guest_id")
      .notNull()
      .references(() => guests.id),
    partySize: integer("party_size").notNull(),
    startAt: timestamp("start_at", { withTimezone: true }).notNull(),
    endAt: timestamp("end_at", { withTimezone: true }).notNull(),
    status: bookingStatus("status").notNull().default("confirmed"),
    source: text("source").notNull(),
    // Plumbed for the payments phase; always null today.
    depositIntentId: text("deposit_intent_id"),
    notes: text("notes"),
    bookedByUserId: uuid("booked_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    cancelledReason: text("cancelled_reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("bookings_venue_start_idx").on(t.venueId, t.startAt),
    index("bookings_org_idx").on(t.organisationId),
    index("bookings_guest_idx").on(t.guestId),
  ],
);

export const bookingTables = pgTable(
  "booking_tables",
  {
    bookingId: uuid("booking_id")
      .notNull()
      .references(() => bookings.id, { onDelete: "cascade" }),
    tableId: uuid("table_id")
      .notNull()
      .references(() => venueTables.id, { onDelete: "cascade" }),
    organisationId: uuid("organisation_id").notNull(),
    venueId: uuid("venue_id").notNull(),
    areaId: uuid("area_id").notNull(),
    startAt: timestamp("start_at", { withTimezone: true }).notNull(),
    endAt: timestamp("end_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.bookingId, t.tableId] }),
    index("booking_tables_table_idx").on(t.tableId),
    index("booking_tables_org_idx").on(t.organisationId),
  ],
);

export const bookingEvents = pgTable(
  "booking_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organisationId: uuid("organisation_id").notNull(),
    bookingId: uuid("booking_id")
      .notNull()
      .references(() => bookings.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    actorUserId: uuid("actor_user_id").references(() => users.id, { onDelete: "set null" }),
    meta: jsonb("meta")
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("booking_events_booking_idx").on(t.bookingId, t.createdAt),
    index("booking_events_org_idx").on(t.organisationId),
  ],
);

// =============================================================================
// Reviews (reputation management — Phase 1: internal capture)
// =============================================================================
//
// One row per booking. organisation_id + venue_id are denormalised from
// the parent booking by the enforce_reviews_org_and_venue trigger.
// `comment_cipher` is envelope-encrypted PII (lib/security/crypto.ts).
// Future phases (Google Business Profile, TripAdvisor, Facebook) write
// rows with source != 'internal' from cron pull jobs; the booking_id
// link is nullable for those — but Phase 1 only writes 'internal' rows
// where booking_id is always set (unique).
//
// Erasure: when a guest is erased (guests.erased_at set), the future
// scrub job MUST null all of the following (and overwrite `rating` to
// 0 as a sentinel — CHECK allows 1..5, so a SECURITY DEFINER scrub
// function with the constraint deferred is needed):
//   - comment_cipher
//   - response_cipher, responded_at, responded_by_user_id
//     (cleared together to keep reviews_response_consistency_check)
//   - recovery_message_cipher, recovery_offer_at,
//     recovery_offered_by_user_id (cleared together to keep
//     reviews_recovery_consistency_check)
//   - showcase_consent_at (consent record no longer references a
//     living data subject)
// Operator attribution is dropped on guest erasure to leave no path
// back to the data subject. Cascade-delete is a defence-in-depth
// fallback for org-delete, not the primary erasure path. See
// docs/playbooks/gdpr.md §DSAR.

export const reviewSource = pgEnum("review_source", [
  "internal",
  "google",
  "tripadvisor",
  "facebook",
]);

// =============================================================================
// Venue OAuth connections (Phase 3a — Google Business Profile, extensible)
// =============================================================================
//
// One row per (venue, provider). Stores the OAuth access + refresh
// tokens (envelope-encrypted) and the provider-side account/location
// id we'll later call APIs against. organisation_id denormalised by
// trigger; per-venue RLS via user_visible_venue_ids().
//
// Forward-looking: TripAdvisor + Facebook (Phase 4) reuse this table
// by adding their entries to the oauth_provider enum.

export const oauthProvider = pgEnum("oauth_provider", [
  "google",
  "tripadvisor",
  "facebook",
]);

export const venueOauthConnections = pgTable(
  "venue_oauth_connections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organisationId: uuid("organisation_id")
      .notNull()
      .references(() => organisations.id, { onDelete: "cascade" }),
    venueId: uuid("venue_id")
      .notNull()
      .references(() => venues.id, { onDelete: "cascade" }),
    provider: oauthProvider("provider").notNull(),
    // Provider-side identifier we hold the connection against —
    // Google Business Profile location id, etc. Not secret.
    externalAccountId: text("external_account_id"),
    // OAuth tokens encrypted via crypto.encryptPii. Treat as
    // credentials — never log, never surface in error messages.
    accessTokenCipher: text("access_token_cipher").notNull(),
    refreshTokenCipher: text("refresh_token_cipher"),
    // Granted scopes, stored as a comma-joined string so a Drizzle
    // text column suffices. We don't query inside it.
    scopes: text("scopes").notNull().default(""),
    tokenExpiresAt: timestamp("token_expires_at", { withTimezone: true }),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("venue_oauth_connections_venue_provider_unique").on(t.venueId, t.provider),
    index("venue_oauth_connections_org_idx").on(t.organisationId),
  ],
);

export const reviews = pgTable(
  "reviews",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organisationId: uuid("organisation_id")
      .notNull()
      .references(() => organisations.id, { onDelete: "cascade" }),
    venueId: uuid("venue_id")
      .notNull()
      .references(() => venues.id, { onDelete: "cascade" }),
    // Phase 3b: booking_id + guest_id are nullable for non-internal
    // sources (Google / TripAdvisor / Facebook reviews aren't tied to
    // our bookings). Internal reviews still set both. Partial UNIQUE
    // on (booking_id) WHERE booking_id IS NOT NULL preserves the
    // "one internal review per booking" invariant.
    bookingId: uuid("booking_id").references(() => bookings.id, { onDelete: "cascade" }),
    guestId: uuid("guest_id").references(() => guests.id, { onDelete: "cascade" }),
    rating: integer("rating").notNull(),
    commentCipher: text("comment_cipher"),
    source: reviewSource("source").notNull().default("internal"),
    // Provider-side review id. Non-null for non-internal sources;
    // dedup via partial UNIQUE on (venue_id, source, external_id).
    externalId: text("external_id"),
    // Public URL on the source platform (e.g. the Google review link)
    // — surfaced in the operator dashboard.
    externalUrl: text("external_url"),
    // Reviewer's public display name as published by the source. Not
    // encrypted: it's already public on the source platform, and the
    // dashboard needs to render it.
    reviewerDisplayName: text("reviewer_display_name"),
    redirectedToExternal: boolean("redirected_to_external").notNull().default(false),
    submittedAt: timestamp("submitted_at", { withTimezone: true }).notNull().defaultNow(),
    // Operator reply (Phase 2). Encrypted via crypto.encryptPii because
    // it can quote the guest's comment back to them, and replies are
    // free-text so an operator could paste anything.
    responseCipher: text("response_cipher"),
    respondedAt: timestamp("responded_at", { withTimezone: true }),
    respondedByUserId: uuid("responded_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    // Phase 6 — escalation + recovery. `escalationAlertAt` is the
    // idempotency stamp for the operator-side alert email; once set
    // we don't re-alert on the same row. `recovery*` columns capture
    // the operator-triggered "we'd like to make it right" outbound
    // to the guest. recovery_message_cipher is encrypted PII (it can
    // quote the guest's comment back).
    escalationAlertAt: timestamp("escalation_alert_at", { withTimezone: true }),
    recoveryOfferAt: timestamp("recovery_offer_at", { withTimezone: true }),
    recoveryOfferedByUserId: uuid("recovery_offered_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    recoveryMessageCipher: text("recovery_message_cipher"),
    // Phase 7a — public showcase consent. Set when the guest ticks
    // the opt-in checkbox on the public submission page. NULL means
    // "not consented"; only consented rows are eligible for the
    // booking-widget showcase. Per-review (one consent ≠ blanket).
    showcaseConsentAt: timestamp("showcase_consent_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("reviews_venue_idx").on(t.venueId, t.submittedAt.desc()),
    index("reviews_org_idx").on(t.organisationId),
    index("reviews_guest_idx").on(t.guestId),
  ],
);

// =============================================================================
// Stripe (payments-connect phase)
// =============================================================================
//
// stripe_accounts is one-per-organisation (D1 in the payments-connect
// plan — we deviated from the spec which said per-venue; per-org
// matches operator mental model and avoids N re-onboardings).
//
// stripe_events is the idempotency table. Every webhook event Stripe
// delivers is written here by its evt_* id with ON CONFLICT DO
// NOTHING, so retries are free. `handled_at` lets us tell at a glance
// which events our dispatch map has acted on versus which are just
// stored for future phases.

export const stripeAccounts = pgTable("stripe_accounts", {
  id: uuid("id").primaryKey().defaultRandom(),
  organisationId: uuid("organisation_id")
    .notNull()
    .unique()
    .references(() => organisations.id, { onDelete: "cascade" }),
  accountId: text("account_id").notNull().unique(),
  chargesEnabled: boolean("charges_enabled").notNull().default(false),
  payoutsEnabled: boolean("payouts_enabled").notNull().default(false),
  detailsSubmitted: boolean("details_submitted").notNull().default(false),
  country: char("country", { length: 2 }),
  defaultCurrency: char("default_currency", { length: 3 }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// Every Stripe webhook event we've ever received, keyed by the evt_*
// id. Primary-key conflict = duplicate delivery from Stripe, we no-op.
// `handled_at` is set when dispatch runs a registered handler; an
// event can be stored without being handled yet (e.g. an event type
// whose handler lands in a later phase).
export const stripeEvents = pgTable(
  "stripe_events",
  {
    id: text("id").primaryKey(), // evt_xxx
    type: text("type").notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
    handledAt: timestamp("handled_at", { withTimezone: true }),
    payload: jsonb("payload").notNull(),
  },
  (t) => [
    index("stripe_events_type_idx").on(t.type),
    // Partial index for the "needs a handler" worklist.
    index("stripe_events_unhandled_idx")
      .on(t.receivedAt)
      .where(sql`${t.handledAt} is null`),
  ],
);

// =============================================================================
// Payments (payments-deposits phase)
// =============================================================================
//
// `deposit_rules` — per-venue rules for when to require a deposit / card
// hold. Resolver at lib/payments/rules.ts picks at most one rule per
// booking using a documented priority order. `kind` is free text at the
// Drizzle level; the migration pins it with a CHECK constraint so new
// values can't sneak in.
//
// `payments` — one row per Stripe Intent we've created or observed.
// Flows: 'deposit' (pi_*, charged at booking), 'hold' (seti_*, flow B
// in the spec — Phase 2), 'no_show_capture' (pi_*, Phase 2), 'refund'
// (re_*, negative amount, dashboard-initiated).
//
// The `stripe_intent_id` column stores a synthetic `pending_<bookingId>`
// placeholder for the brief window between the DB transaction commit
// and the out-of-transaction Stripe API call. The janitor sweeps any
// placeholder still pending after 15 minutes.

export const depositRules = pgTable(
  "deposit_rules",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // Populated by enforce_deposit_rules_org_id from the parent venue.
    organisationId: uuid("organisation_id")
      .notNull()
      .references(() => organisations.id, { onDelete: "cascade" }),
    venueId: uuid("venue_id")
      .notNull()
      .references(() => venues.id, { onDelete: "cascade" }),
    // null = applies to all services in the venue.
    serviceId: uuid("service_id").references(() => services.id, { onDelete: "cascade" }),
    minParty: integer("min_party").notNull().default(1),
    // null = no ceiling.
    maxParty: integer("max_party"),
    // 0 = Sunday … 6 = Saturday (matches JS Date.getDay()). Default is
    // all days of the week.
    dayOfWeek: integer("day_of_week")
      .array()
      .notNull()
      .default(sql`ARRAY[0,1,2,3,4,5,6]::integer[]`),
    // 'per_cover' | 'flat' | 'card_hold' — constrained in the migration.
    kind: text("kind").notNull(),
    amountMinor: integer("amount_minor").notNull(),
    currency: char("currency", { length: 3 }).notNull().default("GBP"),
    refundWindowHours: integer("refund_window_hours").notNull().default(24),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("deposit_rules_venue_idx").on(t.venueId),
    index("deposit_rules_org_idx").on(t.organisationId),
  ],
);

export const payments = pgTable(
  "payments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // Populated by enforce_payments_org_id from the parent booking.
    organisationId: uuid("organisation_id")
      .notNull()
      .references(() => organisations.id, { onDelete: "cascade" }),
    bookingId: uuid("booking_id")
      .notNull()
      .references(() => bookings.id, { onDelete: "cascade" }),
    // 'deposit' | 'hold' | 'no_show_capture' | 'refund' — constrained
    // in the migration.
    kind: text("kind").notNull(),
    // pi_* | seti_* | re_* in steady state; `pending_<bookingId>` in
    // the brief window between transaction commit and successful Stripe
    // call. Unique per row — the janitor never gets confused by ghosts.
    stripeIntentId: text("stripe_intent_id").notNull().unique(),
    // Denormalised pointer for convenience. Source of truth lives on
    // guests.stripe_customer_id.
    stripeCustomerId: text("stripe_customer_id"),
    stripePaymentMethodId: text("stripe_payment_method_id"),
    // Minor units. Negative for refunds.
    amountMinor: integer("amount_minor").notNull(),
    currency: char("currency", { length: 3 }).notNull(),
    // Mirrors Stripe status verbatim: 'pending_creation',
    // 'requires_payment_method', 'requires_action', 'succeeded',
    // 'canceled', 'failed', etc.
    status: text("status").notNull(),
    failureCode: text("failure_code"),
    failureMessage: text("failure_message"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("payments_booking_idx").on(t.bookingId),
    index("payments_org_idx").on(t.organisationId),
  ],
);

// =============================================================================
// Messaging (transactional email + SMS)
// =============================================================================
//
// One row per (booking, template, channel) — uniqueness enforced both
// for idempotency (a confirmation can't fire twice) and to give the
// dispatch worker a clear contract: queued rows are work items.
//
// status lifecycle:
//   queued -> sending -> sent       (provider accepted)
//                     -> delivered  (provider webhook confirmed)
//                     -> bounced    (provider webhook reported bounce)
//                     -> failed     (exhausted retries)
//   queued -> failed                (hard reject before any send)
//
// next_attempt_at gates the worker's WHERE clause so retries respect
// the backoff schedule. attempts counts retries (0 on first send).

export const messages = pgTable(
  "messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // Populated by enforce_messages_org_id from the parent booking.
    organisationId: uuid("organisation_id")
      .notNull()
      .references(() => organisations.id, { onDelete: "cascade" }),
    bookingId: uuid("booking_id")
      .notNull()
      .references(() => bookings.id, { onDelete: "cascade" }),
    // 'email' | 'sms' — constrained in the migration.
    channel: text("channel").notNull(),
    // 'booking.confirmation' | 'booking.reminder_24h' | 'booking.reminder_2h'
    // | 'booking.cancelled' | 'booking.thank_you' | 'booking.waitlist_ready'
    // — also constrained in the migration so a typo can't slip past.
    template: text("template").notNull(),
    // 'queued' | 'sending' | 'sent' | 'delivered' | 'bounced' | 'failed'
    status: text("status").notNull().default("queued"),
    // Provider's message id once accepted (re_*, MS… for Twilio, etc.)
    providerId: text("provider_id"),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
    // Last error message — kept for the dashboard; truncated to 500
    // chars at write time so a verbose Stripe-style trace doesn't bloat
    // the row.
    error: text("error"),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Idempotency key per spec — two attempts to enqueue the same
    // (booking, template, channel) collapse to one row.
    uniqueIndex("messages_booking_template_channel_unique").on(t.bookingId, t.template, t.channel),
    index("messages_booking_idx").on(t.bookingId),
    index("messages_org_idx").on(t.organisationId),
    // Worker work-list: queued rows whose next_attempt_at has come due.
    // Partial index keeps the working set small on a hot table.
    index("messages_worker_idx")
      .on(t.nextAttemptAt)
      .where(sql`${t.status} in ('queued','sending')`),
  ],
);

// =============================================================================
// Waitlist (walk-ins)
// =============================================================================
//
// Single-row-per-walk-in entry. Status moves through:
//   waiting -> seated      (host seats them; seated_booking_id set)
//   waiting -> cancelled   (one-tap host action)
//   waiting -> left        (guest gave up; host marks)
// Constrained in the migration. organisation_id denormalised from the
// parent venue via enforce_waitlists_org_id (matching the deposit_rules
// pattern).

export const waitlists = pgTable(
  "waitlists",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organisationId: uuid("organisation_id")
      .notNull()
      .references(() => organisations.id, { onDelete: "cascade" }),
    venueId: uuid("venue_id")
      .notNull()
      .references(() => venues.id, { onDelete: "cascade" }),
    guestId: uuid("guest_id")
      .notNull()
      .references(() => guests.id),
    partySize: integer("party_size").notNull(),
    // 'waiting' | 'seated' | 'left' | 'cancelled'
    status: text("status").notNull().default("waiting"),
    // Set when status transitions to 'seated' — points at the booking
    // we created for the walk-in (source='walk-in'). FK lets the
    // dashboard link straight to the booking row.
    seatedBookingId: uuid("seated_booking_id").references(() => bookings.id, {
      onDelete: "set null",
    }),
    // Free-text per-row note hosts can add ("waiting at bar", "outside
    // table only").
    notes: text("notes"),
    requestedAt: timestamp("requested_at", { withTimezone: true }).notNull().defaultNow(),
    seatedAt: timestamp("seated_at", { withTimezone: true }),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("waitlists_venue_idx").on(t.venueId),
    index("waitlists_org_idx").on(t.organisationId),
    // Active-queue working set — the dashboard's primary read path.
    index("waitlists_venue_active_idx")
      .on(t.venueId, t.requestedAt)
      .where(sql`${t.status} = 'waiting'`),
  ],
);

// =============================================================================
// DSAR (data subject access / rectification / erasure) requests
// =============================================================================
//
// The guest-facing /privacy/request form posts a row here. The
// operator works through the inbox at /dashboard/privacy-requests.
//
// We hash the requester's email so an operator can find a matching
// guest record without us decrypting plaintext at scrub time. The
// requester's email is also stored encrypted (display only, after
// the operator clicks into the request).
//
// `due_at` defaults to created_at + 30 days at insert (set in the
// domain helper, not the schema, so the SLA clock follows the
// `requested_at` semantics rather than `created_at`).

export const dsarRequests = pgTable(
  "dsar_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organisationId: uuid("organisation_id")
      .notNull()
      .references(() => organisations.id, { onDelete: "cascade" }),
    // 'export' | 'rectify' | 'erase' — constrained in the migration.
    kind: text("kind").notNull(),
    // 'pending' | 'in_progress' | 'completed' | 'rejected'.
    status: text("status").notNull().default("pending"),
    // HMAC of the lowercased+trimmed requester email — same scheme as
    // guests.email_hash. Lets the operator (or a future automated
    // matcher) find the corresponding guest row without decrypting.
    requesterEmailHash: text("requester_email_hash").notNull(),
    // Encrypted requester email — versioned ciphertext envelope. Only
    // decrypted on the request-detail page in the dashboard.
    requesterEmailCipher: text("requester_email_cipher").notNull(),
    // Free-text from the requester ("which booking", "what to correct").
    // Encrypted because it can include PII the requester chose to share.
    messageCipher: text("message_cipher"),
    // Resolved-to guest record (operator action when they identify
    // the matching profile). FK keeps the link if the guest is later
    // erased (set null on delete).
    guestId: uuid("guest_id").references(() => guests.id, { onDelete: "set null" }),
    // Operator notes when actioning. Plaintext — operator-authored,
    // intended audit trail rather than PII bucket.
    resolutionNotes: text("resolution_notes"),
    // requested_at + 30 days. Pre-computed so the dashboard can ORDER
    // BY due_at without per-row arithmetic. Refreshed if the request
    // is reopened.
    dueAt: timestamp("due_at", { withTimezone: true }).notNull(),
    requestedAt: timestamp("requested_at", { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("dsar_requests_org_idx").on(t.organisationId),
    // Active-queue working set — what the operator inbox needs.
    index("dsar_requests_active_idx")
      .on(t.organisationId, t.dueAt)
      .where(sql`${t.status} in ('pending','in_progress')`),
  ],
);
