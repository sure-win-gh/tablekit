// Vercel Cron entry point for the sending-domain verification sweep.
//
// Scheduled daily by vercel.json. Re-polls Resend for any
// venue_sending_domains row still in a non-verified state — so an
// operator who pastes DNS records and walks away gets their domain
// flipped to verified the next morning without revisiting the
// dashboard.
//
// Slot rationale: ~5 minutes after the existing 4am batch finishes,
// so the cron sequence stays clustered (one DNS-friendly window) and
// the log dashboard stays tidy.
//
// Auth: shared CRON_SECRET as Bearer header, same pattern as the
// other cron routes in this folder.

import { NextResponse, type NextRequest } from "next/server";

import { sweepPendingSendingDomains } from "@/lib/email/verify-pending-domains";

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

  const result = await sweepPendingSendingDomains();
  return NextResponse.json({ ok: true, ...result });
}
