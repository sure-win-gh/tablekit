// Cross-tenant RLS for the payments-connect phase tables.
//
// Asserts:
//   1. stripe_accounts member_read — user A sees their org's row, not
//      org B's
//   2. authenticated cannot insert/update/delete stripe_accounts
//      directly (no policies → default-deny)
//   3. stripe_events has NO policies whatsoever — authenticated reads
//      return zero rows, which is the system-only guarantee
//   4. storeEvent's ON CONFLICT DO NOTHING gives idempotency: second
//      call with the same evt_id is a no-op, handled_at survives

import { sql, eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { createClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as schema from "@/lib/db/schema";
import { markHandled, storeEvent } from "@/lib/stripe/webhook";

type Db = NodePgDatabase<typeof schema>;

const pool = new Pool({ connectionString: process.env["DATABASE_URL"] });
const db = drizzle(pool, { schema });

const admin = createClient(
  process.env["NEXT_PUBLIC_SUPABASE_URL"]!,
  process.env["SUPABASE_SERVICE_ROLE_KEY"]!,
  { auth: { autoRefreshToken: false, persistSession: false } },
);

async function asUser<T>(userId: string, fn: (tx: Db) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('role', 'authenticated', true)`);
    const claims = JSON.stringify({ sub: userId, role: "authenticated" });
    await tx.execute(sql`select set_config('request.jwt.claims', ${claims}, true)`);
    await tx.execute(sql`select set_config('request.jwt.claim.sub', ${userId}, true)`);
    return fn(tx as Db);
  });
}

const run = Date.now().toString(36);
let userAId: string;
let userBId: string;
let orgAId: string;
let orgBId: string;
let eventAId: string;

beforeAll(async () => {
  const mkUser = async (email: string) => {
    const { data, error } = await admin.auth.admin.createUser({
      email,
      password: "integration-test-pw-1234",
      email_confirm: true,
      user_metadata: { full_name: email },
    });
    if (error || !data.user) throw error ?? new Error("createUser failed");
    return data.user.id;
  };

  userAId = await mkUser(`stripe-a-${run}@tablekit.test`);
  userBId = await mkUser(`stripe-b-${run}@tablekit.test`);

  const [orgA] = await db
    .insert(schema.organisations)
    .values({ name: `Str A ${run}`, slug: `str-a-${run}` })
    .returning({ id: schema.organisations.id });
  const [orgB] = await db
    .insert(schema.organisations)
    .values({ name: `Str B ${run}`, slug: `str-b-${run}` })
    .returning({ id: schema.organisations.id });
  orgAId = orgA!.id;
  orgBId = orgB!.id;

  await db.insert(schema.memberships).values([
    { userId: userAId, organisationId: orgAId, role: "owner" },
    { userId: userBId, organisationId: orgBId, role: "owner" },
  ]);

  await db.insert(schema.stripeAccounts).values([
    { organisationId: orgAId, accountId: `acct_a_${run}` },
    { organisationId: orgBId, accountId: `acct_b_${run}` },
  ]);

  eventAId = `evt_test_${run}_a`;
});

afterAll(async () => {
  await admin.auth.admin.deleteUser(userAId).catch(() => undefined);
  await admin.auth.admin.deleteUser(userBId).catch(() => undefined);
  await db.delete(schema.organisations).where(eq(schema.organisations.id, orgAId));
  await db.delete(schema.organisations).where(eq(schema.organisations.id, orgBId));
  await db.delete(schema.stripeEvents).where(eq(schema.stripeEvents.id, eventAId));
  await pool.end();
});

describe("stripe_accounts — cross-tenant RLS", () => {
  it("user A sees only their own row", async () => {
    const rows = await asUser(userAId, (tx) => tx.select().from(schema.stripeAccounts));
    const orgIds = rows.map((r) => r.organisationId);
    expect(orgIds).toContain(orgAId);
    expect(orgIds).not.toContain(orgBId);
  });

  it("authenticated cannot insert into stripe_accounts", async () => {
    await expect(
      asUser(userAId, (tx) =>
        tx.insert(schema.stripeAccounts).values({
          organisationId: orgAId,
          accountId: `acct_hijack_${run}`,
        }),
      ),
    ).rejects.toThrow();
  });

  it("authenticated UPDATE silently affects zero rows (no UPDATE policy)", async () => {
    // Postgres RLS with no matching UPDATE policy doesn't throw —
    // it just sees zero rows. Assert by checking the row is
    // unchanged after the attempt.
    await asUser(userAId, (tx) =>
      tx
        .update(schema.stripeAccounts)
        .set({ chargesEnabled: true })
        .where(eq(schema.stripeAccounts.organisationId, orgAId)),
    );
    const [row] = await db
      .select({ chargesEnabled: schema.stripeAccounts.chargesEnabled })
      .from(schema.stripeAccounts)
      .where(eq(schema.stripeAccounts.organisationId, orgAId));
    expect(row?.chargesEnabled).toBe(false);
  });
});

describe("stripe_events — system-only", () => {
  it("authenticated role reads zero rows", async () => {
    // Write one first via adminDb so there's something to NOT see.
    await db.insert(schema.stripeEvents).values({
      id: eventAId,
      type: "account.updated",
      payload: { id: eventAId, type: "account.updated" },
    });
    const rows = await asUser(userAId, (tx) => tx.select().from(schema.stripeEvents));
    expect(rows.length).toBe(0);
  });
});

describe("storeEvent — idempotent insert", () => {
  it("second call with the same evt_id no-ops and does not clear handled_at", async () => {
    const event = {
      id: `evt_idem_${run}`,
      type: "account.updated",
      data: { object: {} },
      // The SDK's Stripe.Event has more fields; we only need `id` and
      // `type` for the store path to run, and payload captures the rest.
    } as unknown as import("stripe").Stripe.Event;

    const first = await storeEvent(event);
    expect(first).toBe("new");

    await markHandled(event.id);

    const second = await storeEvent(event);
    expect(second).toBe("duplicate");

    const [row] = await db
      .select({ handledAt: schema.stripeEvents.handledAt })
      .from(schema.stripeEvents)
      .where(eq(schema.stripeEvents.id, event.id));
    expect(row?.handledAt).not.toBeNull();

    await db.delete(schema.stripeEvents).where(eq(schema.stripeEvents.id, event.id));
  });
});
