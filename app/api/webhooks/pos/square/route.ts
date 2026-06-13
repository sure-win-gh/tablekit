// POST /api/webhooks/pos/square — Square payment webhook.
//
// Thin wrapper: read the raw body (needed verbatim for HMAC), hand to
// handleSquareWebhook (verify → dedupe → normalise → ingest), map the
// outcome to a status. A bad signature is the only 4xx; everything else
// returns 200 so Square doesn't retry a no-op.
//
// PII: the body can carry a buyer email — never logged, never echoed. The
// handler persists via the encrypting ingest path and audits ids only.

import { NextResponse, type NextRequest } from "next/server";

import { handleSquareWebhook } from "@/lib/pos/square/webhook";
import { SQUARE_SIGNATURE_HEADER } from "@/lib/pos/square/verify";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAX_BODY_BYTES = 256 * 1024;

export async function POST(req: NextRequest) {
  const contentLength = req.headers.get("content-length");
  if (contentLength !== null && Number(contentLength) > MAX_BODY_BYTES) {
    return NextResponse.json({ error: "body-too-large" }, { status: 413 });
  }

  const rawBody = await req.text();
  if (rawBody.length > MAX_BODY_BYTES) {
    return NextResponse.json({ error: "body-too-large" }, { status: 413 });
  }

  const signatureHeader = req.headers.get(SQUARE_SIGNATURE_HEADER);
  const outcome = await handleSquareWebhook(rawBody, signatureHeader);
  return NextResponse.json({ result: outcome.result }, { status: outcome.status });
}
