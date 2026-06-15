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
  type AnyPgColumn,
  bigint,
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

export const organisations = pgTable(
  "organisations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    slug: citext("slug").notNull().unique(),
    plan: text("plan").notNull().default("free"),
    // Platform-account Stripe Customer (Tablekit = merchant for the SaaS
    // subscription + credit top-ups). DISTINCT from guests.stripe_customer_id,
    // which is a per-guest Customer on the venue's CONNECTED account for
    // deposits. First writer is lib/billing/checkout.ts. See docs/specs/stripe-billing.md.
    stripeCustomerId: text("stripe_customer_id"),
    // Prepaid messaging-credit balance in pence. Marketing campaigns are
    // gated on this (reserve-on-launch); transactional sends never touch it.
    // Mutated only alongside a billing_credit_ledger row, in one tx, under
    // a row lock. See lib/billing/credit.ts (PR-2).
    creditBalancePence: integer("credit_balance_pence").notNull().default(0),
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
    // Per-org override for the POS order/spend retention sweep, in months.
    // NULL → the code default (24 months) applies. Mirrors the configurable
    // window on the campaign-send sweep. See lib/pos/retention.ts.
    posRetentionMonths: integer("pos_retention_months"),
    // Outreach pre-populated accounts: NULL until the prospect claims via
    // the magic link in their outreach email; set to the claim timestamp
    // on success. Normal signups backfill to created_at in the migration
    // so the purge cron doesn't sweep them. See lib/outreach/.
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    // Provenance tag for outreach-created orgs, e.g. `"places:ChIJ..."`.
    // NULL for normal signups.
    outreachSource: text("outreach_source"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Partial index for the daily purge cron — scans only unclaimed
    // outreach orgs rather than the full table.
    index("organisations_unclaimed_idx")
      .on(t.createdAt)
      .where(sql`${t.claimedAt} is null`),
  ],
);

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

// Pending invitations for an organisation. The token sent by email
// is opaque random bytes; only its SHA-256 hash lives here, so a DB
// leak doesn't expose live invite URLs. State machine: rows start
// pending (acceptedAt + revokedAt both null), become "accepted" once
// the invitee signs up + a membership lands, or "revoked" once an
// owner cancels. Expired rows (expiresAt < now) are treated as dead
// without UPDATE — the accept handler refuses them.
export const orgInvitations = pgTable(
  "org_invitations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organisationId: uuid("organisation_id")
      .notNull()
      .references(() => organisations.id, { onDelete: "cascade" }),
    email: citext("email").notNull(),
    role: orgRole("role").notNull(),
    // SHA-256 hash of the random token. Plaintext lives only in the
    // emailed URL + the inviter's browser session for ~1 second.
    tokenHash: text("token_hash").notNull().unique(),
    invitedByUserId: uuid("invited_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("org_invitations_org_created_idx").on(t.organisationId, t.createdAt.desc()),
    index("org_invitations_email_idx").on(t.email),
  ],
);

