// Vercel Cron entry point for the outreach unclaimed-orgs purge.
//
// Scheduled at 55 4 * * * by vercel.json — last of the nightly
// sequence (after sending-domain-verify) so it doesn't fight any of
// the others for connections. See lib/outreach/purge-unclaimed.ts
// for the rationale, scope, and audit posture.

import { NextResponse, type NextRequest } from "next/server";

import { purgeUnclaimedOutreach } from "@/lib/outreach/purge-unclaimed";

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

  const result = await purgeUnclaimedOutreach();
  console.log(`purge-unclaimed-outreach: deleted ${result.deleted} (cutoff ${result.cutoff})`);
  return NextResponse.json({ ok: true, ...result });
}
