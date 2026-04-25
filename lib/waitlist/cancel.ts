// Cancel or mark-left a waitlist entry. One-tap host action.
//
// 'cancelled' means host took them off; 'left' means guest gave up.
// Behaviour-wise we treat them the same internally — both close out
// the row — but the audit + analytics distinction matters.

import "server-only";

import { and, eq } from "drizzle-orm";

import { waitlists } from "@/lib/db/schema";
import { audit } from "@/lib/server/admin/audit";
import { adminDb } from "@/lib/server/admin/db";

export type CancelOutcome = "cancelled" | "left";

export type CancelWaitlistResult =
  | { ok: true }
  | { ok: false; reason: "not-found" | "wrong-status" };

export async function cancelWaitlist(
  organisationId: string,
  actorUserId: string,
  waitlistId: string,
  outcome: CancelOutcome = "cancelled",
): Promise<CancelWaitlistResult> {
  const db = adminDb();
  const updated = await db
    .update(waitlists)
    .set({ status: outcome, cancelledAt: new Date() })
    .where(
      and(
        eq(waitlists.id, waitlistId),
        eq(waitlists.organisationId, organisationId),
        eq(waitlists.status, "waiting"),
      ),
    )
    .returning({ id: waitlists.id, venueId: waitlists.venueId });

  if (updated.length === 0) {
    // Either the row doesn't exist for this org, or it's already in a
    // terminal status. Either way the action is a no-op for the
    // caller; differentiate so the dashboard can show the right toast.
    const [row] = await db
      .select({ id: waitlists.id })
      .from(waitlists)
      .where(and(eq(waitlists.id, waitlistId), eq(waitlists.organisationId, organisationId)))
      .limit(1);
    return { ok: false, reason: row ? "wrong-status" : "not-found" };
  }

  await audit.log({
    organisationId,
    actorUserId,
    action: outcome === "cancelled" ? "waitlist.cancelled" : "waitlist.left",
    targetType: "waitlist",
    targetId: waitlistId,
    metadata: { venueId: updated[0]!.venueId },
  });

  return { ok: true };
}
