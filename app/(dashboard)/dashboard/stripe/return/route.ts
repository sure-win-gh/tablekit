// Where Stripe lands the operator after hosted Connect onboarding.
//
// Query string:
//   ?status=complete — finished the flow (or as far as Stripe permits
//                       on this session; the account.updated webhook
//                       is the authoritative "charges enabled" signal)
//   ?status=refresh  — Stripe bailed (timed out / user closed / etc.)
//                      and wants a fresh account_link
//
// We refresh the DB row from Stripe in case the webhook hasn't landed
// yet, then redirect to the first venue's settings with a flash.

import { eq } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";

import { requireRole } from "@/lib/auth/require-role";
import { refreshAccountState } from "@/lib/stripe/connect";
import { withUser } from "@/lib/db/client";
import { venues } from "@/lib/db/schema";

export async function GET(req: NextRequest) {
  const { orgId } = await requireRole("host");
  const status = req.nextUrl.searchParams.get("status") ?? "complete";

  // Best-effort refresh. If Stripe is down or the row isn't there,
  // proceed to the redirect anyway so the operator isn't stuck.
  try {
    await refreshAccountState(orgId);
  } catch {
    // Swallow — the webhook will converge the row eventually.
  }

  // Redirect to the first venue's settings (single-venue orgs) or
  // to /dashboard otherwise. For multi-venue orgs we'll grow a proper
  // /dashboard/billing in the operator-subscriptions phase.
  const firstVenue = await withUser(async (db) => {
    const rows = await db
      .select({ id: venues.id })
      .from(venues)
      .where(eq(venues.organisationId, orgId))
      .limit(1);
    return rows[0];
  });

  const target = firstVenue
    ? `/dashboard/venues/${firstVenue.id}/settings?stripe=${encodeURIComponent(status)}`
    : `/dashboard?stripe=${encodeURIComponent(status)}`;

  return NextResponse.redirect(new URL(target, req.url));
}
