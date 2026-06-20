// Vercel Cron entry point for the password-reset token cleanup sweep.
//
// Hard-deletes password_reset_tokens rows that are used or expired and
// older than the 24h grace window. Tokens are inert after use/expiry
// regardless, so this is hygiene + data minimisation, not security.

import { NextResponse, type NextRequest } from "next/server";

import { sweepResetTokenRetention } from "@/lib/auth/password-reset";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const expected = process.env["CRON_SECRET"];
  if (!expected || expected.includes("YOUR_")) {
    return NextResponse.json({ error: "server-misconfigured" }, { status: 500 });
  }
  const auth = req.headers.get("authorization");
  if (auth !== `Bearer ${expected}`) {
    return NextResponse.json({ error: "unauthorised" }, { status: 401 });
  }

  const result = await sweepResetTokenRetention();
  return NextResponse.json({ ok: true, ...result });
}
