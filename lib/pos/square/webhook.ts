// Square webhook processing — verify → dedupe → normalise → ingest.
//
// Extracted from the route so it's unit-testable with a crafted signed
// body. Returns a status + a short non-PII result tag; the route maps that
// to an HTTP response. Drop-and-200 for "not for us" conditions (unknown
// merchant, non-payment event, duplicate) so Square doesn't retry a no-op;
// only a bad signature is a 400.

import "server-only";

import { ingestOrder } from "@/lib/pos/ingest";
import { loadIngestContextByAccount } from "@/lib/pos/ingest-context";
import { loadPosConnectionSecrets } from "@/lib/pos/connection";
import { claimPosWebhookEvent, markPosWebhookProcessed } from "@/lib/pos/webhook-dedupe";

import { fetchSquareOrder } from "./oauth";
import {
  isCompletedPaymentEvent,
  normaliseSquarePayment,
  type SquareWebhookEvent,
} from "./normalise";
import { squareNotificationUrl, squareSignatureKey, verifySquareSignature } from "./verify";

export type SquareWebhookOutcome = {
  status: number;
  result:
    | "ingested"
    | "duplicate"
    | "ignored"
    | "no-connection"
    | "bad-signature"
    | "bad-request"
    | "not-configured";
};

export async function handleSquareWebhook(
  rawBody: string,
  signatureHeader: string | null,
): Promise<SquareWebhookOutcome> {
  const signatureKey = squareSignatureKey();
  const notificationUrl = squareNotificationUrl();
  if (!signatureKey || !notificationUrl) {
    return { status: 503, result: "not-configured" };
  }

  if (!verifySquareSignature({ signatureHeader, signatureKey, notificationUrl, rawBody })) {
    return { status: 400, result: "bad-signature" };
  }

  let event: SquareWebhookEvent;
  try {
    event = JSON.parse(rawBody) as SquareWebhookEvent;
  } catch {
    return { status: 400, result: "bad-request" };
  }

  const payment = event.data?.object?.payment;
  const merchantId = event.merchant_id;
  const eventId = event.event_id;
  if (!isCompletedPaymentEvent(event) || !payment || !merchantId || !eventId) {
    return { status: 200, result: "ignored" };
  }

  const ctx = await loadIngestContextByAccount("square", merchantId);
  if (!ctx || ctx.status !== "active") {
    return { status: 200, result: "no-connection" };
  }

  // Idempotency claim. A true duplicate (already processed) short-circuits;
  // a claimed-but-unprocessed event (prior crash) is recovered + re-ingested.
  const claim = await claimPosWebhookEvent({
    organisationId: ctx.organisationId,
    connectionId: ctx.connectionId,
    provider: "square",
    externalEventId: eventId,
  });
  if (claim.status === "duplicate") return { status: 200, result: "duplicate" };

  // Only fetch the parent order (line items / tax) when the connection has
  // opted in to itemisation (Art. 9 gate, already AND'd with
  // art9_basis_confirmed_at) — otherwise totals come straight from the payment.
  let order = null;
  if (ctx.lineItemsEnabled && payment.order_id) {
    const secrets = await loadPosConnectionSecrets(ctx.connectionId);
    if (secrets?.accessToken) {
      order = await fetchSquareOrder(secrets.accessToken, payment.order_id);
    }
  }

  const normalised = normaliseSquarePayment(payment, order);
  await ingestOrder({
    connectionId: ctx.connectionId,
    organisationId: ctx.organisationId,
    venueId: ctx.venueId,
    lineItemsEnabled: ctx.lineItemsEnabled,
    groupCrmEnabled: ctx.groupCrmEnabled,
    order: normalised,
  });

  await markPosWebhookProcessed(claim.eventRowId);
  return { status: 200, result: "ingested" };
}
