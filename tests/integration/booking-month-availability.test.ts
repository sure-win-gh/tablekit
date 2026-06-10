// Integration test for loadPublicMonthAvailability (booking-page Phase 3).
// A service runs Fri+Sat; verifies the per-day classification (open on
// service days, closed otherwise, past for a historical month) against the
// real schema + findSlots.

import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { createClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as schema from "@/lib/db/schema";

const pool = new Pool({ connectionString: process.env["DATABASE_URL"] });
const db = drizzle(pool, { schema });

const admin = createClient(
  process.env["NEXT_PUBLIC_SUPABASE_URL"]!,
  process.env["SUPABASE_SERVICE_ROLE_KEY"]!,
  { auth: { autoRefreshToken: false, persistSession: false } },
);

const run = Date.now().toString(36);
const venuePub = { name: "V", timezone: "Europe/London", locale: "en-GB" };

let ctx: { userId: string; orgId: string; venueId: string };

beforeAll(async () => {
  const { data, error } = await admin.auth.admin.createUser({
    email: `ma-${run}@tablekit.test`,
    password: "integration-test-pw-1234",
    email_confirm: true,
  });
  if (error || !data.user) throw error ?? new Error("createUser failed");
  const userId = data.user.id;

  const [org] = await db
    .insert(schema.organisations)
    .values({ name: `MA ${run}`, slug: `ma-${run}` })
    .returning({ id: schema.organisations.id });
  await db.insert(schema.memberships).values({ userId, organisationId: org!.id, role: "owner" });

  const [venue] = await db
    .insert(schema.venues)
    .values({ organisationId: org!.id, name: "V", venueType: "restaurant" })
    .returning({ id: schema.venues.id });
  const [area] = await db
    .insert(schema.areas)
    .values({ organisationId: org!.id, venueId: venue!.id, name: "Inside" })
    .returning({ id: schema.areas.id });
  await db.insert(schema.services).values({
    organisationId: org!.id,
    venueId: venue!.id,
    name: "Dinner",
    schedule: { days: ["fri", "sat"], start: "18:00", end: "22:00" },
    turnMinutes: 90,
  });
  await db.insert(schema.venueTables).values({
    organisationId: org!.id,
    venueId: venue!.id,
    areaId: area!.id,
    label: "T1",
    maxCover: 4,
  });

  ctx = { userId, orgId: org!.id, venueId: venue!.id };
});

afterAll(async () => {
  if (ctx) {
    await admin.auth.admin.deleteUser(ctx.userId).catch(() => undefined);
    await db.delete(schema.organisations).where(eq(schema.organisations.id, ctx.orgId));
  }
  await pool.end();
});

describe("loadPublicMonthAvailability", () => {
  it("marks service days open and other days closed in a future month", async () => {
    const { loadPublicMonthAvailability } = await import("@/lib/public/venue");
    const m = await loadPublicMonthAvailability(
      { id: ctx.venueId, ...venuePub },
      { month: "2027-06", partySize: 2 },
    );
    expect(Object.keys(m.days).length).toBe(30);
    expect(Object.values(m.days)).not.toContain("past");
    for (const [ymd, status] of Object.entries(m.days)) {
      const dow = new Date(`${ymd}T12:00:00Z`).getUTCDay(); // 5=Fri, 6=Sat
      expect(status).toBe(dow === 5 || dow === 6 ? "open" : "closed");
    }
  });

  it("marks every day of a historical month past", async () => {
    const { loadPublicMonthAvailability } = await import("@/lib/public/venue");
    const m = await loadPublicMonthAvailability(
      { id: ctx.venueId, ...venuePub },
      { month: "2020-01", partySize: 2 },
    );
    expect(Object.keys(m.days).length).toBe(31);
    expect(Object.values(m.days).every((v) => v === "past")).toBe(true);
  });
});