// Outreach claim tokens. Distinct from org_invitations — this isn't an
// invite to join an existing team, it's a one-shot link that hands the
// whole org over to its first owner. Founder creates the pre-populated
// org via the internal /admin/outreach tool, mints a token here, emails
// the prospect; the prospect's first claim becomes the org's owner and
// flips organisations.claimed_at. Unclaimed orgs auto-purge after 30
// days via a Vercel cron — the TTL here matches that window.
//
// RLS posture: deny-all to authenticated and anon. The internal admin
// UI (super-admin gated) and the public claim flow both go through
// adminDb(). No tenant-scope column; this table is platform-level.
export const outreachClaims = pgTable(
  "outreach_claims",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organisationId: uuid("organisation_id")
      .notNull()
      .unique()
      .references(() => organisations.id, { onDelete: "cascade" }),
    // SHA-256 hash of the random token; plaintext lives in the emailed
    // URL only. Mirrors the org_invitations posture.
    tokenHash: text("token_hash").notNull().unique(),
    prospectEmail: citext("prospect_email").notNull(),
    prospectName: text("prospect_name"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    claimedByUserId: uuid("claimed_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    // Founder (or future delegated platform admin) who minted the link.
    // Nullable + ON DELETE SET NULL so a GDPR-driven user erasure
    // doesn't cascade-delete the claim row (audit-trail preservation
    // wins over attribution completeness).
    createdByUserId: uuid("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("outreach_claims_created_at_idx").on(t.createdAt.desc())],
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
    // Optional human-readable URL slug. Platform-wide unique among
    // non-null values (partial index below). Format enforced by a
    // CHECK constraint as well as Zod at the form layer.
    slug: citext("slug"),
    venueType: venueType("venue_type").notNull(),
    timezone: text("timezone").notNull().default("Europe/London"),
    locale: text("locale").notNull().default("en-GB"),
    settings: jsonb("settings")
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("venues_org_idx").on(t.organisationId),
    uniqueIndex("venues_slug_unique")
      .on(t.slug)
      .where(sql`${t.slug} is not null`),
  ],
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

// Per-service capacity override. Absent row = capacity falls back to the
// summed max_cover of the venue's tables. Present row = the service runs a
// smaller room than the floor plan implies (e.g. brunch with half the
// floor closed). One override per service (unique service_id) so the edit
// form can upsert. organisation_id is denormalised from the parent service
// by the enforce_service_capacity_overrides_org_id trigger.
export const serviceCapacityOverrides = pgTable(
  "service_capacity_overrides",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organisationId: uuid("organisation_id")
      .notNull()
      .references(() => organisations.id, { onDelete: "cascade" }),
    serviceId: uuid("service_id")
      .notNull()
      .unique()
      .references(() => services.id, { onDelete: "cascade" }),
    capacity: integer("capacity").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("service_capacity_overrides_org_idx").on(t.organisationId)],
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
    // Deterministic lookup hash for the phone, same HMAC as email_hash
    // (hashForLookup(value,"phone")). Nullable: only set when a phone is
    // known, and backfilled for pre-existing rows. Enables POS phone-hash
    // matching + "find guest by phone" without decrypting. Not unique —
    // email_hash remains the dedup key; two profiles may share a number.
    phoneHash: text("phone_hash"),
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
    // WhatsApp shares the encrypted phone_cipher number but tracks its
    // own per-venue opt-out — a guest can be on email + SMS at a venue
    // and still STOP its WhatsApp without affecting the others.
    whatsappUnsubscribedVenues: uuid("whatsapp_unsubscribed_venues")
      .array()
      .notNull()
      .default(sql`ARRAY[]::uuid[]`),
    // Hard-invalid markers — set by Resend bounce / Twilio failure
    // webhooks. Once true, dispatch skips the channel for all venues
    // until manually cleared.
    emailInvalid: boolean("email_invalid").notNull().default(false),
    phoneInvalid: boolean("phone_invalid").notNull().default(false),
    // Set by the Twilio WhatsApp status webhook on a permanent delivery
    // failure (number not on WhatsApp, blocked, etc.). Distinct from
    // phoneInvalid because a number can be SMS-reachable but not on
    // WhatsApp, and vice versa.
    whatsappInvalid: boolean("whatsapp_invalid").notNull().default(false),
    // Legacy single-channel consent. Kept alongside the per-channel
    // pair below for one release per the forward-only migration rule
    // — new writes mirror to it; the next migration drops it once
    // every reader has moved to the per-channel columns.
    marketingConsentAt: timestamp("marketing_consent_at", { withTimezone: true }),
    marketingConsentEmailAt: timestamp("marketing_consent_email_at", { withTimezone: true }),
    marketingConsentSmsAt: timestamp("marketing_consent_sms_at", { withTimezone: true }),
    marketingConsentWhatsappAt: timestamp("marketing_consent_whatsapp_at", { withTimezone: true }),
    // Operator-curated short labels for at-a-glance recognition on the
    // floor (VIP, allergy:nuts, loud-party, ...). Plaintext per
    // docs/specs/guests.md — operator-controlled, not guest PII. Length
    // + content validation lives in lib/guests/profile-schema.ts so
    // operators can't paste an email here.
    tags: text("tags")
      .array()
      .notNull()
      .default(sql`ARRAY[]::text[]`),
    // Sticky guest-level notes: severe allergies, accessibility needs,
    // preferences that persist across visits. Special-category data
    // under UK GDPR Art. 9 — envelope-encrypted via lib/security/crypto.
    // Per-visit dietary notes live on bookings.dietary_notes_cipher.
    notesCipher: text("notes_cipher"),
    erasedAt: timestamp("erased_at", { withTimezone: true }),
    // Provenance for imported guests. Populated by the import job;
    // null for guests created via the booking flow or the dashboard.
    // Source values match `import_jobs.source` (opentable | resdiary |
    // sevenrooms | generic-csv).
    importedFrom: text("imported_from"),
    importedAt: timestamp("imported_at", { withTimezone: true }),
    // FK linkage to the parent import job — populated by the runner
    // when a guest is created via bulk import. Required by gdpr.md
    // §DSAR step 4 so the erasure scrub can find any source CSV
    // still holding the guest's plaintext (failed-job retry window).
    // ON DELETE SET NULL keeps the guest row when the parent job is
    // purged at retention end. Forward reference — `importJobs` is
    // defined later in the file; Drizzle's thunk handles it.
    importJobId: uuid("import_job_id").references((): AnyPgColumn => importJobs.id, {
      onDelete: "set null",
    }),
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
    // Phone lookup path (POS phone-hash match). Partial — only rows that
    // actually carry a phone hash.
    index("guests_org_phone_hash_idx")
      .on(t.organisationId, t.phoneHash)
      .where(sql`${t.phoneHash} is not null`),
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
    // Per-visit covers requiring a high chair. Not PII; defaults to 0
    // so existing rows + new walk-ins don't need to think about it.
    highChairs: integer("high_chairs").notNull().default(0),
    // Per-visit dietary / allergy notes added at booking or by the
    // host on arrival. Special-category data under UK GDPR Art. 9 —
    // envelope-encrypted via lib/security/crypto.
    dietaryNotesCipher: text("dietary_notes_cipher"),
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
    // Lead-time + creation-bucketed analytics filter on created_at, which
    // the (venue_id, start_at) index doesn't cover.
    index("bookings_venue_created_idx").on(t.venueId, t.createdAt),
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

export const oauthProvider = pgEnum("oauth_provider", ["google", "tripadvisor", "facebook"]);

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
    // Phase 5 — AI sentiment classification. Three-bucket label
    // ('positive' | 'neutral' | 'negative') populated by a fire-and-
    // forget Bedrock call after insert. NULL = not classified yet
    // (either still pending, or the review had no comment + we
    // declined to classify from rating alone). CHECK constrained in
    // the migration.
    sentiment: text("sentiment"),
    sentimentClassifiedAt: timestamp("sentiment_classified_at", { withTimezone: true }),
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
    // 'email' | 'sms' | 'whatsapp' — constrained in the migration.
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
// Message templates (per-venue content overrides — Phase 2)
// =============================================================================
//
// Operator-authored copy overrides for lifecycle messages. When a row
// exists for a (venue, template, channel) the dispatch render layer uses
// it instead of the shipped default, interpolating a fixed merge-tag set
// (lib/messaging/merge-tags.ts). The unsubscribe footer + STOP line are
// always re-appended by the render layer and cannot be edited away.
//
// `body_override` / `subject_override` are OPERATOR copy, not guest PII —
// plaintext, same posture as bookings.notes. Operators must not paste
// guest contact details here (the editor warns). organisation_id is
// synced from the parent venue by a before-insert trigger (messages
// pattern); RLS scopes reads to org members.
export const messageTemplates = pgTable(
  "message_templates",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // Populated by enforce_message_templates_org_id from the parent venue.
    organisationId: uuid("organisation_id")
      .notNull()
      .references(() => organisations.id, { onDelete: "cascade" }),
    venueId: uuid("venue_id")
      .notNull()
      .references(() => venues.id, { onDelete: "cascade" }),
    // MessageTemplate value — constrained in the migration (shares the
    // messages_template_check allow-list shape).
    template: text("template").notNull(),
    // 'email' | 'sms' | 'whatsapp' — constrained in the migration.
    channel: text("channel").notNull(),
    // Email-only; null for sms/whatsapp.
    subjectOverride: text("subject_override"),
    bodyOverride: text("body_override"),
    enabled: boolean("enabled").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("message_templates_venue_template_channel_unique").on(
      t.venueId,
      t.template,
      t.channel,
    ),
    index("message_templates_org_idx").on(t.organisationId),
    index("message_templates_venue_idx").on(t.venueId),
  ],
);

// =============================================================================
// Venue photos (booking-page Phase 2)
// =============================================================================
//
// Operator-uploaded gallery images for the rich (Core+) booking page. The
// file itself lives in the public `venue-photos` Supabase Storage bucket;
// this row holds the storage path + display order. Not guest PII — same
// plaintext posture as the venue profile. organisation_id is synced from the
// parent venue by enforce_venue_photos_org_id; RLS scopes reads to org
// members. Writes go through the dashboard action via adminDb() (org-guarded).
export const venuePhotos = pgTable(
  "venue_photos",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // Populated by enforce_venue_photos_org_id from the parent venue.
    organisationId: uuid("organisation_id")
      .notNull()
      .references(() => organisations.id, { onDelete: "cascade" }),
    venueId: uuid("venue_id")
      .notNull()
      .references(() => venues.id, { onDelete: "cascade" }),
    // Path within the public `venue-photos` bucket, e.g. "<venueId>/<uuid>.webp".
    storagePath: text("storage_path").notNull(),
    // Optional operator caption / alt text.
    caption: text("caption"),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("venue_photos_storage_path_unique").on(t.storagePath),
    index("venue_photos_org_idx").on(t.organisationId),
    index("venue_photos_venue_sort_idx").on(t.venueId, t.sortOrder),
  ],
);

// =============================================================================
// Marketing campaigns (Phase 3 — Plus tier)
// =============================================================================
//
// Guest-scoped broadcast, beside the booking-scoped `messages` queue.
// `body` / `subject` are operator copy (merge tags), not guest PII —
// same plaintext posture as bookings.notes / message_templates.
// organisation_id synced from the parent venue by a before-insert
// trigger; RLS scopes reads to org members.
export const campaigns = pgTable(
  "campaigns",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organisationId: uuid("organisation_id")
      .notNull()
      .references(() => organisations.id, { onDelete: "cascade" }),
    venueId: uuid("venue_id")
      .notNull()
      .references(() => venues.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    // 'email' | 'sms' | 'whatsapp' — constrained in the migration.
    channel: text("channel").notNull(),
    // 'draft' | 'scheduled' | 'sending' | 'sent' | 'cancelled'
    status: text("status").notNull().default("draft"),
    // Target segment (Phase 4): 'all' | 'new' | 'regular' | 'lapsed' |
    // 'vip' — constrained in the migration. Recorded so the send-time
    // re-check + any re-fan-out use the same audience.
    segment: text("segment").notNull().default("all"),
    subjectOverride: text("subject_override"),
    body: text("body").notNull(),
    scheduledAt: timestamp("scheduled_at", { withTimezone: true }),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    // Rolling tallies {queued,sent,delivered,failed,opened,clicked} kept
    // for the dashboard without a per-render aggregate query.
    counts: jsonb("counts")
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("campaigns_org_idx").on(t.organisationId),
    index("campaigns_venue_idx").on(t.venueId),
  ],
);

// One row per (campaign, guest, channel). Idempotent fan-out + the
// worker work-list. Mirrors the `messages` row shape.
export const campaignSends = pgTable(
  "campaign_sends",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // Populated by enforce_campaign_sends_org_id from the parent campaign.
    organisationId: uuid("organisation_id")
      .notNull()
      .references(() => organisations.id, { onDelete: "cascade" }),
    campaignId: uuid("campaign_id")
      .notNull()
      .references(() => campaigns.id, { onDelete: "cascade" }),
    guestId: uuid("guest_id")
      .notNull()
      .references(() => guests.id, { onDelete: "cascade" }),
    venueId: uuid("venue_id")
      .notNull()
      .references(() => venues.id, { onDelete: "cascade" }),
    channel: text("channel").notNull(),
    // 'queued' | 'sending' | 'sent' | 'delivered' | 'bounced' | 'failed'
    status: text("status").notNull().default("queued"),
    providerId: text("provider_id"),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
    openedAt: timestamp("opened_at", { withTimezone: true }),
    clickedAt: timestamp("clicked_at", { withTimezone: true }),
    error: text("error"),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("campaign_sends_campaign_guest_channel_unique").on(
      t.campaignId,
      t.guestId,
      t.channel,
    ),
    index("campaign_sends_campaign_idx").on(t.campaignId),
    index("campaign_sends_org_idx").on(t.organisationId),
    index("campaign_sends_provider_idx").on(t.providerId),
    index("campaign_sends_worker_idx")
      .on(t.nextAttemptAt)
      .where(sql`${t.status} in ('queued','sending')`),
  ],
);

