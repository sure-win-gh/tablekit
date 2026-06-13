// Lightspeed webhook processing — gate → verify → dedupe → normalise →
// ingest. Mirrors the Square handler but is disabled unless the partner
// flag is on, and verifies against the per-connection webhook secret.

import "server-only";

import { loadPosConnectionSecrets } from "@/lib/pos/connection";
import { ingestOrder } from "@/lib/pos/ingest";
import { loadIngestContextByAccount } from "@/lib/pos/ingest-context";
import { claimPosWebhookEvent, markPosWebhookProcessed } from "@/lib/pos/webhook-dedupe";

import { isLightspeedEnabled } from "./oauth";
import {
  isSettledAccountEvent,
  normaliseLightspeedAccount,
  type LightspeedEvent,
} from "./normalise";
import { verifyLightspeedSignature } from "./verify";

export type LightspeedWebhookOutcome = {
  status: number;
  result:
    | "ingested"
    | "duplicate"
    | "ignored"
    | "no-connection"
    | "bad-signature"
    | "bad-request"
    | "disabled";
};

export async function handleLightspeedWebhook(
  rawBody: string,
  signatureHeader: string | null,
): Promise<LightspeedWebhookOutcome> {
  // Partner gate — off by default until Lightspeed approval lands.
  if (!isLightspeedEnabled()) {
    return { status: 503, result: "disabled" };
  }

  let event: LightspeedEvent;
  try {
    event = JSON.parse(rawBody) as LightspeedEvent;
  } catch {
    return { status: 400, result: "bad-request" };
  }

  const businessId = event.business_id;
  const eventId = event.event_id;
  const account = event.account;
  if (!isSettledAccountEvent(event) || !account || !businessId || !eventId) {
    return { status: 200, result: "ignored" };
  }

  const ctx = await loadIngestContextByAccount("lightspeed_k", businessId);
  if (!ctx || ctx.status !== "active") {
    return { status: 200, result: "no-connection" };
  }

  // Verify against the connection's stored webhook secret.
  const secrets = await loadPosConnectionSecrets(ctx.connectionId);
  if (!secrets?.webhookSecret) {
    return { status: 400, result: "bad-signature" };
  }
  if (!verifyLightspeedSignature({ signatureHeader, secret: secrets.webhookSecret, rawBody })) {
    return { status: 400, result: "bad-signature" };
  }

  const claim = await claimPosWebhookEvent({
    organisationId: ctx.organisationId,
    connectionId: ctx.connectionId,
    provider: "lightspeed_k",
    externalEventId: eventId,
  });
  if (claim.status === "duplicate") return { status: 200, result: "duplicate" };

  const normalised = normaliseLightspeedAccount(account, ctx.lineItemsEnabled);
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
