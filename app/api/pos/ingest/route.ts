// POST /api/pos/ingest — generic signed POS webhook.
//
// Headers:
//   X-TableKit-POS-Connection: <connectionId>   (which connection)
//   X-TableKit-POS-Signature: sha256=<hmac(secret, body)>
//
// Thin wrapper around handleGenericWebhook. Bad/absent signature -> 400;
// unknown connection -> 200 no-op. PII in the body (email/phone) is only
// ever persisted via the encrypting ingest path, never logged.

import { NextResponse, type NextRequest } from "next/server";

import { handleGenericWebhook } from "@/lib/pos/generic/webhook";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const CONNECTION_HEADER = "x-tablekit-pos-connection";
const SIGNATURE_HEADER = "x-tablekit-pos-signature";
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

  const outcome = await handleGenericWebhook({
    connectionId: req.headers.get(CONNECTION_HEADER),
    rawBody,
    signatureHeader: req.headers.get(SIGNATURE_HEADER),
  });
  return NextResponse.json({ result: outcome.result }, { status: outcome.status });
}
