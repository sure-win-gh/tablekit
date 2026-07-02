// Integration test for getApiHealth + getOperatorWebhookHealth.
//
// Seeds: one org with three API request-log rows (200 / 404 / 500)
// and one webhook subscription with a failed + a succeeded delivery.
// Asserts totals, error rates, latency percentiles, daily buckets,
// and the failing-endpoint rollup.

import { eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as schema from "@/lib/db/schema";
import {
  getApiHealth,
  getOperatorWebhookHealth,
} from "@/lib/server/admin/dashboard/metrics/api-health";

type Db = NodePgDatabase<typeof schema>;
const pool = new Pool({ connectionString: process.env["DATABASE_URL"] });
const db: Db = drizzle(pool, { schema });

const run = Date.now().toString(36);
let orgId: string;

beforeAll(async () => {
  const [org] = await db
    .insert(schema.organisations)
    .values({ name: `ApiHealth ${run}`, slug: `api-health-${run}` })
    .returning({ id: schema.organisations.id });
  orgId = org!.id;

  const [key] = await db
    .insert(schema.apiKeys)
    .values({ organisationId: orgId, prefix: `tk_${run}`, hash: `h_${run}`, label: "t" })
    .returning({ id: schema.apiKeys.id });

  await db.insert(schema.apiRequestLog).values([
    {
      organisationId: orgId,
      apiKeyId: key!.id,
      method: "GET",
      path: "/api/v1/bookings",
      status: 200,
      latencyMs: 40,
    },
    {
      organisationId: orgId,
      apiKeyId: key!.id,
      method: "GET",
      path: "/api/v1/bookings/nope",
      status: 404,
      latencyMs: 20,
    },
    {
      organisationId: orgId,
      apiKeyId: key!.id,
      method: "POST",
      path: "/api/v1/bookings",
      status: 500,
      latencyMs: 900,
    },
  ]);

  const [sub] = await db
    .insert(schema.webhookSubscriptions)
    .values({
      organisationId: orgId,
      url: "https://hooks.example.test/tablekit",
      label: `Zap ${run}`,
      secretCipher: "c",
      events: ["booking.created"],
    })
    .returning({ id: schema.webhookSubscriptions.id });

  await db.insert(schema.webhookDeliveries).values([
    {
      subscriptionId: sub!.id,
      organisationId: orgId,
      eventType: "booking.created",
      eventId: `evt_a_${run}`,
      payload: {},
      status: "succeeded",
    },
    {
      subscriptionId: sub!.id,
      organisationId: orgId,
      eventType: "booking.created",
      eventId: `evt_b_${run}`,
      payload: {},
      status: "failed",
      attempts: 5,
      lastError: "connect timeout",
    },
  ]);
});

afterAll(async () => {
  if (orgId) await db.delete(schema.organisations).where(eq(schema.organisations.id, orgId));
  await pool.end();
});

describe("getApiHealth", () => {
  it("counts requests, splits error classes, and reports latency", async () => {
    const api = await getApiHealth(db);

    expect(api.requests7d).toBeGreaterThanOrEqual(3);
    expect(api.serverErrors7d).toBeGreaterThanOrEqual(1);
    expect(api.clientErrors7d).toBeGreaterThanOrEqual(1);
    expect(api.errorRate7d).toBeGreaterThan(0);
    expect(api.p50LatencyMs).not.toBeNull();
    expect(api.p95LatencyMs).not.toBeNull();
    expect((api.p95LatencyMs ?? 0) >= (api.p50LatencyMs ?? 0)).toBe(true);

    // 15 buckets (14-day window is inclusive of today), gap-filled.
    expect(api.byDay.length).toBeGreaterThanOrEqual(14);
    expect(api.byDay.reduce((s, d) => s + d.n, 0)).toBeGreaterThanOrEqual(3);

    const top = api.topOrgs.find((o) => o.orgId === orgId);
    expect(top?.requests).toBeGreaterThanOrEqual(3);
    expect(top?.serverErrors).toBeGreaterThanOrEqual(1);
  });
});

describe("getOperatorWebhookHealth", () => {
  it("rolls up deliveries and surfaces the failing endpoint", async () => {
    const hooks = await getOperatorWebhookHealth(db);

    expect(hooks.activeSubscriptions).toBeGreaterThanOrEqual(1);
    expect(hooks.deliveries7d).toBeGreaterThanOrEqual(2);
    expect(hooks.failed7d).toBeGreaterThanOrEqual(1);

    const failing = hooks.failingEndpoints.find((e) => e.orgId === orgId);
    expect(failing?.failed7d).toBeGreaterThanOrEqual(1);
    expect(failing?.url).toContain("hooks.example.test");
  });
});