// Monthly per-channel send tally for pass-through billing. First
// usage-metering surface in the codebase — Stripe usage reporting is a
// later phase; we record now. Non-PII aggregate counts only.
export const messageUsage = pgTable(
  "message_usage",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organisationId: uuid("organisation_id")
      .notNull()
      .references(() => organisations.id, { onDelete: "cascade" }),
    // 'yyyy-mm' billing period (UTC).
    period: text("period").notNull(),
    // 'email' | 'sms' | 'whatsapp'
    channel: text("channel").notNull(),
    count: integer("count").notNull().default(0),
    estCostPence: integer("est_cost_pence").notNull().default(0),
    // High-water mark of pence already reported to the Stripe usage meter
    // (transactional billing). The meter-sync cron reports est_cost_pence -
    // reported_pence then advances this. See lib/billing/meter-sync.ts (PR-3).
    reportedPence: integer("reported_pence").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("message_usage_org_period_channel_unique").on(
      t.organisationId,
      t.period,
      t.channel,
    ),
    index("message_usage_org_idx").on(t.organisationId),
  ],
);

// =============================================================================
// Billing (platform-account subscriptions + prepaid messaging credit)
// =============================================================================
//
// The OTHER side of Stripe from deposits. Deposits use Connect (venue =
// merchant). These tables are the platform relationship: Tablekit charges
// the venue its £29/£74 subscription + credit top-ups. organisation_id is
// the natural top-level key (NOT denormalised from a parent), so there's
// no enforce_*_org_id trigger — the webhook/adminDb writes it directly.
// All writes are adminDb-only; RLS grants members SELECT on their own org.
// See docs/specs/stripe-billing.md.

export const billingSubscriptions = pgTable(
  "billing_subscriptions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organisationId: uuid("organisation_id")
      .notNull()
      .unique()
      .references(() => organisations.id, { onDelete: "cascade" }),
    stripeSubscriptionId: text("stripe_subscription_id").notNull().unique(),
    // Raw Stripe subscription status (active|trialing|past_due|canceled|...).
    status: text("status").notNull(),
    // Plan this subscription's flat price maps to ('core'|'plus'); CHECK in migration.
    plan: text("plan").notNull(),
    currentPeriodEnd: timestamp("current_period_end", { withTimezone: true }),
    cancelAtPeriodEnd: boolean("cancel_at_period_end").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  // unique() on the two id columns above already creates the indexes.
  () => [],
);

