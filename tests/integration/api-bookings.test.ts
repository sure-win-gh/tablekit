// Integration test for POST /api/v1/bookings.
//
// Runs the route handler as a function (no HTTP dev server needed) so
// we can exercise it alongside the rest of the integration suite. The
// route builds a Request internally; we hand it one with a JSON body
// and the appropriate IP headers.
//
// Rate limit: Upstash isn't configured in the test env, so the limiter
// falls through permissively — we don't assert 429 here. That path is
// covered by the rate-limit unit test (no-network fallback).

import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as schema from "@/lib/db/schema";
import { POST } from "@/app/api/v1/bookings/route";

const pool = new Pool({ connectionString: process.env["DATABASE_URL"] });
const db = drizzle(pool, { schema });

const DATE = "2026-07-12"; // Sunday, BST
const run = Date.now().toString(36);
let orgId: string;
let venueId: string;
let serviceId: string;
let originalHcaptchaSecret: string | undefined;

beforeAll(async () => {
  // The placeholder value baked into .env.local.example makes
  // verifyCaptcha think the secret is set and reject every request
  // without a token. Unset it for the duration of the suite so the
  // permissive fallback kicks in.
  originalHcaptchaSecret = process.env["HCAPTCHA_SECRET"];
  delete process.env["HCAPTCHA_SECRET"];
  const [org] = await db
    .insert(schema.organisations)
    .values({ name: `API ${run}`, slug: `api-${run}` })
    .returning({ id: schema.organisations.id });
  orgId = org!.id;

  const [venue] = await db
    .insert(schema.venues)
    .values({
      organisationId: orgId,
      name: `API Venue ${run}`,
      venueType: "cafe",
      timezone: "Europe/London",
    })
    .returning({ id: schema.venues.id });
  venueId = venue!.id;

  const [area] = await db
    .insert(schema.areas)
    .values({ organisationId: orgId, venueId, name: "Inside" })
    .returning({ id: schema.areas.id });
  await db.insert(schema.venueTables).values({
    organisationId: orgId,
    venueId,
    areaId: area!.id,
    label: "T1",
    minCover: 1,
    maxCover: 4,
  });
  const [svc] = await db
    .insert(schema.services)
    .values({
      organisationId: orgId,
      venueId,
      name: "Open",
      schedule: {
        days: ["sun", "mon", "tue", "wed", "thu", "fri", "sat"],
        start: "08:00",
        end: "17:00",
      },
      turnMinutes: 45,
    })
    .returning({ id: schema.services.id });
  serviceId = svc!.id;
});

afterAll(async () => {
  if (originalHcaptchaSecret !== undefined) {
    process.env["HCAPTCHA_SECRET"] = originalHcaptchaSecret;
  }
  if (orgId) await db.delete(schema.organisations).where(eq(schema.organisations.id, orgId));
  await pool.end();
});

function makeRequest(body: unknown): Request {
  return new Request("http://localhost:3000/api/v1/bookings", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": "198.51.100.5" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/v1/bookings", () => {
  it("creates a booking and returns a reference", async () => {
    const res = await POST(
      makeRequest({
        venueId,
        serviceId,
        date: DATE,
        wallStart: "12:00",
        partySize: 2,
        guest: {
          firstName: "Web",
          email: `web-${run}@example.com`,
        },
      }) as never,
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { ok: true; bookingId: string; reference: string };
    expect(body.ok).toBe(true);
    expect(body.reference).toMatch(/^[0-9A-F]{4}-[0-9A-F]{4}$/);

    const [row] = await db
      .select({ source: schema.bookings.source })
      .from(schema.bookings)
      .where(eq(schema.bookings.id, body.bookingId));
    expect(row?.source).toBe("widget");
  });

  it("rejects an unknown venue with 404", async () => {
    const res = await POST(
      makeRequest({
        venueId: "00000000-0000-0000-0000-000000000000",
        serviceId,
        date: DATE,
        wallStart: "12:00",
        partySize: 2,
        guest: { firstName: "X", email: `x-${run}@example.com` },
      }) as never,
    );
    expect(res.status).toBe(404);
  });

  it("rejects an invalid body with 400", async () => {
    const res = await POST(
      makeRequest({
        venueId,
        serviceId,
        date: "not-a-date",
        wallStart: "noon",
        partySize: "many",
        guest: { firstName: "", email: "bad" },
      }) as never,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; issues?: string[] };
    expect(body.error).toBe("invalid-input");
    expect(body.issues?.length ?? 0).toBeGreaterThan(0);
  });

  it("rejects invalid JSON with 400", async () => {
    const res = await POST(
      new Request("http://localhost:3000/api/v1/bookings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{not json",
      }) as never,
    );
    expect(res.status).toBe(400);
  });

  it("returns 409 when the exact slot is already taken", async () => {
    // First booking at 14:00 — fills the single table.
    const r1 = await POST(
      makeRequest({
        venueId,
        serviceId,
        date: DATE,
        wallStart: "14:00",
        partySize: 2,
        guest: { firstName: "A", email: `slot-a-${run}@example.com` },
      }) as never,
    );
    expect(r1.status).toBe(201);

    // Second booking at exactly the same time and party — no table left.
    const r2 = await POST(
      makeRequest({
        venueId,
        serviceId,
        date: DATE,
        wallStart: "14:00",
        partySize: 2,
        guest: { firstName: "B", email: `slot-b-${run}@example.com` },
      }) as never,
    );
    expect(r2.status).toBe(409);
    const body = (await r2.json()) as { error: string };
    expect(["slot-taken", "no-availability"]).toContain(body.error);
  });
});
