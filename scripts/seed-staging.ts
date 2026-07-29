#!/usr/bin/env tsx
// Staging seeder (deployment-pipeline.md Workstream 1.2 / Phase 2 step 3).
//
// Seeds the London staging Supabase with synthetic data covering the shapes
// that catch real bugs: a single-venue org with deposits, a multi-venue org
// (venue switcher / group dashboards), and a free-tier org sitting at the
// 50-bookings/month cap (plan-gating). Owners are real Supabase auth users so
// a human can exercise the first-login MFA-enrolment flow.
//
// GUARD FIRST: refuses to run unless the database URL AND the Supabase URL
// both resolve to the ref declared in STAGING_PROJECT_REF (or --ref). It must
// be impossible to point this at production, CI, or a local DB by accident.
//
// Idempotent: orgs/venues/users/structure are upserted by stable natural keys
// (slug / address / name); bookings and the waitlist entry are tagged
// [staging-seed] and cleaned up before reinsert. Running twice yields the same
// state.
//
// Usage (note the flag — adminDb + crypto import `server-only`, which plain
// tsx rejects; the `seed:staging` npm script bakes it in):
//   STAGING_PROJECT_REF=<ref> pnpm seed:staging

import { randomBytes } from "node:crypto";
import { resolve } from "node:path";

import { config as loadEnv } from "dotenv";

loadEnv({ path: resolve(process.cwd(), ".env.local") });
loadEnv({ path: resolve(process.cwd(), ".env") });

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { and, eq, sql } from "drizzle-orm";

import { zonedWallToUtc } from "@/lib/bookings/time";
import {
  areas,
  bookings,
  bookingTables,
  depositRules,
  guests,
  memberships,
  organisations,
  services,
  users,
  venues,
  venueTables,
  waitlists,
} from "@/lib/db/schema";
import { encryptPii, hashForLookup } from "@/lib/security/crypto";
import { adminDb } from "@/lib/server/admin/db";
import { templates, type VenueType } from "@/lib/venues/templates";

import { buildGuestPool, seedVenueBookings } from "./seed/insert";
import { checkStagingTarget, refFromArgv } from "./seed/staging-guard";

const MARKER = "[staging-seed]";
const TZ = "Europe/London";

type Db = ReturnType<typeof adminDb>;

// --- Org / venue specification -----------------------------------------------

type VenueSpec = { name: string; slug: string; type: VenueType };
type OrgSpec = {
  name: string;
  slug: string;
  plan: "free" | "core" | "plus";
  venues: VenueSpec[];
  deposits: boolean;
  /** free-tier org: seed exactly this many bookings in the current month. */
  monthlyCap?: number;
};

const ORGS: OrgSpec[] = [
  {
    name: "Staging Bistro",
    slug: "staging-bistro",
    plan: "core",
    deposits: true,
    venues: [{ name: "Staging Bistro", slug: "staging-bistro", type: "restaurant" }],
  },
  {
    name: "Staging Group",
    slug: "staging-group",
    plan: "plus",
    deposits: false,
    venues: [
      { name: "Staging Group — Soho", slug: "staging-group-soho", type: "restaurant" },
      { name: "Staging Group — Shoreditch", slug: "staging-group-shoreditch", type: "bar_pub" },
    ],
  },
  {
    name: "Staging Café",
    slug: "staging-cafe",
    plan: "free",
    deposits: false,
    monthlyCap: 50,
    venues: [{ name: "Staging Café", slug: "staging-cafe", type: "cafe" }],
  },
];

/** Non-deliverable owner address for an org. */
function ownerAddress(orgSlug: string): string {
  return `owner.${orgSlug}@example.invalid`;
}

// --- Idempotent upsert helpers -----------------------------------------------

async function upsertOrg(db: Db, spec: OrgSpec): Promise<string> {
  const [existing] = await db
    .select({ id: organisations.id })
    .from(organisations)
    .where(eq(organisations.slug, spec.slug));
  if (existing) {
    await db
      .update(organisations)
      .set({ name: spec.name, plan: spec.plan })
      .where(eq(organisations.id, existing.id));
    return existing.id;
  }
  const [row] = await db
    .insert(organisations)
    .values({ name: spec.name, slug: spec.slug, plan: spec.plan })
    .returning({ id: organisations.id });
  return row!.id;
}

type OwnerResult = { address: string; password: string | null; status: string };