// Append-only credit ledger. The running balance lives denormalised on
// organisations.credit_balance_pence, bumped in the same tx as each entry.
// (reason, ref) is unique so a top-up session / campaign reservation /
// refund applies exactly once (idempotency for webhook + worker retries).
export const billingCreditLedger = pgTable(
  "billing_credit_ledger",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organisationId: uuid("organisation_id")
      .notNull()
      .references(() => organisations.id, { onDelete: "cascade" }),
    // Signed: +top-up / +refund, −reservation. Constrained by reason in migration.
    deltaPence: integer("delta_pence").notNull(),
    // 'topup' | 'campaign_reserve' | 'campaign_refund' | 'adjustment'; CHECK in migration.
    reason: text("reason").notNull(),
    // Idempotency handle: Stripe session/pi id (topup), or campaign id
    // (reserve/refund). NULL only for manual 'adjustment' entries.
    ref: text("ref"),
    balanceAfter: integer("balance_after").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("billing_credit_ledger_reason_ref_unique").on(t.reason, t.ref),
    index("billing_credit_ledger_org_idx").on(t.organisationId, t.createdAt),
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
    // Set by the scrub job (lib/dsar/scrub.ts) once the row's PII has
    // actually been nulled. Distinct from `resolved_at` (operator's
    // click) so the sweeper can find work via
    // `kind='erase' AND status='completed' AND scrubbed_at IS NULL`.
    scrubbedAt: timestamp("scrubbed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("dsar_requests_org_idx").on(t.organisationId),
    // Active-queue working set — what the operator inbox needs.
    index("dsar_requests_active_idx")
      .on(t.organisationId, t.dueAt)
      .where(sql`${t.status} in ('pending','in_progress')`),
    // Scrub queue — completed erase requests still awaiting the
    // background scrub. Tiny working set; partial index keeps it cheap.
    index("dsar_requests_scrub_queue_idx")
      .on(t.resolvedAt)
      .where(sql`${t.kind} = 'erase' AND ${t.status} = 'completed' AND ${t.scrubbedAt} is null`),
  ],
);

// =============================================================================
// Import jobs
// =============================================================================
//
// One row per CSV upload, regardless of source format. The lifecycle is
// linear:
//
//   queued        — file uploaded, parsing not yet started
//   parsing       — header detection + row validation in progress
//   preview_ready — operator can see 10-row preview + confirm mapping
//   importing     — background runner is writing guest rows
//   completed     — done (row_count_imported / _rejected populated)
//   failed        — fatal error; `error` column carries a short reason
//
// Source values mirror those written into `guests.imported_from` so a
// future query can answer "which OpenTable migration did this guest
// come from?" by joining on import_job_id (added in a later migration
// once the runner needs it).
//
// Writes flow through adminDb() — no INSERT/UPDATE/DELETE policy for
// the authenticated role. Members read their own org's jobs.

export const importJobs = pgTable(
  "import_jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organisationId: uuid("organisation_id")
      .notNull()
      .references(() => organisations.id, { onDelete: "cascade" }),
    // Operator who kicked the job off. Set null on user delete so the
    // historical record survives leavers (matches dsar_requests pattern).
    actorUserId: uuid("actor_user_id").references(() => users.id, { onDelete: "set null" }),
    // 'opentable' | 'resdiary' | 'sevenrooms' | 'generic-csv'.
    source: text("source").notNull(),
    // 'queued' | 'parsing' | 'preview_ready' | 'importing' | 'completed' | 'failed'.
    status: text("status").notNull().default("queued"),
    // Original upload filename — display only. Not a stable identifier.
    filename: text("filename").notNull(),
    // Total parsed rows (excluding header). Null until the parse phase
    // completes. Operator-visible counter for the progress UI.
    rowCountTotal: integer("row_count_total"),
    // Rows successfully written to `guests`. Bumped transactionally as
    // the runner advances so a crash mid-import leaves an honest count.
    rowCountImported: integer("row_count_imported").notNull().default(0),
    // Rows skipped — failed validation, missing required fields, or
    // dedupe-collided with an existing in-org guest. The rejected CSV
    // download is built from this set.
    rowCountRejected: integer("row_count_rejected").notNull().default(0),
    // Operator-confirmed mapping from CSV header → guest field. Shape
    // is `{ first_name: "First Name", email: "Email Address", ... }`.
    // Empty until the preview step records the operator's choice.
    columnMap: jsonb("column_map")
      .notNull()
      .default(sql`'{}'::jsonb`),
    // Short failure reason for operator display. Never plaintext PII —
    // sanitised at the boundary before persisting.
    error: text("error"),
    // DEPRECATED — was reserved for a Supabase-Storage-hosted CSV
    // path with a signed URL. The shipped path is `rejectedRowsCipher`
    // below, served on-demand from /api/imports/[jobId]/rejected.csv.
    // Kept (always NULL) until a follow-up migration drops the column
    // — forward-only-migrations policy says deprecate-then-drop across
    // two releases.
    rejectedRowsUrl: text("rejected_rows_url"),
    // Encrypted CSV of rows that failed validation or dedupe. Built
    // by the runner on completion when pipeline.rejected is non-empty;
    // streamed back by /api/imports/[jobId]/rejected.csv on demand.
    // Same envelope-encryption posture as sourceCsvCipher — the rows
    // contain operator-uploaded plaintext PII (guest email/phone/
    // name) and need column-level encryption per gdpr.md §Encryption.
    rejectedRowsCipher: text("rejected_rows_cipher"),
    // Operator-uploaded CSV — envelope-encrypted under the org's DEK
    // before insert (see lib/security/crypto.ts:encryptPii). The CSV
    // contains plaintext guest email/name/phone, so column-level
    // encryption is required by gdpr.md §Encryption — Supabase TDE
    // alone is the at-rest layer, not the column-level guarantee the
    // playbook demands. Nulled by the runner once the import
    // completes successfully so the row doesn't carry PII forever.
    sourceCsvCipher: text("source_csv_cipher"),
    // Pre-encrypt byte length — used by the upload action to enforce
    // a 50MB cap (DB CHECK below) and by the dashboard for display.
    // Set once at upload time; never updated.
    sourceSizeBytes: integer("source_size_bytes"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Operator dashboard list — newest first per org.
    index("import_jobs_org_created_idx").on(t.organisationId, t.createdAt.desc()),
    // Cron picker only — find the next batch of work platform-wide
    // without scanning the table. Deliberately org-agnostic; the
    // dashboard's per-org "active jobs" view should hit
    // `import_jobs_org_created_idx` and filter on status in the query.
    index("import_jobs_active_idx")
      .on(t.createdAt)
      .where(sql`${t.status} in ('queued','parsing','importing')`),
  ],
);

