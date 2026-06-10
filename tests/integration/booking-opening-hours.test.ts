// Integration test for loadPublicOpeningHours (booking-page Phase 4) — derives
// per-day opening windows from the venue's services.

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
let ctx: { userId: string; orgId: string; venueId: string };

beforeAll(async () => {
  const { data, error } = await admin.auth.admin.createUser({
    email: `oh-${run}@tablekit.test`,
    password: "integration-test-pw-1234",
    email_confirm: true,
  });
  if (error || !data.user) throw error ?? new Error("createUser failed");
  const userId = data.user.id;
  const [org] = await db
    .insert(schema.organisations)
    .values({ name: `OH ${run}`, slug: `oh-${run}` })
    .returning({ id: schema.organisations.id });
  await db.insert(schema.memberships).values({ userId, organisationId: org!.id, role: "owner" });
  const [venue] = await db
    .insert(schema.venues)
    .values({ organisationId: org!.id, name: "V", venueType: "restaurant" })
    .returning({ id: schema.venues.id });
  await db.insert(schema.services).values([
    {
      organisationId: org!.id,
      venueId: venue!.id,
      name: "Lunch",
      schedule: { days: ["mon", "tue", "wed", "thu", "fri"], start: "12:00", end: "14:30" },
      turnMinutes: 90,
    },
    {
      organisationId: org!.id,
      venueId: venue!.id,
      name: "Dinner",
      schedule: { days: ["fri", "sat"], start: "18:00", end: "22:00" },
      turnMinutes: 90,
    },
  ]);
  ctx = { userId, orgId: org!.id, venueId: venue!.id };
});

afterAll(async () => {
  if (ctx) {
    await admin.auth.admin.deleteUser(ctx.userId).catch(() => undefined);
    await db.delete(schema.organisations).where(eq(schema.organisations.id, ctx.orgId));
  }
  await pool.end();
});

describe("loadPublicOpeningHours", () => {
  it("aggregates service windows per day, Mon→Sun, closed where no service runs", async () => {
    const { loadPublicOpeningHours } = await import("@/lib/public/venue");
    const days = await loadPublicOpeningHours(ctx.venueId);
    expect(days.map((d) => d.key)).toEqual(["mon", "tue", "wed", "thu", "fri", "sat", "sun"]);

    const byKey = Object.fromEntries(days.map((d) => [d.key, d.windows]));
    expect(byKey["mon"]).toEqual([{ start: "12:00", end: "14:30" }]);
    // Friday has both lunch + dinner, sorted by start.
    expect(byKey["fri"]).toEqual([
      { start: "12:00", end: "14:30" },
      { start: "18:00", end: "22:00" },
    ]);
    expect(byKey["sat"]).toEqual([{ start: "18:00", end: "22:00" }]);
    expect(byKey["sun"]).toEqual([]); // closed
  });
});