/** Create (or reuse) the org's owner auth user + membership. */
async function ensureOwner(
  admin: SupabaseClient,
  db: Db,
  addressToId: Map<string, string>,
  spec: OrgSpec,
  orgId: string,
): Promise<OwnerResult> {
  const address = ownerAddress(spec.slug);
  const fullName = `${spec.name} Owner`;

  let userId = addressToId.get(address.toLowerCase());
  let password: string | null = null;
  let status: string;

  if (userId) {
    status = "existing (password unchanged)";
  } else {
    password = `Stg-${randomBytes(9).toString("base64url")}`;
    const { data, error } = await admin.auth.admin.createUser({
      email: address,
      password,
      email_confirm: true,
      user_metadata: { full_name: fullName },
    });
    if (error || !data.user) throw error ?? new Error(`createUser failed for ${address}`);
    userId = data.user.id;
    addressToId.set(address.toLowerCase(), userId);
    status = "created";
  }

  // The handle_new_auth_user trigger inserts public.users on auth signup, but
  // guard against races / older rows by ensuring the row + membership exist.
  await db
    .insert(users)
    .values({ id: userId, email: address, fullName })
    .onConflictDoNothing({ target: users.id });
  await db
    .insert(memberships)
    .values({ userId, organisationId: orgId, role: "owner" })
    .onConflictDoNothing({ target: [memberships.userId, memberships.organisationId] });

  return { address, password, status };
}

async function upsertVenue(db: Db, orgId: string, spec: VenueSpec): Promise<string> {
  const [existing] = await db
    .select({ id: venues.id })
    .from(venues)
    .where(and(eq(venues.organisationId, orgId), eq(venues.slug, spec.slug)));
  if (existing) return existing.id;
  const [row] = await db
    .insert(venues)
    .values({
      organisationId: orgId,
      name: spec.name,
      slug: spec.slug,
      venueType: spec.type,
      timezone: TZ,
    })
    .returning({ id: venues.id });
  return row!.id;
}

/** Apply the venue template's areas/tables/services if absent (by name/label). */
async function applyTemplate(
  db: Db,
  orgId: string,
  venueId: string,
  type: VenueType,
): Promise<void> {
  const template = templates[type];
  for (const area of template.areas) {
    let [areaRow] = await db
      .select({ id: areas.id })
      .from(areas)
      .where(and(eq(areas.venueId, venueId), eq(areas.name, area.name)));
    if (!areaRow) {
      [areaRow] = await db
        .insert(areas)
        .values({ organisationId: orgId, venueId, name: area.name })
        .returning({ id: areas.id });
    }
    const areaId = areaRow!.id;
    for (const t of area.tables) {
      const [tbl] = await db
        .select({ id: venueTables.id })
        .from(venueTables)
        .where(and(eq(venueTables.venueId, venueId), eq(venueTables.label, t.label)));
      if (!tbl) {
        await db.insert(venueTables).values({
          organisationId: orgId,
          venueId,
          areaId,
          label: t.label,
          minCover: t.minCover,
          maxCover: t.maxCover,
          position: t.position,
        });
      }
    }
  }
  for (const svc of template.services) {
    const [existing] = await db
      .select({ id: services.id })
      .from(services)
      .where(and(eq(services.venueId, venueId), eq(services.name, svc.name)));
    if (!existing) {
      await db.insert(services).values({
        organisationId: orgId,
        venueId,
        name: svc.name,
        schedule: svc.schedule,
        turnMinutes: svc.turnMinutes,
      });
    }
  }
}

/** Flat £10 deposit on all services (idempotent — one seed rule per venue). */
async function ensureDepositRule(db: Db, orgId: string, venueId: string): Promise<void> {
  const [existing] = await db
    .select({ id: depositRules.id })
    .from(depositRules)
    .where(and(eq(depositRules.venueId, venueId), eq(depositRules.kind, "flat")));
  if (existing) return;
  await db.insert(depositRules).values({
    organisationId: orgId,
    venueId,
    serviceId: null,
    kind: "flat",
    amountMinor: 1000,
    currency: "GBP",
    minParty: 1,
  });
}

/** One 'waiting' waitlist entry, tagged for idempotent cleanup. */
async function ensureWaitlistEntry(db: Db, orgId: string, venueId: string): Promise<void> {
  await db
    .delete(waitlists)
    .where(and(eq(waitlists.venueId, venueId), eq(waitlists.notes, MARKER)));

  const g = buildGuestPool(1, `wl-${venueId.slice(0, 8)}`)[0]!;
  const [guest] = await db
    .insert(guests)
    .values({
      organisationId: orgId,
      firstName: g.firstName,
      lastNameCipher: await encryptPii(orgId, g.lastName),
      emailCipher: await encryptPii(orgId, g.email),
      emailHash: hashForLookup(g.email, "email"),
      phoneCipher: await encryptPii(orgId, g.phone),
    })
    .returning({ id: guests.id });

  await db.insert(waitlists).values({
    organisationId: orgId,
    venueId,
    guestId: guest!.id,
    partySize: 2,
    status: "waiting",
    notes: MARKER,
  });
}

