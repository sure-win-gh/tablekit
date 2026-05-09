// Integration tests for the rest of the v1 read surface — guests,
// venues, services. One test file per acceptance area, one
// describe block per endpoint, smoke-tests only (auth + scoping +
// shape). Cursor + filter behaviour is exercised in depth by
// api-v1-bookings.test.ts; the same wrapper + helpers are reused
// here so the deep coverage transitively applies.

import { eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { GET as GetGuestById } from "@/app/api/v1/guests/[id]/route";
import { GET as GetGuests } from "@/app/api/v1/guests/route";
import { GET as GetServices } from "@/app/api/v1/services/route";
import { GET as GetVenues } from "@/app/api/v1/venues/route";
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
  keyA: string;
};
let ctx: Ctx;

beforeAll(async () => {
  const [orgA] = await db
    .insert(schema.organisations)
    .values({ name: `READ-A ${run}`, slug: `read-a-${run}`, plan: "plus" })
    .returning({ id: schema.organisations.id });
  const [orgB] = await db
    .insert(schema.organisations)
    .values({ name: `READ-B ${run}`, slug: `read-b-${run}`, plan: "plus" })
    .returning({ id: schema.organisations.id });

  const venueIds: { id: string; orgId: string }[] = [];
  for (const org of [orgA!, orgB!]) {
    const [v] = await db
      .insert(schema.venues)
      .values({
        organisationId: org.id,
        name: org === orgA ? "Aaa Cafe" : "Bbb Bar",
        venueType: "cafe",
        slug: `read-${org.id.slice(0, 8)}-${run}`,
      })
      .returning({ id: schema.venues.id });
    venueIds.push({ id: v!.id, orgId: org.id });
  }
  const services: string[] = [];
  for (const v of venueIds) {
    const [s] = await db
      .insert(schema.services)
      .values({
        organisationId: v.orgId,
        venueId: v.id,
        name: "Open",
        schedule: { days: ["mon"], start: "08:00", end: "23:00" },
        turnMinutes: 60,
      })
      .returning({ id: schema.services.id });
    services.push(s!.id);
  }

  const guestIds: string[] = [];
  for (const v of venueIds) {
    await encryptPii(v.orgId, "" as Plaintext);
    const [lastNameCipher, emailCipher, phoneCipher] = await Promise.all([
      encryptPii(v.orgId, "Smith" as Plaintext),
      encryptPii(v.orgId, "jane@example.com" as Plaintext),
      encryptPii(v.orgId, "+447700900123" as Plaintext),
    ]);
    const [g] = await db
      .insert(schema.guests)
      .values({
        organisationId: v.orgId,
        firstName: "Jane",
        lastNameCipher,
        emailCipher,
        emailHash: `h-${run}-${v.id}`,
        phoneCipher,
      })
      .returning({ id: schema.guests.id });
    guestIds.push(g!.id);
  }

  const keyA = await issueApiKey({
    organisationId: orgA!.id,
    label: "test-A",
    createdByUserId: null as unknown as string,
  });

  ctx = {
    orgAId: orgA!.id,
    orgBId: orgB!.id,
    venueAId: venueIds[0]!.id,
    venueBId: venueIds[1]!.id,
    serviceAId: services[0]!,
    serviceBId: services[1]!,
    guestAId: guestIds[0]!,
    guestBId: guestIds[1]!,
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

function makeReq(path: string, auth?: string): Request {
  return new Request(`http://localhost:3000${path}`, {
    method: "GET",
    headers: auth ? { authorization: `Bearer ${auth}` } : {},
  });
}

describe("GET /api/v1/guests", () => {
  it("returns minimal projection scoped to the auth'd org", async () => {
    const res = await GetGuests(makeReq("/api/v1/guests", ctx.keyA) as never);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { id: string; first_name: string; email_hash: string }[];
    };
    const ids = body.data.map((r) => r.id);
    expect(ids).toContain(ctx.guestAId);
    expect(ids).not.toContain(ctx.guestBId);
    // List response is the minimal projection — no email plaintext.
    expect((body.data[0] as Record<string, unknown>)["email"]).toBeUndefined();
  });

  it("401 with no auth", async () => {
    const res = await GetGuests(makeReq("/api/v1/guests") as never);
    expect(res.status).toBe(401);
  });
});

describe("GET /api/v1/guests/:id", () => {
  it("returns decrypted PII for the auth'd org", async () => {
    const res = await GetGuestById(makeReq(`/api/v1/guests/${ctx.guestAId}`, ctx.keyA) as never);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { last_name: string; email: string; phone: string | null };
    };
    expect(body.data.last_name).toBe("Smith");
    expect(body.data.email).toBe("jane@example.com");
    expect(body.data.phone).toBe("+447700900123");
  });

  it("404 for cross-org id (no leak)", async () => {
    const res = await GetGuestById(makeReq(`/api/v1/guests/${ctx.guestBId}`, ctx.keyA) as never);
    expect(res.status).toBe(404);
  });

  it("400 for non-UUID id", async () => {
    const res = await GetGuestById(makeReq("/api/v1/guests/not-a-uuid", ctx.keyA) as never);
    expect(res.status).toBe(400);
  });
});

describe("GET /api/v1/venues", () => {
  it("returns only the auth'd org's venues", async () => {
    const res = await GetVenues(makeReq("/api/v1/venues", ctx.keyA) as never);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { id: string; name: string }[] };
    const ids = body.data.map((r) => r.id);
    expect(ids).toContain(ctx.venueAId);
    expect(ids).not.toContain(ctx.venueBId);
  });
});

describe("GET /api/v1/services", () => {
  it("returns only the auth'd org's services", async () => {
    const res = await GetServices(makeReq("/api/v1/services", ctx.keyA) as never);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { id: string; venue_id: string }[] };
    const ids = body.data.map((r) => r.id);
    expect(ids).toContain(ctx.serviceAId);
    expect(ids).not.toContain(ctx.serviceBId);
  });

  it("filters by venue_id", async () => {
    const res = await GetServices(
      makeReq(`/api/v1/services?venue_id=${ctx.venueAId}`, ctx.keyA) as never,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { id: string; venue_id: string }[] };
    for (const r of body.data) expect(r.venue_id).toBe(ctx.venueAId);
  });

  it("400 on invalid venue_id", async () => {
    const res = await GetServices(makeReq("/api/v1/services?venue_id=nope", ctx.keyA) as never);
    expect(res.status).toBe(400);
  });
});
