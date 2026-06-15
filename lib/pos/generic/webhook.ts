// Generic signed-webhook ingest. Any till that can POST signed JSON can push
// orders here without a bespoke connector. The connection is identified by a
// header; the body is HMAC-signed with that connection's webhook secret
// (X-TableKit-POS-Signature: sha256=<hex>) — the inverse of our outbound
// webhook signing (lib/webhooks/sign.ts).
//
// Identified-and-verified → normalise → ingest (upsert is idempotent on
// connection+external_order_id, so a resend updates rather than duplicates).

import "server-only";

import { loadPosConnectionSecrets } from "@/lib/pos/connection";
import { ingestOrder } from "@/lib/pos/ingest";
import { loadIngestContextByConnectionId } from "@/lib/pos/ingest-context";
import { verifySignature } from "@/lib/webhooks/sign";

import { buildGenericOrder, type GenericOrderInput } from "./normalise";

export type GenericWebhookOutcome = {
  status: number;
  result: "ingested" | "ignored" | "no-connection" | "bad-signature" | "bad-request";
};

export async function handleGenericWebhook(params: {
  connectionId: string | null;
  rawBody: string;
  signatureHeader: string | null;
}): Promise<GenericWebhookOutcome> {
  const { connectionId, rawBody, signatureHeader } = params;
  if (!connectionId) return { status: 400, result: "bad-request" };
  if (!signatureHeader) return { status: 400, result: "bad-signature" };

  const ctx = await loadIngestContextByConnectionId(connectionId);
  if (!ctx || ctx.provider !== "generic" || ctx.status !== "active") {
    return { status: 200, result: "no-connection" };
  }

  const secrets = await loadPosConnectionSecrets(connectionId);
  if (!secrets?.webhookSecret) return { status: 400, result: "bad-signature" };
  if (!verifySignature(secrets.webhookSecret, rawBody, signatureHeader)) {
    return { status: 400, result: "bad-signature" };
  }

  let parsed: GenericOrderInput;
  try {
    parsed = JSON.parse(rawBody) as GenericOrderInput;
  } catch {
    return { status: 400, result: "bad-request" };
  }

  const built = buildGenericOrder(parsed);
  if (!built.ok) return { status: 400, result: "bad-request" };

  await ingestOrder({
    connectionId: ctx.connectionId,
    organisationId: ctx.organisationId,
    venueId: ctx.venueId,
    lineItemsEnabled: ctx.lineItemsEnabled,
    groupCrmEnabled: ctx.groupCrmEnabled,
    order: built.order,
  });

  return { status: 200, result: "ingested" };
}