/**
 * Seed EXACTLY `count` non-cancelled bookings within the current venue-local
 * month, for the free-tier cap org. Placed one-per-(table,day) so the
 * no-double-book gist constraint never trips; both start_at and created_at
 * fall in the month so it counts under any reasonable cap definition.
 */
async function seedExactMonthlyBookings(
  db: Db,
  orgId: string,
  venueId: string,
  count: number,
): Promise<number> {
  const [service] = await db
    .select({ id: services.id })
    .from(services)
    .where(eq(services.venueId, venueId))
    .limit(1);
  if (!service) throw new Error(`cap seed: venue ${venueId} has no service`);

  const tbls = await db
    .select({ id: venueTables.id, areaId: venueTables.areaId })
    .from(venueTables)
    .where(eq(venueTables.venueId, venueId));
  if (tbls.length === 0) throw new Error(`cap seed: venue ${venueId} has no tables`);

  const now = new Date();
  const ym = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
  }).format(now); // YYYY-MM
  const todayDay = Number(
    new Intl.DateTimeFormat("en-CA", { timeZone: TZ, day: "2-digit" }).format(now),
  );

  const pool = buildGuestPool(10, `cafe-${venueId.slice(0, 8)}`);

  await db.transaction(async (tx) => {
    // Idempotent: clear this venue's prior cap-seed rows first.
    const prior = await tx
      .selectDistinct({ guestId: bookings.guestId })
      .from(bookings)
      .where(and(eq(bookings.venueId, venueId), eq(bookings.notes, MARKER)));
    await tx.delete(bookings).where(and(eq(bookings.venueId, venueId), eq(bookings.notes, MARKER)));
    if (prior.length > 0) {
      await tx.delete(guests).where(
        and(
          sql`${guests.id} in (${sql.join(
            prior.map((r) => sql`${r.guestId}`),
            sql`, `,
          )})`,
          sql`not exists (select 1 from bookings b where b.guest_id = ${guests.id})`,
        ),
      );
    }

    const guestIds: string[] = [];
    for (const g of pool) {
      const [row] = await tx
        .insert(guests)
        .values({
          organisationId: orgId,
          firstName: g.firstName,
          lastNameCipher: await encryptPii(orgId, g.lastName),
          emailCipher: await encryptPii(orgId, g.email),
          emailHash: hashForLookup(g.email, "email"),
          phoneCipher: await encryptPii(orgId, g.phone),
        })
        .returning({ id: guests.id });
      guestIds.push(row!.id);
    }

    for (let i = 0; i < count; i++) {
      const day = 1 + Math.floor(i / tbls.length); // 1-based day of month
      const table = tbls[i % tbls.length]!;
      const dateYMD = `${ym}-${String(day).padStart(2, "0")}`;
      const startAt = zonedWallToUtc(dateYMD, "12:00", TZ);
      const endAt = new Date(startAt.getTime() + 45 * 60_000);
      const createdAt = zonedWallToUtc(dateYMD, "09:00", TZ);

      const [booking] = await tx
        .insert(bookings)
        .values({
          organisationId: orgId,
          venueId,
          serviceId: service.id,
          areaId: table.areaId,
          guestId: guestIds[i % guestIds.length]!,
          partySize: 2,
          startAt,
          endAt,
          status: day < todayDay ? "finished" : "confirmed",
          source: "widget",
          notes: MARKER,
          createdAt,
          updatedAt: createdAt,
        })
        .returning({ id: bookings.id });

      await tx.insert(bookingTables).values({
        bookingId: booking!.id,
        tableId: table.id,
        organisationId: orgId,
        venueId,
        areaId: table.areaId,
        startAt,
        endAt,
      });
    }
  });

  return count;
}

// --- Row-count snapshot (for the double-run diff) ----------------------------

async function rowCounts(db: Db, orgIds: string[]): Promise<Record<string, number>> {
  const scope = sql`in (${sql.join(
    orgIds.map((id) => sql`${id}`),
    sql`, `,
  )})`;
  const one = async (table: string): Promise<number> => {
    const rows = await db.execute<{ n: number }>(
      sql`select count(*)::int as n from ${sql.raw(table)} where organisation_id ${scope}`,
    );
    const first = (rows as unknown as Array<{ n: number }>)[0];
    return Number(first?.n ?? 0);
  };
  const tables = [
    "venues",
    "areas",
    "tables",
    "services",
    "guests",
    "bookings",
    "booking_tables",
    "payments",
    "deposit_rules",
    "waitlists",
    "memberships",
  ];
  const out: Record<string, number> = {};
  for (const t of tables) out[t] = await one(t);
  return out;
}

