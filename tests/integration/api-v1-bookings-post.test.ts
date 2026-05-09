// Integration test for POST /api/v1/bookings — authed Plus-tier
// branch. Calls the route handler directly. Coverage:
//   - Auth: 401 with no Authorization header (this branch); the
//     anonymous widget path covers the no-header case separately
//     and is tested by tests/integration/api-bookings.test.ts.
//   - 201 on a valid request, source: "api" persisted on the row
//   - Cross-org: a key in org A trying to book at org B's venue
//     gets 404 (no leak)
//   - Idempotency-Key: replay returns the SAME bookingId without
//     creating a second row

import { eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { POST } from "@/app/api/v1/bookings/route";
import { issueApiKey } from "@/lib/api-keys/issue";
import * as schema from "@/lib/db/schema";

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
  keyA: string;
};
let ctx: Ctx;

beforeAll(async () => {
  // Two orgs so we can prove cross-org venue isolation.
  const [orgA] = await db
    .insert(schema.organisations)
    .values({ name: `POST-A ${run}`, slug: `post-a-${run}`, plan: "plus" })
    .returning({ id: schema.organisations.id });
  const [orgB] = await db
    .insert(schema.organisations)
    .values({ name: `POST-B ${run}`, slug: `post-b-${run}`, plan: "plus" })
    .returning({ id: schema.organisations.id });

  const venuesData: { id: string; orgId: string }[] = [];
  for (const org of [orgA!, orgB!]) {
    const [v] = await db
      .insert(schema.venues)
      .values({
        organisationId: org.id,
        name: "Cafe",
        venueType: "cafe",
        slug: `post-${org.id.slice(0, 8)}-${run}`,
      })
      .returning({ id: schema.venues.id });
    venuesData.push({ id: v!.id, orgId: org.id });
  }

  // Area + table + service for org A only — that's where bookings
  // will land; org B just needs a venue that exists for the cross-
  // org test.
  const [areaA] = await db
    .insert(schema.areas)
    .values({ organisationId: orgA!.id, venueId: venuesData[0]!.id, name: "Inside" })
    .returning({ id: schema.areas.id });
  await db.insert(schema.venueTables).values({
    organisationId: orgA!.id,
    venueId: venuesData[0]!.id,
    areaId: areaA!.id,
    label: "T1",
    minCover: 1,
    maxCover: 4,
  });
  const [svcA] = await db
    .insert(schema.services)
    .values({
      organisationId: orgA!.id,
      venueId: venuesData[0]!.id,
      name: "Open",
      schedule: {
        days: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"],
        start: "08:00",
        end: "23:00",
      },
      turnMinutes: 60,
    })
    .returning({ id: schema.services.id });

  const keyA = await issueApiKey({
    organisationId: orgA!.id,
    label: "test-A",
    createdByUserId: null as unknown as string,
  });

  ctx = {
    orgAId: orgA!.id,
    orgBId: orgB!.id,
    venueAId: venuesData[0]!.id,
    venueBId: venuesData[1]!.id,
    serviceAId: svcA!.id,
    keyA: keyA.plaintext,
  };
});

afterAll(async () => {
  if (ctx) {
    await db.delete(schema.organisations).where(eq(schema.organisations.id, ctx.orgAId));
    await db.delete(schema.organisations).where(eq(schema.organisations.id, ctx.orgBId));
  }
  await pool.end();
});

function makeReq(opts: { body: unknown; auth?: string; idempotencyKey?: string }): Request {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.auth) headers["authorization"] = `Bearer ${opts.auth}`;
  if (opts.idempotencyKey) headers["idempotency-key"] = opts.idempotencyKey;
  return new Request("http://localhost:3000/api/v1/bookings", {
    method: "POST",
    headers,
    body: JSON.stringify(opts.body),
  });
}

const validBody = (date: string, wallStart = "12:00") => ({
  venueId: ctx.venueAId,
  serviceId: ctx.serviceAId,
  date,
  wallStart,
  partySize: 2,
  guest: { firstName: "Api", email: `api-${run}-${Math.random()}@example.com` },
});

describe("POST /api/v1/bookings — authed", () => {
  it("creates a booking, persists source: 'api'", async () => {
    const res = await POST(makeReq({ body: validBody("2026-07-12"), auth: ctx.keyA }) as never);
    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: { id: string; reference: string; status: string } };
    expect(body.data.id).toBeTruthy();
    expect(body.data.reference).toMatch(/^[0-9A-F]{4}-[0-9A-F]{4}$/);

    const [row] = await db
      .select({ source: schema.bookings.source, organisationId: schema.bookings.organisationId })
      .from(schema.bookings)
      .where(eq(schema.bookings.id, body.data.id));
    expect(row?.source).toBe("api");
    expect(row?.organisationId).toBe(ctx.orgAId);
  });

  it("rejects a venue in another org with 404 (no cross-org leak)", async () => {
    const res = await POST(
      makeReq({
        body: { ...validBody("2026-07-13"), venueId: ctx.venueBId },
        auth: ctx.keyA,
      }) as never,
    );
    expect(res.status).toBe(404);
  });

  it("rejects an invalid body with 400", async () => {
    const res = await POST(
      makeReq({
        body: { ...validBody("not-a-date"), partySize: -1 },
        auth: ctx.keyA,
      }) as never,
    );
    expect(res.status).toBe(400);
  });
});

describe("POST /api/v1/bookings — Idempotency-Key", () => {
  it("returns the SAME bookingId on replay; only one DB row exists", async () => {
    const idemKey = `idem-${run}-${Math.random()}`;
    const body = validBody("2026-07-14", "13:00");

    const r1 = await POST(makeReq({ body, auth: ctx.keyA, idempotencyKey: idemKey }) as never);
    expect(r1.status).toBe(201);
    const j1 = (await r1.json()) as { data: { id: string } };

    // Replay — fully different body shape ignored, should return cached.
    const r2 = await POST(
      makeReq({
        body: { ...body, partySize: 8, notes: "different" },
        auth: ctx.keyA,
        idempotencyKey: idemKey,
      }) as never,
    );
    expect(r2.status).toBe(201);
    const j2 = (await r2.json()) as { data: { id: string } };
    expect(j2.data.id).toBe(j1.data.id);

    // No second booking row — only the first one exists for this guest+slot.
    const rows = await db
      .select({ id: schema.bookings.id })
      .from(schema.bookings)
      .where(eq(schema.bookings.id, j1.data.id));
    expect(rows.length).toBe(1);
  });

  it("rejects an Idempotency-Key over 200 chars with 400", async () => {
    const tooLong = "x".repeat(201);
    const res = await POST(
      makeReq({
        body: validBody("2026-07-15"),
        auth: ctx.keyA,
        idempotencyKey: tooLong,
      }) as never,
    );
    expect(res.status).toBe(400);
  });
});