// =============================================================================
// AI enquiries (Plus tier)
// =============================================================================
//
// One row per inbound email at `<venue-slug>@enquiries.tablekit.uk`.
// Lifecycle: received → parsing → draft_ready → replied | failed
// (`discarded` is the operator's "this isn't an enquiry" escape hatch).
//
// All guest-facing fields are envelope-encrypted under the org's
// DEK — the email body is fully untrusted input + carries the
// guest's name/email/phone/preferences in free-form text. The
// parser's structured JSON output is also encrypted because it
// can include the extracted guest name. `suggested_slots` is the
// only plaintext jsonb — slot times + service ids only, no PII.
//
// Writes flow through adminDb (cron + webhook). RLS restricts
// SELECT to org members. Trigger denormalises organisation_id
// from the parent venue (template: enforce_areas_org_id, mig 0001).

export const enquiries = pgTable(
  "enquiries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organisationId: uuid("organisation_id")
      .notNull()
      .references(() => organisations.id, { onDelete: "cascade" }),
    venueId: uuid("venue_id")
      .notNull()
      .references(() => venues.id, { onDelete: "cascade" }),
    // HMAC-SHA256 of the lowercased+trimmed sender email — same
    // scheme as guests.email_hash. Lets us join enquiries to a
    // matching guest record without decrypting either ciphertext.
    fromEmailHash: text("from_email_hash").notNull(),
    fromEmailCipher: text("from_email_cipher").notNull(),
    subjectCipher: text("subject_cipher").notNull(),
    bodyCipher: text("body_cipher").notNull(),
    // JSON-stringified ParsedEnquiry then envelope-encrypted —
    // includes the extracted guest name + preferences which are
    // PII. Null until the runner parses successfully.
    parsedCipher: text("parsed_cipher"),
    // Top-3 slot times the runner suggested. Plaintext jsonb —
    // shape is `[{ serviceId, serviceName, startAt, endAt, wallStart }]`.
    // No PII; safe to query for analytics later.
    suggestedSlots: jsonb("suggested_slots"),
    // Operator-editable draft reply text, envelope-encrypted (it
    // greets the guest by name extracted by the parser). Null until
    // the runner generates the draft. The reply text is template-
    // based, NOT free-text from the LLM — see lib/enquiries/draft.ts.
    draftReplyCipher: text("draft_reply_cipher"),
    // 'received' | 'parsing' | 'draft_ready' | 'replied' | 'failed' | 'discarded'.
    // CHECK constrained at the DB level (migration).
    status: text("status").notNull().default("received"),
    // Bumped each time the runner attempts a parse. Caps at 3 to
    // avoid spending money on a permanently-broken email.
    parseAttempts: integer("parse_attempts").notNull().default(0),
    // Sanitised error string from the most recent failed parse.
    // Never plaintext PII — passes through a scrubber on persist
    // (template: lib/import/runner/sanitise-error.ts).
    error: text("error"),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
    repliedAt: timestamp("replied_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Operator inbox — newest first per org.
    index("enquiries_org_received_idx").on(t.organisationId, t.receivedAt.desc()),
    // Runner picker — tiny working set of unparsed enquiries.
    // Org-agnostic by design; the cron sweeps the platform.
    index("enquiries_received_picker_idx")
      .on(t.receivedAt)
      .where(sql`${t.status} = 'received'`),
    // Guest-match join. PR2's webhook (and PR3's runner) want to
    // resolve "do we already know this email under this org?" by
    // joining to `guests.email_hash` — covering both columns avoids
    // a sequential scan once the table grows.
    index("enquiries_org_email_hash_idx").on(t.organisationId, t.fromEmailHash),
  ],
);

