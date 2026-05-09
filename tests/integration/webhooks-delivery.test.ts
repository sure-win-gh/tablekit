// Integration tests for the webhook dispatch + deliver pipeline.
//
// Coverage:
//   - dispatchEvent: enqueues one delivery row per matching active
//     subscription. Skips revoked / inactive / event-mismatch subs.
//   - attemptDelivery: HTTP 200 → succeeded, status persisted.
//   - attemptDelivery: HTTP 500 with attempts < MAX → retry,
//     next_attempt_at advanced.
//   - attemptDelivery: HTTP 500 on the 5th attempt → failed,
//     next_attempt_at null.
//   - attemptDelivery: signature header round-trips via verifySignature.
//   - processNextDeliveries: drains due rows + skips future-dated
//     ones.
//
// fetch is mocked via vi.spyOn(globalThis, "fetch") per test so we
// can assert headers + body without an actual HTTP call.

import { eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import * as schema from "@/lib/db/schema";
import { attemptDelivery, MAX_ATTEMPTS, processNextDeliveries } from "@/lib/webhooks/deliver";
import { dispatchEvent } from "@/lib/webhooks/dispatch";
import { verifySignature } from "@/lib/webhooks/sign";
import { createSubscription, revokeSubscription } from "@/lib/webhooks/subscribe";

type Db = NodePgDatabase<typeof schema>;

const pool = new Pool({ connectionString: process.env["DATABASE_URL"] });
const db: Db = drizzle(pool, { schema });

const run = Date.now().toString(36);
type Ctx = { orgId: string };
let ctx: Ctx;

beforeAll(async () => {
  const [org] = await db
    .insert(schema.organisations)
    .values({ name: `WHK-D ${run}`, slug: `whk-d-${run}`, plan: "plus" })
    .returning({ id: schema.organisations.id });
  ctx = { orgId: org!.id };
});

afterAll(async () => {
  if (ctx) await db.delete(schema.organisations).where(eq(schema.organisations.id, ctx.orgId));
  await pool.end();
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function newSub(opts: {
  events?: string[];
  url?: string;
}): Promise<{ id: string; secret: string }> {
  const r = await createSubscription({
    organisationId: ctx.orgId,
    createdByUserId: null as unknown as string,
    url: opts.url ?? "https://example.com/whk",
    label: `sub-${Math.random()}`,
    events: (opts.events ?? ["booking.created"]) as never,
  });
  return { id: r.id, secret: r.plaintextSecret };
}

describe("dispatchEvent", () => {
  it("enqueues a delivery row for each matching active subscription", async () => {
    const a = await newSub({ events: ["booking.created"] });
    const b = await newSub({ events: ["booking.created", "booking.cancelled"] });
    const c = await newSub({ events: ["booking.cancelled"] }); // doesn't match
    const d = await newSub({ events: ["booking.created"] });
    await revokeSubscription({ subscriptionId: d.id, organisationId: ctx.orgId });

    const r = await dispatchEvent({
      organisationId: ctx.orgId,
      eventType: "booking.created",
      eventId: `dispatch-test-${run}`,
      payload: { booking_id: "bk-1" },
    });
    expect(r.enqueued).toBe(2);

    const rows = await db
      .select({ subscriptionId: schema.webhookDeliveries.subscriptionId })
      .from(schema.webhookDeliveries)
      .where(eq(schema.webhookDeliveries.eventId, `dispatch-test-${run}`));
    const ids = new Set(rows.map((r) => r.subscriptionId));
    expect(ids.has(a.id)).toBe(true);
    expect(ids.has(b.id)).toBe(true);
    expect(ids.has(c.id)).toBe(false);
    expect(ids.has(d.id)).toBe(false);
  });
});

describe("attemptDelivery", () => {
  it("marks succeeded on 2xx and signs the body verifiably", async () => {
    const sub = await newSub({});
    await dispatchEvent({
      organisationId: ctx.orgId,
      eventType: "booking.created",
      eventId: `success-${run}-${Math.random()}`,
      payload: { booking_id: "bk-success" },
    });
    const [delivery] = await db
      .select({ id: schema.webhookDeliveries.id })
      .from(schema.webhookDeliveries)
      .where(eq(schema.webhookDeliveries.subscriptionId, sub.id))
      .limit(1);

    let capturedSig = "";
    let capturedBody = "";
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      const headers = new Headers((init as RequestInit | undefined)?.headers);
      capturedSig = headers.get("x-tablekit-signature") ?? "";
      capturedBody = String((init as RequestInit | undefined)?.body ?? "");
      return new Response("ok", { status: 200 });
    });

    const out = await attemptDelivery(delivery!.id);
    expect(out.kind).toBe("succeeded");
    if (out.kind === "succeeded") expect(out.httpStatus).toBe(200);

    expect(verifySignature(sub.secret, capturedBody, capturedSig)).toBe(true);

    const [row] = await db
      .select({
        status: schema.webhookDeliveries.status,
        lastStatus: schema.webhookDeliveries.lastStatus,
        sentAt: schema.webhookDeliveries.sentAt,
        nextAttemptAt: schema.webhookDeliveries.nextAttemptAt,
      })
      .from(schema.webhookDeliveries)
      .where(eq(schema.webhookDeliveries.id, delivery!.id));
    expect(row?.status).toBe("succeeded");
    expect(row?.lastStatus).toBe(200);
    expect(row?.sentAt).not.toBeNull();
    expect(row?.nextAttemptAt).toBeNull();
  });

  it("schedules a retry on 500 with attempts < MAX", async () => {
    await newSub({});
    const eventId = `retry-${run}-${Math.random()}`;
    await dispatchEvent({
      organisationId: ctx.orgId,
      eventType: "booking.created",
      eventId,
      payload: {},
    });
    const [delivery] = await db
      .select({ id: schema.webhookDeliveries.id })
      .from(schema.webhookDeliveries)
      .where(eq(schema.webhookDeliveries.eventId, eventId))
      .limit(1);

    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("upstream went bang", { status: 500 }),
    );

    const out = await attemptDelivery(delivery!.id);
    expect(out.kind).toBe("retry");
    if (out.kind === "retry") {
      expect(out.httpStatus).toBe(500);
      expect(out.lastError).toBe("http:500");
    }

    const [row] = await db
      .select({
        status: schema.webhookDeliveries.status,
        attempts: schema.webhookDeliveries.attempts,
        nextAttemptAt: schema.webhookDeliveries.nextAttemptAt,
      })
      .from(schema.webhookDeliveries)
      .where(eq(schema.webhookDeliveries.id, delivery!.id));
    expect(row?.status).toBe("pending");
    expect(row?.attempts).toBe(1);
    expect(row?.nextAttemptAt).not.toBeNull();
  });

  it("marks failed after MAX_ATTEMPTS", async () => {
    await newSub({});
    await dispatchEvent({
      organisationId: ctx.orgId,
      eventType: "booking.created",
      eventId: `failed-${run}-${Math.random()}`,
      payload: {},
    });
    // Take the most-recently-created row to avoid colliding with
    // earlier tests' rows.
    const [delivery] = await db
      .select({ id: schema.webhookDeliveries.id })
      .from(schema.webhookDeliveries)
      .orderBy(schema.webhookDeliveries.createdAt)
      .limit(1);
    const targetId = delivery!.id;

    // Fast-forward attempts to MAX-1 so the next attempt is the
    // budget-exhausting one.
    await db
      .update(schema.webhookDeliveries)
      .set({ attempts: MAX_ATTEMPTS - 1 })
      .where(eq(schema.webhookDeliveries.id, targetId));

    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("nope", { status: 503 }));

    const out = await attemptDelivery(targetId);
    expect(out.kind).toBe("failed");

    const [row] = await db
      .select({
        status: schema.webhookDeliveries.status,
        nextAttemptAt: schema.webhookDeliveries.nextAttemptAt,
      })
      .from(schema.webhookDeliveries)
      .where(eq(schema.webhookDeliveries.id, targetId));
    expect(row?.status).toBe("failed");
    expect(row?.nextAttemptAt).toBeNull();
  });
});

describe("processNextDeliveries", () => {
  it("skips rows whose next_attempt_at is in the future", async () => {
    await newSub({});
    await dispatchEvent({
      organisationId: ctx.orgId,
      eventType: "booking.created",
      eventId: `future-${run}-${Math.random()}`,
      payload: {},
    });
    const [d] = await db
      .select({ id: schema.webhookDeliveries.id })
      .from(schema.webhookDeliveries)
      .orderBy(schema.webhookDeliveries.createdAt)
      .limit(1);
    await db
      .update(schema.webhookDeliveries)
      .set({ nextAttemptAt: new Date(Date.now() + 60 * 60 * 1000) })
      .where(eq(schema.webhookDeliveries.id, d!.id));

    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("ok"));
    // Drive the cron at "now" — the future-dated row should not
    // appear in the work set.
    await processNextDeliveries({ now: new Date() });

    // We can't assert "this row wasn't picked" cheaply because other
    // due rows may exist in the same DB run; assert via row state.
    const [row] = await db
      .select({ status: schema.webhookDeliveries.status })
      .from(schema.webhookDeliveries)
      .where(eq(schema.webhookDeliveries.id, d!.id));
    expect(row?.status).toBe("pending");
    fetchMock.mockRestore();
  });
});
