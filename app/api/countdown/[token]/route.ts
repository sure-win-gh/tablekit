// GET /api/countdown/<signed token> — the countdown block's image
// (marketing-suite Phase C). Verifies the HMAC token (target instant +
// campaign id only — no guest identifiers), renders the remaining time as
// a GIF at request time, and caches privately for 60s so opens stay
// current without re-rendering per pixel-fetch.

import { NextResponse, type NextRequest } from "next/server";

import { renderCountdownGif, verifyCountdown } from "@/lib/campaigns/countdown";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ token: string }> },
): Promise<Response> {
  const { token } = await params;
  const payload = verifyCountdown(token);
  if (!payload) return NextResponse.json({ error: "not-found" }, { status: 404 });

  const gif = renderCountdownGif(payload.targetMs, Date.now());
  return new Response(new Uint8Array(gif), {
    headers: {
      "content-type": "image/gif",
      "cache-control": "private, max-age=60",
    },
  });
}
