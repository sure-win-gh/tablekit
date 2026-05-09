// Integration test for GET /api/v1/availability.
//
// Public, anonymous, IP-rate-limited. Closes spec acceptance #2 of
// docs/specs/bookings.md ("availability endpoint returns slots in
// the venue's timezone, returns ISO strings in UTC").

import { eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { GET } from "@/app/api/v1/availability/route";
import * as schema from "@/lib/db/schema";

type Db = NodePgDatabase<typeof schema>;

const pool = new Pool({ connectionString: process.env["DATABASE_URL"] });
const db: Db = drizzle(pool, { schema });

const run = Date.now().toString(36);
type Ctx = { orgId: string; venueId: string; serviceId: string };
let ctx: Ctx;

beforeAll(async () => {
  const [org] = await db
    .insert(schema.organisations)
    .values({ name: `Avail ${run}`, slug: `avail-${run}` })
    .returning({ id: schema.organisations.id });
  const [venue] = await db
    .insert(schema.venues)
    .values({
      organisationId: org!.id,
      name: "Cafe",
      venueType: "cafe",
      timezone: "Europe/London",
      slug: `avail-${run}`,
    })
    .returning({ id: schema.venues.id });
  const [area] = await db
    .insert(schema.areas)
    .values({ organisationId: org!.id, venueId: venue!.id, name: "Inside" })
    .returning({ id: schema.areas.id });
  await db.insert(schema.venueTables).values({
    organisationId: org!.id,
    venueId: venue!.id,
    areaId: area!.id,
    label: "T1",
    minCover: 1,
    maxCover: 4,
  });
  const [svc] = await db
    .insert(schema.services)
    .values({
      organisationId: org!.id,
      venueId: venue!.id,
      name: "Lunch",
      schedule: {
        days: ["sun", "mon", "tue", "wed", "thu", "fri", "sat"],
        start: "12:00",
        end: "14:00",
      },
      turnMinutes: 60,
    })
    .returning({ id: schema.services.id });
  ctx = { orgId: org!.id, venueId: venue!.id, serviceId: svc!.id };
});

afterAll(async () => {
  if (ctx) await db.delete(schema.organisations).where(eq(schema.organisations.id, ctx.orgId));
  await pool.end();
});

function makeReq(query: string): Request {
  return new Request(`http://localhost:3000/api/v1/availability${query}`, {
    method: "GET",
    headers: { "x-forwarded-for": "198.51.100.7" },
  });
}

describe("GET /api/v1/availability", () => {
  it("returns slots with UTC ISO timestamps + venue-local wall_start", async () => {
    const res = await GET(
      makeReq(`?venue_id=${ctx.venueId}&date=2026-06-15&party_size=2`) as never,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      timezone: string;
      slots: { service_id: string; wall_start: string; start_at: string; end_at: string }[];
    };
    expect(body.timezone).toBe("Europe/London");
    expect(body.slots.length).toBeGreaterThan(0);
    const slot = body.slots[0]!;
    // wall_start is venue-local "HH:MM"
    expect(slot.wall_start).toMatch(/^\d{2}:\d{2}$/);
    // start_at is a valid UTC ISO 8601 with the Z suffix
    expect(slot.start_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(slot.end_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    // The slot's service belongs to the requested venue.
    expect(slot.service_id).toBe(ctx.serviceId);
  });

  it("400s on bad venue_id", async () => {
    const res = await GET(makeReq("?venue_id=not-a-uuid&date=2026-06-15&party_size=2") as never);
    expect(res.status).toBe(400);
  });

  it("400s on bad date", async () => {
    const res = await GET(makeReq(`?venue_id=${ctx.venueId}&date=tomorrow&party_size=2`) as never);
    expect(res.status).toBe(400);
  });

  it("400s on out-of-range party_size", async () => {
    const res = await GET(
      makeReq(`?venue_id=${ctx.venueId}&date=2026-06-15&party_size=999`) as never,
    );
    expect(res.status).toBe(400);
  });

  it("404s for an unknown venue id", async () => {
    const res = await GET(
      makeReq(
        "?venue_id=00000000-0000-0000-0000-000000000000&date=2026-06-15&party_size=2",
      ) as never,
    );
    expect(res.status).toBe(404);
  });
});
