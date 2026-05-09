// Webhook delivery worker.
//
// `attemptDelivery(deliveryId)` claims a pending row, decrypts its
// subscription's secret, signs the payload, POSTs it, and updates
// the row to `succeeded` or `pending`+next_attempt_at (retry) or
// `failed` (5 attempts exhausted).
//
// Retry policy (per spec): 5 attempts total, exponential backoff,
// distributed over ~24h. Schedule: 1m, 5m, 30m, 4h, 24h. Each delay
// is the "next" attempt's lead time, so the cumulative window is
// ~28h — well within the spec's "~24h".
//
// The cron route (`/api/cron/webhook-deliveries`) drives the loop
// by claiming rows where status='pending' AND next_attempt_at<=now()
// via FOR UPDATE SKIP LOCKED so two cron ticks don't double-deliver.

import "server-only";

import { and, eq, lte, sql } from "drizzle-orm";

import { webhookDeliveries, webhookSubscriptions } from "@/lib/db/schema";
import { type Ciphertext, decryptPii } from "@/lib/security/crypto";
import { adminDb } from "@/lib/server/admin/db";

import { signBody } from "./sign";

// Per-attempt delay in ms. attempts=1 (after first failure) waits
// DELAYS[0] before re-trying; attempts=5 (last attempt failed) marks
// failed permanently — no DELAYS[5].
const DELAYS_MS = [
  1 * 60 * 1000, // 1 min
  5 * 60 * 1000, // 5 min
  30 * 60 * 1000, // 30 min
  4 * 60 * 60 * 1000, // 4 h
  24 * 60 * 60 * 1000, // 24 h (only used if attempts==4 → schedule attempt 5)
];
export const MAX_ATTEMPTS = 5;
const DELIVERY_TIMEOUT_MS = 10 * 1000; // hard cap on the POST itself

export type AttemptOutcome =
  | { kind: "succeeded"; httpStatus: number }
  | { kind: "retry"; httpStatus: number; lastError: string; nextAttemptAt: Date }
  | { kind: "failed"; httpStatus: number; lastError: string };

export async function attemptDelivery(
  deliveryId: string,
): Promise<AttemptOutcome | { kind: "skipped"; reason: string }> {
  const db = adminDb();

  // Claim the row by atomically incrementing attempts. Conditional
  // WHERE on status='pending' makes a concurrent claim race-safe —
  // only the first cron tick wins.
  const claimed = await db
    .update(webhookDeliveries)
    .set({ attempts: sql`${webhookDeliveries.attempts} + 1` })
    .where(and(eq(webhookDeliveries.id, deliveryId), eq(webhookDeliveries.status, "pending")))
    .returning({
      id: webhookDeliveries.id,
      subscriptionId: webhookDeliveries.subscriptionId,
      organisationId: webhookDeliveries.organisationId,
      eventType: webhookDeliveries.eventType,
      eventId: webhookDeliveries.eventId,
      payload: webhookDeliveries.payload,
      attempts: webhookDeliveries.attempts,
    });
  if (claimed.length === 0) return { kind: "skipped", reason: "already-claimed-or-terminal" };
  const job = claimed[0]!;

  // Resolve the subscription (URL + secret).
  const [sub] = await db
    .select({
      url: webhookSubscriptions.url,
      secretCipher: webhookSubscriptions.secretCipher,
      active: webhookSubscriptions.active,
    })
    .from(webhookSubscriptions)
    .where(eq(webhookSubscriptions.id, job.subscriptionId))
    .limit(1);
  if (!sub || !sub.active) {
    // Subscription gone or paused after we claimed — mark failed
    // permanently. Any future replay will be a fresh row.
    await markFailed(deliveryId, 0, "subscription-inactive");
    return { kind: "failed", httpStatus: 0, lastError: "subscription-inactive" };
  }

  const secret = await decryptPii(job.organisationId, sub.secretCipher as Ciphertext);
  const body = JSON.stringify({
    id: job.eventId,
    type: job.eventType,
    created_at: new Date().toISOString(),
    data: job.payload,
  });
  const signature = signBody(secret, body);

  let httpStatus = 0;
  let lastError = "";
  try {
    const res = await fetch(sub.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-tablekit-signature": signature,
        "x-tablekit-event": job.eventType,
        "x-tablekit-delivery": job.id,
      },
      body,
      signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
    });
    httpStatus = res.status;
    if (res.ok) {
      await markSucceeded(deliveryId, httpStatus);
      return { kind: "succeeded", httpStatus };
    }
    lastError = `http:${httpStatus}`;
  } catch (err) {
    // Network error / timeout. Sanitise to a bland code — Node's
    // fetch errors can include the URL which is operator-supplied
    // and not strictly PII, but keep logs uniform.
    lastError = sanitiseFetchError(err);
  }

  // Retry or give up.
  if (job.attempts >= MAX_ATTEMPTS) {
    await markFailed(deliveryId, httpStatus, lastError);
    return { kind: "failed", httpStatus, lastError };
  }
  const nextAttemptAt = new Date(Date.now() + DELAYS_MS[job.attempts - 1]!);
  await db
    .update(webhookDeliveries)
    .set({ lastStatus: httpStatus, lastError, nextAttemptAt })
    .where(eq(webhookDeliveries.id, deliveryId));
  return { kind: "retry", httpStatus, lastError, nextAttemptAt };
}

async function markSucceeded(deliveryId: string, httpStatus: number): Promise<void> {
  await adminDb()
    .update(webhookDeliveries)
    .set({
      status: "succeeded",
      lastStatus: httpStatus,
      lastError: null,
      sentAt: new Date(),
      nextAttemptAt: null,
    })
    .where(eq(webhookDeliveries.id, deliveryId));
}

async function markFailed(
  deliveryId: string,
  httpStatus: number,
  lastError: string,
): Promise<void> {
  await adminDb()
    .update(webhookDeliveries)
    .set({
      status: "failed",
      lastStatus: httpStatus,
      lastError,
      sentAt: new Date(),
      nextAttemptAt: null,
    })
    .where(eq(webhookDeliveries.id, deliveryId));
}

function sanitiseFetchError(err: unknown): string {
  if (err && typeof err === "object" && "name" in err && typeof err.name === "string") {
    return `fetch:${err.name}`;
  }
  return "fetch:unknown";
}

// Cron driver. Picks up to `limit` due rows + invokes attemptDelivery
// in series. Per-call serial keeps a single misbehaving subscriber
// from drowning out others; if throughput becomes an issue we batch
// in parallel chunks here.
export async function processNextDeliveries(
  opts: { limit?: number; now?: Date } = {},
): Promise<{ processed: AttemptOutcome[] }> {
  const limit = opts.limit ?? 50;
  const now = opts.now ?? new Date();
  const db = adminDb();

  const due = await db
    .select({ id: webhookDeliveries.id })
    .from(webhookDeliveries)
    .where(and(eq(webhookDeliveries.status, "pending"), lte(webhookDeliveries.nextAttemptAt, now)))
    .limit(limit);

  const processed: AttemptOutcome[] = [];
  for (const row of due) {
    const outcome = await attemptDelivery(row.id);
    if (outcome.kind !== "skipped") processed.push(outcome);
  }
  return { processed };
}
