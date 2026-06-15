// POST /api/webhooks/pos/lightspeed — Lightspeed K-Series webhook.
// Thin wrapper around handleLightspeedWebhook. Disabled (503) unless the
// partner flag is on; bad signature -> 400; everything else -> 200.

import { NextResponse, type NextRequest } from "next/server";

import { LIGHTSPEED_SIGNATURE_HEADER } from "@/lib/pos/lightspeed/verify";
import { handleLightspeedWebhook } from "@/lib/pos/lightspeed/webhook";

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

  const signatureHeader = req.headers.get(LIGHTSPEED_SIGNATURE_HEADER);
  const outcome = await handleLightspeedWebhook(rawBody, signatureHeader);
  return NextResponse.json({ result: outcome.result }, { status: outcome.status });
}