// =============================================================================
// Per-venue verified sending domain (AI enquiry handler)
// =============================================================================
//
// Operators can add a domain they own (e.g. `mail.jane-cafe.co.uk`)
// and prove ownership via DKIM/SPF DNS records; once verified, enquiry
// replies go out from that domain instead of the platform default —
// dropping the "via tablekit.uk" suffix Gmail otherwise appends.
//
// Source of truth for verification status is Resend's Domains API.
// We mirror enough into this row to render status server-side without
// a Resend round-trip on every settings page load (just the values
// that change rarely: domain, resend_domain_id, status, dns_records).
//
// Domain text is operator-chosen + publishable (it goes in `From:`
// headers), not PII. DNS records (DKIM public key, SPF, DMARC) are
// also public by design — no encryption.
//
// RLS: SELECT for org members where the venue is in their visible set
// (matches the `venues` policy via user_visible_venue_ids()). No
// write policies — all mutations flow through adminDb in server
// actions after explicit role gating. Matches venue_oauth_connections.
export const venueSendingDomains = pgTable(
  "venue_sending_domains",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organisationId: uuid("organisation_id")
      .notNull()
      .references(() => organisations.id, { onDelete: "cascade" }),
    venueId: uuid("venue_id")
      .notNull()
      .references(() => venues.id, { onDelete: "cascade" }),
    domain: text("domain").notNull(),
    // Resend's internal id for this domain. Used for subsequent
    // verify / get / delete API calls.
    resendDomainId: text("resend_domain_id").notNull(),
    // Mirrors Resend's status field verbatim: 'not_started' | 'pending'
    // | 'verified' | 'failure' | 'temporary_failure'. CHECK constrained
    // in the migration.
    status: text("status").notNull().default("pending"),
    // Plaintext jsonb of the DNS records Resend issued at create time.
    // Shape: [{ record, name, type, value, ttl?, priority?, status? }].
    // Reads-only — operators paste these into their DNS host. Stable
    // for the lifetime of the row (rotating DKIM keys would require
    // remove + re-add).
    dnsRecords: jsonb("dns_records")
      .notNull()
      .default(sql`'[]'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    // Set on the first successful verification check. Nulled-back if a
    // domain falls into 'failure' so the UI can show "was verified,
    // re-verify".
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    // Updated every time we poll Resend (manual "verify now" or future
    // cron sweep). Surfaces "we last checked 3 minutes ago" in the UI.
    lastCheckedAt: timestamp("last_checked_at", { withTimezone: true }),
  },
  (t) => [
    // One row per venue. Operator removes + re-adds to switch domain;
    // we don't keep history (the previous row's resend_domain_id was
    // deleted in Resend at remove time anyway).
    uniqueIndex("venue_sending_domains_venue_unique").on(t.venueId),
    index("venue_sending_domains_org_idx").on(t.organisationId),
  ],
);

// =============================================================================
// Inbound webhook event log (idempotency)
// =============================================================================
//
// Generic dedup surface for any inbound webhook that emits a unique
// event id. PR2 of the AI enquiry feature uses it to short-circuit
// Resend's at-least-once delivery (`svix-id` is unique per event;
// retries reuse it). Future inbound integrations (calendar, payment
// disputes) reuse the same table.
//
// This is platform infrastructure — no organisation_id, no PII.
// RLS denies all access for `authenticated` and `anon`; the cron /
// webhook routes use `adminDb`. Matches the platform_audit_log
// pattern from migration 0020.

export const inboundWebhookEvents = pgTable("inbound_webhook_events", {
  // The provider's unique event id (e.g. Svix's `svix-id`). Primary
  // key — INSERT ON CONFLICT DO NOTHING is the dedup primitive.
  eventId: text("event_id").primaryKey(),
  // Provider name for triage / cleanup partitioning. Free-text;
  // current value is just 'resend-inbound'.
  provider: text("provider").notNull(),
  receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
});

// =============================================================================
// API keys (Plus tier)
// =============================================================================
//
// Bearer tokens for the public REST API at api.tablekit.uk/v1.
// Format: `sk_live_<base64url(24 random bytes)>` — 32 chars after the
// prefix, ~192 bits of entropy. The plaintext key is shown to the
// operator exactly once at issuance and never persisted; we store
// SHA-256(plaintext) as the unique lookup column. The `prefix` column
// holds the first 12 chars (`sk_live_xxxx`) for display in the
// dashboard so operators can identify which key is which without
// exposing the secret.
//
// RLS: members can SELECT their org's keys (so the dashboard list
// works under withUser). All writes (issue, revoke) flow via
// adminDb after requireRole("owner") + requirePlan(orgId, "plus").
//
// Lookup at request time: hash the incoming Bearer token, SELECT by
// hash WHERE revoked_at IS NULL. The hash column has a unique index
// so the lookup is one row at most. last_used_at is updated
// best-effort (debounced ≥1h) — bumping it on every request would
// make every API key a hot row.

export const apiKeys = pgTable(
  "api_keys",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organisationId: uuid("organisation_id")
      .notNull()
      .references(() => organisations.id, { onDelete: "cascade" }),
    // First 12 chars of the plaintext key (`sk_live_xxxx`) — safe to
    // display, used for "which key is this?" in the dashboard list.
    prefix: text("prefix").notNull(),
    // SHA-256 of the full plaintext key, hex-encoded (64 chars).
    // Lookup column. Unique index ensures O(log n) auth.
    hash: text("hash").notNull(),
    // Operator-given label. Free text up to 80 chars (CHECK in mig).
    label: text("label").notNull(),
    // Audit trail — who issued this key. SET NULL on user delete so
    // a deleted operator's keys still show with a "deleted user"
    // label rather than orphaning the row.
    createdByUserId: uuid("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    // Set on first authenticated request and bumped best-effort
    // (debounced ≥1h). Null means the key has never been used.
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    // Set when revoked. Auth lookups filter `revoked_at IS NULL` so
    // a revoked key is immediately rejected. We don't hard-delete —
    // keeping the row preserves audit trail (who issued, when, when
    // revoked).
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Auth lookup hot path. Unique guarantees no two keys can collide
    // (the entropy makes this vanishingly unlikely, but enforce it).
    uniqueIndex("api_keys_hash_unique").on(t.hash),
    // Dashboard list — newest first per org.
    index("api_keys_org_created_idx").on(t.organisationId, t.createdAt.desc()),
  ],
);

// =============================================================================
// API write-endpoint idempotency keys
// =============================================================================
//
// Stripe-style Idempotency-Key support for POST/PATCH on /v1/*. The
// claim row is INSERTed with response_status=null first; the handler
// then runs and UPDATEs the row with the final status + body. A
// concurrent retry hitting the same (api_key_id, key) sees the
// claim row and either returns the cached response (status non-null)
// or 409 in_flight (status null — original handler still running).
//
// Bucketed per api_key_id so two organisations using the same
// idempotency-key value (or two keys in the same org) cannot collide.
//
// RLS: deny all from authenticated/anon — this is API infrastructure.
// All access via adminDb. Cleanup (24h expiry) lands in a future
// cron — for now rows accumulate but are bounded by API key revocation
// (FK cascade).

export const apiIdempotencyKeys = pgTable(
  "api_idempotency_keys",
  {
    apiKeyId: uuid("api_key_id")
      .notNull()
      .references(() => apiKeys.id, { onDelete: "cascade" }),
    // Operator-supplied Idempotency-Key header value. Capped at 200
    // chars by CHECK in the migration — Stripe also caps at 255.
    key: text("key").notNull(),
    // Final response cached after the original handler completed.
    // Both null while the handler is still running (the claim state).
    responseStatus: integer("response_status"),
    responseBody: jsonb("response_body"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.apiKeyId, t.key] })],
);

// =============================================================================
// Webhook subscriptions (Plus tier)
// =============================================================================
//
// Per-organisation outbound webhook registrations. Plus customers
// register an HTTPS endpoint + select which booking events they
// want pushed to it. Each subscription has a shared secret used
// to HMAC-SHA256 sign delivery bodies — recipients verify via the
// X-TableKit-Signature header.
//
// Secret storage: envelope-encrypted under the org's DEK. The
// plaintext is shown to the operator exactly once at creation
// (same pattern as api_keys' plaintext token). Lost? Rotate the
// subscription.
//
// RLS: members SELECT their org's subscriptions so the dashboard
// list works under withUser. Writes (create, revoke) flow via
// adminDb after requireRole("owner") + requirePlan(orgId, "plus")
// at the action layer.
//
// Delivery + retry tables land in PR6b — the splittable seam is
// "registration vs sending". This PR only ships registration.

export const webhookSubscriptions = pgTable(
  "webhook_subscriptions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organisationId: uuid("organisation_id")
      .notNull()
      .references(() => organisations.id, { onDelete: "cascade" }),
    // Operator-supplied HTTPS endpoint. Format check enforced both
    // in Zod at the action layer + as a CHECK constraint in the
    // migration.
    url: text("url").notNull(),
    // Operator-given label, e.g. "Mailchimp sync". 1–80 chars
    // (CHECK in mig).
    label: text("label").notNull(),
    // Envelope-encrypted shared secret. Used to HMAC the delivery
    // body. PR6b's `lib/webhooks/sign.ts` will decrypt + sign.
    secretCipher: text("secret_cipher").notNull(),
    // Subscribed event names. Currently a free-text array; PR6b
    // bounds it via Zod to the documented set
    // (booking.created, booking.updated, booking.cancelled,
    // booking.seated, booking.no_show).
    events: text("events").array().notNull(),
    // Toggleable. False subscriptions are skipped at dispatch time
    // without the operator having to revoke + re-create.
    active: boolean("active").notNull().default(true),
    // Audit trail for who registered this subscription. SET NULL on
    // user delete so a removed operator's subscriptions still show
    // their history.
    createdByUserId: uuid("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    // Set when revoked. Subscriptions stay visible in the dashboard
    // (with a Revoked badge) for audit trail; dispatcher filters
    // them out via revokedAt IS NULL.
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Dashboard list — newest first per org.
    index("webhook_subscriptions_org_created_idx").on(t.organisationId, t.createdAt.desc()),
  ],
);

// =============================================================================
// Webhook deliveries (Plus tier)
// =============================================================================
//
// One row per attempt to deliver an event to a subscription. Created
// in `pending` by the dispatcher; the cron drains pending +
// ready-for-retry rows, POSTs the signed body, and updates the row
// to `succeeded` or `failed`. Failures with attempts < 5 reschedule
// via next_attempt_at; the cron picks them up next tick.
//
// Payload: stored as plaintext jsonb. Booking events carry ids +
// timestamps + status — no PII columns. If a future event surface
// includes guest contact details, encrypt at the column level.
//
// RLS: deny-all from authenticated/anon. All access via adminDb.
// PR6c adds an org-scoped read policy + dashboard log view + replay.
// Until then, the surface is admin-only.

export const webhookDeliveries = pgTable(
  "webhook_deliveries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    subscriptionId: uuid("subscription_id")
      .notNull()
      .references(() => webhookSubscriptions.id, { onDelete: "cascade" }),
    // Denormalised so the cron + retention sweep don't need to join
    // back to subscriptions (which the FK cascade handles for us).
    organisationId: uuid("organisation_id")
      .notNull()
      .references(() => organisations.id, { onDelete: "cascade" }),
    // Event name (e.g. "booking.created"). Free text for forward
    // compat; the dispatcher only enqueues subscribed events from
    // WEBHOOK_EVENTS so storage gets a bounded set in practice.
    eventType: text("event_type").notNull(),
    // Stable identifier for the event instance. Same value across
    // attempts (so a subscriber can dedupe at their end if they
    // implement idempotency). Currently `${eventType}:${bookingId}:${createdAt}`.
    eventId: text("event_id").notNull(),
    // Plaintext jsonb. Booking events are non-PII at the column
    // level; future events with PII fields must encrypt before this.
    payload: jsonb("payload").notNull(),
    // 'pending' | 'succeeded' | 'failed'. CHECK in mig.
    status: text("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    // When the cron should next attempt this delivery. Null on
    // succeeded/permanent-failed rows. The cron picks rows where
    // status='pending' AND next_attempt_at <= now().
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).defaultNow(),
    // Cached HTTP status of the last attempt. Useful for dashboard
    // triage — operators see "23 deliveries failing 502 to https://X".
    lastStatus: integer("last_status"),
    // Sanitised error string from the last attempt (network error
    // class or HTTP status). Bounded at 500 chars by CHECK.
    lastError: text("last_error"),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Cron picker: pending rows due to fire. Partial index keeps it
    // small — succeeded/failed rows don't bloat it.
    index("webhook_deliveries_due_idx")
      .on(t.nextAttemptAt)
      .where(sql`${t.status} = 'pending'`),
    // Dashboard log (PR6c) — newest first per org.
    index("webhook_deliveries_org_created_idx").on(t.organisationId, t.createdAt.desc()),
    // Per-subscription history.
    index("webhook_deliveries_subscription_idx").on(t.subscriptionId),
  ],
);

// =============================================================================
// API request log (Plus tier — operational telemetry)
// =============================================================================
//
// One row per authenticated request to /api/v1/*. Captures the
// minimum fields the spec promises: method, path, organisation,
// status, latency. NEVER request or response bodies — operator-
// typed `notes` and guest PII are reachable through the API
// surface and we don't want them in this table.
//
// Retention: 90 days, swept by /api/cron/api-request-log-retention.
//
// RLS: deny-all from authenticated/anon (admin-only). PR7's scope
// is the data + retention; an operator-facing "API activity"
// dashboard view could lift to member-read later.
//
// FK posture:
//   • organisation_id: CASCADE — log dies with the org.
//   • api_key_id: SET NULL — preserve the row when a key is
//     revoked + deleted, so the org can audit "what did key X do
//     in its lifetime" via the row's created_at + path.

export const apiRequestLog = pgTable(
  "api_request_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organisationId: uuid("organisation_id")
      .notNull()
      .references(() => organisations.id, { onDelete: "cascade" }),
    apiKeyId: uuid("api_key_id").references(() => apiKeys.id, { onDelete: "set null" }),
    method: text("method").notNull(),
    // URL path without query string. Bounded by CHECK to prevent a
    // pathological request from inflating storage.
    path: text("path").notNull(),
    status: integer("status").notNull(),
    latencyMs: integer("latency_ms").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Org-scoped chronological reads (future operator UI).
    index("api_request_log_org_created_idx").on(t.organisationId, t.createdAt.desc()),
    // Retention sweep — by raw created_at across orgs.
    index("api_request_log_created_at_idx").on(t.createdAt),
  ],
);

// =============================================================================
// POS integrations (Plus tier) — order history + spend on guest profiles
// =============================================================================
//
// Inbound-only: we ingest completed orders from a venue's till (Square,
// Lightspeed K-Series, or a generic signed-webhook/CSV path) and attach
// spend to the matching guest. Read-only — we never write back to the POS,
// and we never touch card data (PCI SAQ-A: the ingest layer drops any
// card-number-shaped field before persistence). See docs/specs/pos-integrations.md.
//
// All four tables carry a denormalised organisation_id populated by a
// BEFORE INSERT/UPDATE trigger from the parent (venue / connection / guest),
// so a crafted payload can't plant a row under another org. RLS gives
// members SELECT on their org's rows; there is NO authenticated write
// policy — every write flows through adminDb() from a signature-verified
// webhook handler or cron. Mirrors the venue_photos posture.

export const posProvider = pgEnum("pos_provider", ["square", "lightspeed_k", "generic"]);

// One connection per (venue, provider). Holds the OAuth grant + webhook
// secret, all envelope-encrypted via crypto.encryptPii — treat the cipher
// columns as credentials: never log, never surface in an error message.
export const posConnections = pgTable(
  "pos_connections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organisationId: uuid("organisation_id")
      .notNull()
      .references(() => organisations.id, { onDelete: "cascade" }),
    venueId: uuid("venue_id")
      .notNull()
      .references(() => venues.id, { onDelete: "cascade" }),
    provider: posProvider("provider").notNull(),
    // Square merchant/location id, Lightspeed business id. Not secret.
    externalAccountId: text("external_account_id"),
    accessTokenCipher: text("access_token_cipher"),
    refreshTokenCipher: text("refresh_token_cipher"),
    tokenExpiresAt: timestamp("token_expires_at", { withTimezone: true }),
    // For the generic inbound HMAC path + Lightspeed verification.
    webhookSecretCipher: text("webhook_secret_cipher"),
    // Art. 9 opt-in gate. Itemised orders can reveal special-category
    // data (alcohol volume, dietary/health patterns), so line-item
    // ingest is OFF until the venue explicitly opts in and confirms an
    // Art. 9(2) basis. See docs/playbooks/gdpr.md §Special-category.
    lineItemsEnabled: boolean("line_items_enabled").notNull().default(false),
    art9BasisConfirmedAt: timestamp("art9_basis_confirmed_at", { withTimezone: true }),
    // 'active' | 'paused' | 'revoked' | 'error' — constrained in the migration.
    status: text("status").notNull().default("active"),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
    lastError: text("last_error"),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("pos_connections_venue_provider_unique").on(t.venueId, t.provider),
    index("pos_connections_org_idx").on(t.organisationId),
  ],
);

// Idempotency ledger for every inbound POS webhook. Dedup primitive is
// INSERT ON CONFLICT (provider, external_event_id) DO NOTHING — a replay
// is a no-op. Mirrors stripe_events / inbound_webhook_events.
export const posWebhookEvents = pgTable(
  "pos_webhook_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organisationId: uuid("organisation_id")
      .notNull()
      .references(() => organisations.id, { onDelete: "cascade" }),
    connectionId: uuid("connection_id")
      .notNull()
      .references(() => posConnections.id, { onDelete: "cascade" }),
    provider: posProvider("provider").notNull(),
    // The POS's own event id.
    externalEventId: text("external_event_id").notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
    processedAt: timestamp("processed_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("pos_webhook_events_provider_event_unique").on(t.provider, t.externalEventId),
    index("pos_webhook_events_org_idx").on(t.organisationId),
    index("pos_webhook_events_connection_idx").on(t.connectionId),
  ],
);

// Normalised completed orders — one row per till order/check. Money columns
// are plain integer pence: not PII on their own, so they stay queryable for
// the "top guests by spend" sort. The sensitive thing is the LINKAGE to a
// named guest, protected by RLS + the encrypted guest row. payment_method_label
// is a display label only ('Visa ••4242', 'Cash') — never a card number.
export const posOrders = pgTable(
  "pos_orders",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organisationId: uuid("organisation_id")
      .notNull()
      .references(() => organisations.id, { onDelete: "cascade" }),
    venueId: uuid("venue_id")
      .notNull()
      .references(() => venues.id, { onDelete: "cascade" }),
    connectionId: uuid("connection_id")
      .notNull()
      .references(() => posConnections.id, { onDelete: "cascade" }),
    provider: posProvider("provider").notNull(),
    // The till's order/check id — dedupe key within a connection.
    externalOrderId: text("external_order_id").notNull(),
    // Nullable: matched to a guest when possible, else an unmatched order
    // (still counted in venue revenue). De-linked (set null) on DSAR erasure.
    guestId: uuid("guest_id").references(() => guests.id, { onDelete: "set null" }),
    bookingId: uuid("booking_id").references(() => bookings.id, { onDelete: "set null" }),
    totalMinor: integer("total_minor").notNull(),
    tipMinor: integer("tip_minor").notNull().default(0),
    taxMinor: integer("tax_minor"),
    currency: char("currency", { length: 3 }).notNull().default("GBP"),
    coverCount: integer("cover_count"),
    paymentMethodLabel: text("payment_method_label"),
    // Envelope-encrypted JSON, optional. Only written when the connection
    // has lineItemsEnabled (Art. 9 opt-in). Nulled on DSAR erasure.
    lineItemsCipher: text("line_items_cipher"),
    closedAt: timestamp("closed_at", { withTimezone: true }).notNull(),
    // 'email_hash' | 'phone_hash' | 'booking' | 'manual' | null
    matchMethod: text("match_method"),
    // Opaque pointer for support/debug — no PII.
    rawProviderRef: text("raw_provider_ref"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("pos_orders_connection_external_unique").on(t.connectionId, t.externalOrderId),
    index("pos_orders_org_venue_closed_idx").on(t.organisationId, t.venueId, t.closedAt),
    index("pos_orders_guest_idx")
      .on(t.guestId)
      .where(sql`${t.guestId} is not null`),
  ],
);

// Denormalised per-guest spend rollup (read-hot; recomputed on order upsert).
// A cache — always rebuildable from pos_orders, never the source of truth.
// guest_id is the PK (one summary per guest); organisation_id denormalised
// for RLS + the "top guests by spend" index.
export const guestSpendSummary = pgTable(
  "guest_spend_summary",
  {
    guestId: uuid("guest_id")
      .primaryKey()
      .references(() => guests.id, { onDelete: "cascade" }),
    organisationId: uuid("organisation_id")
      .notNull()
      .references(() => organisations.id, { onDelete: "cascade" }),
    orderCount: integer("order_count").notNull().default(0),
    totalSpendMinor: bigint("total_spend_minor", { mode: "number" }).notNull().default(0),
    avgSpendMinor: integer("avg_spend_minor").notNull().default(0),
    lastOrderAt: timestamp("last_order_at", { withTimezone: true }),
    firstOrderAt: timestamp("first_order_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("guest_spend_summary_org_total_idx").on(t.organisationId, t.totalSpendMinor.desc()),
  ],
);
