// Integration tests for the auto-finish sweeps (service-flow.md).
//
// Venue A (auto-finish on, service ends 23:59 so "closed" is never
// reached during the test run): a seated booking from YESTERDAY must
// be finished by both sweeps; a seated booking from TODAY that has
// merely lapsed its end time must be left alone by the venue sweep
// (the venue is still open — that's the prompt's job, not the sweep's).
// Venue B (auto-finish off): yesterday's seated booking is untouched.

import { eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as schema from "@/lib/db/schema";
import { sweepAllStaleSeated, sweepVenueStaleSeated } from "@/lib/bookings/finish-sweep";

type Db = NodePgDatabase<typeof schema>;
const pool = new Pool({ connectionString: process.env["DATABASE_URL"] });
const db: Db = drizzle(pool, { schema });

const run = Date.now().toString(36);
const TZ = "Europe/London";

type Ctx = {
  orgAId: string;
  orgBId: string;
  venueAId: string;
  venueBId: string;
  staleAId: string; // venue A, yesterday, seated → should finish
  todayAId: string; // venue A, today, lapsed but venue open → untouched
  staleBId: string; // venue B, yesterday, auto-finish off → untouched
};
let ctx: Ctx;

beforeAll(async () => {
  const mkOrg = async (label: string) => {
    const [o] = await db
      .insert(schema.organisations)
      .values({ name: `Sweep-${label} ${run}`, slug: `sweep-${label}-${run}` })
      .returning({ id: schema.organisations.id });
    return o!.id;
  };
  const orgAId = await mkOrg("a");
  const orgBId = await mkOrg("b");

  const mkVenue = async (orgId: string, settings: Record<string, unknown>) => {
    const [v] = await db
      .insert(schema.venues)
      .values({ organisationId: orgId, name: "V", venueType: "restaurant", timezone: TZ, settings })
      .returning({ id: schema.venues.id });
    return v!.id;
  };
  const venueAId = await mkVenue(orgAId, {});
  const venueBId = await mkVenue(orgBId, { serviceFlow: { autoFinishEnabled: false } });

  const schedule = {
    days: ["sun", "mon", "tue", "wed", "thu", "fri", "sat"],
    start: "09:00",
    // 23:59 → close + 60min grace can never pass during the test run,
    // so the "venue still open" branch is deterministic.
    end: "23:59",
  };
  const mkFixture = async (orgId: string, venueId: string) => {
    const [service] = await db
      .insert(schema.services)
      .values({ organisationId: orgId, venueId, name: "All day", schedule, turnMinutes: 90 })
      .returning({ id: schema.services.id });
    const [area] = await db
      .insert(schema.areas)
      .values({ organisationId: orgId, venueId, name: "Inside" })
      .returning({ id: schema.areas.id });
    const [guest] = await db
      .insert(schema.guests)
      .values({
        organisationId: orgId,
        firstName: "G",
        lastNameCipher: "c",
        emailCipher: "c",
        emailHash: `sweep_${venueId}_${run}`,
      })
      .returning({ id: schema.guests.id });
    return { serviceId: service!.id, areaId: area!.id, guestId: guest!.id };
  };
  const fxA = await mkFixture(orgAId, venueAId);
  const fxB = await mkFixture(orgBId, venueBId);

  const mkSeated = async (
    orgId: string,
    venueId: string,
    fx: { serviceId: string; areaId: string; guestId: string },
    startAt: Date,
    endAt: Date,
  ) => {
    const [b] = await db
      .insert(schema.bookings)
      .values({
        organisationId: orgId,
        venueId,
        serviceId: fx.serviceId,
        areaId: fx.areaId,
        guestId: fx.guestId,
        partySize: 2,
        startAt,
        endAt,
        status: "seated",
        source: "host",
      })
      .returning({ id: schema.bookings.id });
    return b!.id;
  };

  const now = Date.now();
  const H = 60 * 60 * 1000;
  // Yesterday evening — comfortably before today's venue-day start and
  // past the cron's 3h staleness threshold.
  const staleAId = await mkSeated(
    orgAId,
    venueAId,
    fxA,
    new Date(now - 26 * H),
    new Date(now - 24 * H),
  );
  const staleBId = await mkSeated(
    orgBId,
    venueBId,
    fxB,
    new Date(now - 26 * H),
    new Date(now - 24 * H),
  );
  // Today, recently ended — overdue but the venue is open. Clamped
  // inside the current venue-day so a suite run just after venue-local
  // midnight can't accidentally make this a "yesterday" booking.
  const { formatInTimeZone } = await import("date-fns-tz");
  const { zonedWallToUtc } = await import("@/lib/bookings/time");
  const todayYmd = formatInTimeZone(new Date(now), TZ, "yyyy-MM-dd");
  const startOfToday = zonedWallToUtc(todayYmd, "00:00", TZ).getTime();
  const todayEnd = Math.max(now - 5 * 60 * 1000, startOfToday + 60 * 1000);
  const todayAId = await mkSeated(
    orgAId,
    venueAId,
    fxA,
    new Date(Math.max(now - 2 * H, startOfToday)),
    new Date(todayEnd),
  );

  ctx = { orgAId, orgBId, venueAId, venueBId, staleAId, todayAId, staleBId };
});

afterAll(async () => {
  if (ctx) {
    await db.delete(schema.organisations).where(eq(schema.organisations.id, ctx.orgAId));
    await db.delete(schema.organisations).where(eq(schema.organisations.id, ctx.orgBId));
  }
  await pool.end();
});

async function statusOf(id: string): Promise<string> {
  const [row] = await db
    .select({ status: schema.bookings.status })
    .from(schema.bookings)
    .where(eq(schema.bookings.id, id));
  return row?.status ?? "missing";
}

describe("sweepVenueStaleSeated", () => {
  it("finishes yesterday's seated booking, leaves today's lapsed-but-open booking alone", async () => {
    const r = await sweepVenueStaleSeated(ctx.venueAId);
    expect(r.finished).toBeGreaterThanOrEqual(1);
    expect(await statusOf(ctx.staleAId)).toBe("finished");
    expect(await statusOf(ctx.todayAId)).toBe("seated");
  });

  it("writes a system (null actor) audit + booking event for the finish", async () => {
    const events = await db
      .select({ type: schema.bookingEvents.type, actorUserId: schema.bookingEvents.actorUserId })
      .from(schema.bookingEvents)
      .where(eq(schema.bookingEvents.bookingId, ctx.staleAId));
    const finish = events.find((e) => e.type === "status.finished");
    expect(finish).toBeDefined();
    expect(finish?.actorUserId).toBeNull();
  });

  it("respects autoFinishEnabled: false", async () => {
    const r = await sweepVenueStaleSeated(ctx.venueBId);
    expect(r.finished).toBe(0);
    expect(await statusOf(ctx.staleBId)).toBe("seated");
  });
});

describe("sweepAllStaleSeated", () => {
  it("cron backstop also respects the per-venue setting and skips fresh bookings", async () => {
    const r = await sweepAllStaleSeated();
    // staleA already finished above; staleB gated off; todayA is only
    // minutes past its end — under the 3h cron threshold.
    expect(r).toBeDefined();
    expect(await statusOf(ctx.staleBId)).toBe("seated");
    expect(await statusOf(ctx.todayAId)).toBe("seated");
  });
});
