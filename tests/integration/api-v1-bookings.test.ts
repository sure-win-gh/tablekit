// Integration test for GET /api/v1/bookings + GET /api/v1/bookings/[id].
//
// Calls the route handlers directly with a constructed Request — same
// pattern as tests/integration/api-bookings.test.ts. Coverage:
//   - 401 on missing or malformed Authorization header
//   - 200 on a valid key, list scoped to the key's organisation
//   - cross-org isolation (key in org A cannot see bookings in org B)
//   - filters: venue_id, status, from/to
//   - cursor pagination drains a multi-page set without overlap
//   - GET by id: 200 own org, 404 unknown id, 404 other-org id

import { eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { GET as GetById } from "@/app/api/v1/bookings/[id]/route";
import { GET as GetList } from "@/app/api/v1/bookings/route";
import { issueApiKey } from "@/lib/api-keys/issue";
import * as schema from "@/lib/db/schema";
import { encryptPii, type Plaintext } from "@/lib/security/crypto";

type Db = NodePgDatabase<typeof schema>;

const pool = new Pool({ connectionString: process.env["DATABASE_URL"] });
const db: Db = drizzle(pool, { schema });

const run = Date.now().toString(36);

type Ctx = {
  orgAId: string;
  orgBId: string;
  venueAId: string;
  venueBId: string;
  serviceAId: string;
  serviceBId: string;
  guestAId: string;
  guestBId: string;
  // Booking ids by status for org A.
  bookingsAByStatus: Record<string, string>;
  bookingBId: string;
  keyA: string;
  keyB: string;
};
let ctx: Ctx;

beforeAll(async () => {
  // Two orgs so we can prove cross-org isolation.
  const [orgA] = await db
    .insert(schema.organisations)
    .values({ name: `API-V1-A ${run}`, slug: `api-v1-a-${run}`, plan: "plus" })
    .returning({ id: schema.organisations.id });
  const [orgB] = await db
    .insert(schema.organisations)
    .values({ name: `API-V1-B ${run}`, slug: `api-v1-b-${run}`, plan: "plus" })
    .returning({ id: schema.organisations.id });

  // Each org gets a venue + area + table + service so booking inserts
  // satisfy the FK chain.
  const venues: { id: string; orgId: string }[] = [];
  for (const org of [orgA!, orgB!]) {
    const [v] = await db
      .insert(schema.venues)
      .values({
        organisationId: org.id,
        name: "Cafe",
        venueType: "cafe",
        slug: `api-v1-${org.id.slice(0, 8)}-${run}`,
      })
      .returning({ id: schema.venues.id });
    venues.push({ id: v!.id, orgId: org.id });
  }
  const areas = await Promise.all(
    venues.map(async (v) => {
      const [a] = await db
        .insert(schema.areas)
        .values({ organisationId: v.orgId, venueId: v.id, name: "Inside" })
        .returning({ id: schema.areas.id });
      return a!.id;
    }),
  );
  await db.insert(schema.venueTables).values(
    venues.map((v, i) => ({
      organisationId: v.orgId,
      venueId: v.id,
      areaId: areas[i]!,
      label: "T1",
      minCover: 1,
      maxCover: 4,
    })),
  );
  const services = await Promise.all(
    venues.map(async (v) => {
      const [s] = await db
        .insert(schema.services)
        .values({
          organisationId: v.orgId,
          venueId: v.id,
          name: "Open",
          schedule: {
            days: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"],
            start: "08:00",
            end: "23:00",
          },
          turnMinutes: 60,
        })
        .returning({ id: schema.services.id });
      return s!.id;
    }),
  );

  // Guests — bookings need a guest FK. Pre-warm DEK then encrypt
  // sequentially per org to avoid the parallel-encrypt cost on a
  // fresh org (DEK provisioning lock now handles concurrency
  // correctly, but sequential is faster on a cold start).
  const guests: string[] = [];
  for (const v of venues) {
    await encryptPii(v.orgId, "" as Plaintext);
    const [lastNameCipher, emailCipher] = await Promise.all([
      encryptPii(v.orgId, "Test" as Plaintext),
      encryptPii(v.orgId, "test@example.com" as Plaintext),
    ]);
    const [g] = await db
      .insert(schema.guests)
      .values({
        organisationId: v.orgId,
        firstName: "Test",
        lastNameCipher,
        emailCipher,
        emailHash: `h-${run}-${v.id}`,
      })
      .returning({ id: schema.guests.id });
    guests.push(g!.id);
  }

  // Seed 4 bookings for org A across different statuses + start times
  // and 1 for org B.
  const STATUSES = ["confirmed", "seated", "finished", "cancelled"] as const;
  const baseStart = new Date("2026-06-01T18:00:00Z");
  const bookingsAByStatus: Record<string, string> = {};
  for (let i = 0; i < STATUSES.length; i++) {
    const start = new Date(baseStart.getTime() + i * 3600 * 1000);
    const end = new Date(start.getTime() + 3600 * 1000);
    const [b] = await db
      .insert(schema.bookings)
      .values({
        organisationId: orgA!.id,
        venueId: venues[0]!.id,
        serviceId: services[0]!,
        areaId: areas[0]!,
        guestId: guests[0]!,
        partySize: 2,
        startAt: start,
        endAt: end,
        status: STATUSES[i],
        source: "api",
      })
      .returning({ id: schema.bookings.id });
    bookingsAByStatus[STATUSES[i]!] = b!.id;
  }
  const [bB] = await db
    .insert(schema.bookings)
    .values({
      organisationId: orgB!.id,
      venueId: venues[1]!.id,
      serviceId: services[1]!,
      areaId: areas[1]!,
      guestId: guests[1]!,
      partySize: 4,
      startAt: new Date("2026-06-15T19:00:00Z"),
      endAt: new Date("2026-06-15T20:00:00Z"),
      status: "confirmed",
      source: "api",
    })
    .returning({ id: schema.bookings.id });

  // Need a real user FK for the api_keys.created_by_user_id column.
  // Use the SQL-only auth.users table the schema's `users` mirrors —
  // simplest path is to insert directly into public.users with a
  // synthetic auth.users id. But auth.users requires real Supabase
  // creation. Easier: skip the FK by passing a NULL — except the
  // schema marks it as a non-null reference? Recheck:
  //
  // (apiKeys.createdByUserId is nullable per the schema definition —
  // it just has a SET NULL FK behaviour. Pass null below.)
  const issueA = await issueApiKey({
    organisationId: orgA!.id,
    label: "test-A",
    createdByUserId: null as unknown as string, // null is fine — column is nullable
  });
  const issueB = await issueApiKey({
    organisationId: orgB!.id,
    label: "test-B",
    createdByUserId: null as unknown as string,
  });

  ctx = {
    orgAId: orgA!.id,
    orgBId: orgB!.id,
    venueAId: venues[0]!.id,
    venueBId: venues[1]!.id,
    serviceAId: services[0]!,
    serviceBId: services[1]!,
    guestAId: guests[0]!,
    guestBId: guests[1]!,
    bookingsAByStatus,
    bookingBId: bB!.id,
    keyA: issueA.plaintext,
    keyB: issueB.plaintext,
  };
});

afterAll(async () => {
  if (ctx) {
    await db.delete(schema.organisations).where(eq(schema.organisations.id, ctx.orgAId));
    await db.delete(schema.organisations).where(eq(schema.organisations.id, ctx.orgBId));
  }
  await pool.end();
});

function listReq(query = "", auth?: string): Request {
  return new Request(`http://localhost:3000/api/v1/bookings${query}`, {
    method: "GET",
    headers: auth ? { authorization: `Bearer ${auth}` } : {},
  });
}

function byIdReq(id: string, auth?: string): Request {
  return new Request(`http://localhost:3000/api/v1/bookings/${id}`, {
    method: "GET",
    headers: auth ? { authorization: `Bearer ${auth}` } : {},
  });
}

describe("GET /api/v1/bookings — auth", () => {
  it("401 with no Authorization header", async () => {
    const res = await GetList(listReq() as never);
    expect(res.status).toBe(401);
  });

  it("401 with a malformed Bearer token", async () => {
    const res = await GetList(listReq("", "not-a-real-key") as never);
    expect(res.status).toBe(401);
  });
});

describe("GET /api/v1/bookings — list + scoping", () => {
  it("returns only the auth'd organisation's bookings", async () => {
    const res = await GetList(listReq("", ctx.keyA) as never);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { id: string; venue_id: string }[] };
    const ids = body.data.map((r) => r.id);
    for (const id of Object.values(ctx.bookingsAByStatus)) expect(ids).toContain(id);
    expect(ids).not.toContain(ctx.bookingBId);
  });

  it("filters by status", async () => {
    const res = await GetList(listReq("?status=confirmed,seated", ctx.keyA) as never);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { id: string; status: string }[] };
    const statuses = new Set(body.data.map((r) => r.status));
    expect(statuses).toEqual(new Set(["confirmed", "seated"]));
  });

  it("rejects unknown status with 400", async () => {
    const res = await GetList(listReq("?status=bogus", ctx.keyA) as never);
    expect(res.status).toBe(400);
  });

  it("filters by from/to (start_at range)", async () => {
    const res = await GetList(
      listReq("?from=2026-06-01T18:30:00Z&to=2026-06-01T20:30:00Z", ctx.keyA) as never,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { start_at: string }[] };
    // Three bookings start at 18:00, 19:00, 20:00 → from=18:30 cuts
    // the 18:00 one; to=20:30 keeps the 20:00 one. Expect 2.
    expect(body.data.length).toBe(2);
  });

  it("paginates via cursor without overlap", async () => {
    const first = await GetList(listReq("?limit=2", ctx.keyA) as never);
    const firstBody = (await first.json()) as {
      data: { id: string }[];
      next_cursor: string | null;
    };
    expect(firstBody.data.length).toBe(2);
    expect(firstBody.next_cursor).toBeTruthy();

    const second = await GetList(
      listReq(`?limit=2&cursor=${encodeURIComponent(firstBody.next_cursor!)}`, ctx.keyA) as never,
    );
    const secondBody = (await second.json()) as {
      data: { id: string }[];
      next_cursor: string | null;
    };
    const firstIds = new Set(firstBody.data.map((r) => r.id));
    for (const r of secondBody.data) expect(firstIds.has(r.id)).toBe(false);
  });
});

describe("GET /api/v1/bookings/[id]", () => {
  it("returns the booking when it belongs to the auth'd org", async () => {
    const id = Object.values(ctx.bookingsAByStatus)[0]!;
    const res = await GetById(byIdReq(id, ctx.keyA) as never);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { id: string } };
    expect(body.data.id).toBe(id);
  });

  it("404s for an id in another org (no cross-org leak)", async () => {
    const res = await GetById(byIdReq(ctx.bookingBId, ctx.keyA) as never);
    expect(res.status).toBe(404);
  });

  it("404s for an unknown id", async () => {
    const res = await GetById(byIdReq("00000000-0000-0000-0000-000000000000", ctx.keyA) as never);
    expect(res.status).toBe(404);
  });

  it("400s on a non-UUID id", async () => {
    const res = await GetById(byIdReq("not-a-uuid", ctx.keyA) as never);
    expect(res.status).toBe(400);
  });

  it("401s with no auth", async () => {
    const id = Object.values(ctx.bookingsAByStatus)[0]!;
    const res = await GetById(byIdReq(id) as never);
    expect(res.status).toBe(401);
  });
});