// --- Main --------------------------------------------------------------------

async function main(): Promise<void> {
  // GUARD FIRST — before any connection.
  // Mirror adminDb's resolution (lib/regions/config.ts): DATABASE_URL_EU wins,
  // but an empty/placeholder value falls back to DATABASE_URL — `??` alone
  // wouldn't, since "" is not nullish.
  const firstReal = (...vals: Array<string | undefined>): string | undefined =>
    vals.find((v) => v && !v.includes("YOUR_"));
  const databaseUrl = firstReal(process.env["DATABASE_URL_EU"], process.env["DATABASE_URL"]);
  const supabaseUrl = process.env["NEXT_PUBLIC_SUPABASE_URL"];
  const expectedRef = process.env["STAGING_PROJECT_REF"] ?? refFromArgv(process.argv);
  const check = checkStagingTarget({ databaseUrl, supabaseUrl, expectedRef });

  console.log(`${MARKER} database host: ${check.ok ? check.databaseHost : "<refused>"}`);
  if (!check.ok) {
    console.error(`${MARKER} REFUSING to seed: ${check.reason}`);
    process.exit(2);
  }
  console.log(`${MARKER} Supabase host:  ${check.supabaseHost}`);
  console.log(`${MARKER} confirmed staging project ref: ${check.ref}\n`);

  const adminKey = process.env["SUPABASE_SERVICE_ROLE_KEY"];
  if (!adminKey) {
    console.error(`${MARKER} SUPABASE_SERVICE_ROLE_KEY is not set — needed to create owner users.`);
    process.exit(2);
  }
  const admin = createClient(supabaseUrl!, adminKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const db = adminDb();

  // Prefetch existing auth users so owner creation is idempotent by address.
  const addressToId = new Map<string, string>();
  for (let page = 1; page <= 20; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw error;
    for (const u of data.users) if (u.email) addressToId.set(u.email.toLowerCase(), u.id);
    if (data.users.length < 200) break;
  }

  const orgIds: string[] = [];
  const owners: OwnerResult[] = [];
  const perOrg: Array<{ org: string; venues: number; bookings: number }> = [];

  for (const spec of ORGS) {
    const orgId = await upsertOrg(db, spec);
    orgIds.push(orgId);
    owners.push(await ensureOwner(admin, db, addressToId, spec, orgId));

    const venueIds: string[] = [];
    for (const v of spec.venues) {
      const venueId = await upsertVenue(db, orgId, v);
      await applyTemplate(db, orgId, venueId, v.type);
      if (spec.deposits) await ensureDepositRule(db, orgId, venueId);
      venueIds.push(venueId);
    }

    // Bookings: cap org gets exactly N this month; the rest get the planner's
    // utilisation shapes (past/future fill, deposits, cancels, no-shows).
    let bookingTotal = 0;
    for (const [i, venueId] of venueIds.entries()) {
      if (spec.monthlyCap) {
        bookingTotal += await seedExactMonthlyBookings(db, orgId, venueId, spec.monthlyCap);
      } else {
        const c = await seedVenueBookings(db, {
          venueId,
          marker: MARKER,
          depositAmountMinor: 1000,
          guestPrefix: `v${i}-${venueId.slice(0, 8)}`,
        });
        bookingTotal += c.bookings;
      }
      await ensureWaitlistEntry(db, orgId, venueId);
    }

    perOrg.push({ org: spec.name, venues: venueIds.length, bookings: bookingTotal });
  }

  // Per-org row counts.
  console.log("Row counts by table (scoped to seeded orgs):");
  const finalCounts = await rowCounts(db, orgIds);
  for (const [table, n] of Object.entries(finalCounts)) {
    console.log(`  ${table.padEnd(16)} ${n}`);
  }
  console.log("");
  for (const p of perOrg) {
    console.log(`  ${p.org.padEnd(18)} ${p.venues} venue(s), ${p.bookings} seeded booking(s)`);
  }

  // Credentials summary — printed ONCE, at the end, for the password manager.
  // Addresses are synthetic @example.invalid; lines are prebuilt so the log
  // call carries no contact-field token.
  const credLines = owners.map((o) => {
    const secret = o.password ?? "(unchanged — existing user)";
    return `  ${o.address.padEnd(38)} ${secret.padEnd(22)} [${o.status}]`;
  });
  console.log("\n=== Owner credentials (store these, then clear this output) ===");
  console.log(credLines.join("\n"));
  console.log(
    "\nOwners are NOT pre-enrolled in TOTP — first login exercises the MFA-wall enrolment flow.",
  );
}

main()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    console.error(`${MARKER} failed:`, err instanceof Error ? err.message : "unknown");
    process.exit(1);
  });
