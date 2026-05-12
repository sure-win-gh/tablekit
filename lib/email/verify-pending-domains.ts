// Daily sweep that re-checks `venue_sending_domains` rows still
// awaiting verification at Resend.
//
// Lifecycle:
//   • Operator clicks "Add domain" → row inserted with status='pending'.
//   • Operator pastes DNS records.
//   • DNS propagates (minutes to hours).
//   • This sweep notices + flips status='verified', stamps verifiedAt,
//     writes audit.
//
// Without this, operators who paste records and walk away would stay
// on 'pending' until they revisit the settings page and click
// "Verify now". The cron is the polite alternative.
//
// Scoping:
//   • Only rows with status IN ('pending','not_started','temporary_failure')
//     are re-checked. 'verified' rows are skipped (already done);
//     'failure' rows are skipped (operator action needed — they pasted
//     bad records or removed them).
//   • Rows older than 14 days that haven't verified are abandoned — by
//     that point either the operator has given up or there's a stuck
//     misconfiguration that polling can't resolve.
//   • Up to 100 rows per run so we don't fan out a Resend-API burst.
//
// Errors are sanitised + swallowed per row — a single bad row never
// blocks the rest of the sweep.

import "server-only";

import { and, eq, gt, inArray } from "drizzle-orm";

import { venueSendingDomains } from "@/lib/db/schema";
import { verifyDomain } from "@/lib/email/sending-domains";
import { adminDb } from "@/lib/server/admin/db";
import { audit } from "@/lib/server/admin/audit";

const SWEEP_BATCH = 100;
const MAX_AGE_DAYS = 14;

const ELIGIBLE_STATUSES = ["pending", "not_started", "temporary_failure"] as const;

export type SweepResult = {
  scanned: number;
  verified: number;
  unchanged: number;
  errored: number;
};

export async function sweepPendingSendingDomains(): Promise<SweepResult> {
  const db = adminDb();
  const cutoff = new Date(Date.now() - MAX_AGE_DAYS * 24 * 60 * 60 * 1000);

  const rows = await db
    .select({
      id: venueSendingDomains.id,
      organisationId: venueSendingDomains.organisationId,
      venueId: venueSendingDomains.venueId,
      resendDomainId: venueSendingDomains.resendDomainId,
    })
    .from(venueSendingDomains)
    .where(
      and(
        inArray(venueSendingDomains.status, [...ELIGIBLE_STATUSES]),
        gt(venueSendingDomains.createdAt, cutoff),
      ),
    )
    .limit(SWEEP_BATCH);

  let verified = 0;
  let unchanged = 0;
  let errored = 0;

  for (const row of rows) {
    try {
      const updated = await verifyDomain(row.resendDomainId);
      if (!updated) {
        // Resend no longer has the row — drop locally so the operator
        // can re-add.
        await db.delete(venueSendingDomains).where(eq(venueSendingDomains.id, row.id));
        unchanged++;
        continue;
      }

      const now = new Date();
      const isVerified = updated.status === "verified";
      await db
        .update(venueSendingDomains)
        .set({
          status: updated.status,
          dnsRecords: updated.records,
          lastCheckedAt: now,
          verifiedAt: isVerified ? now : null,
        })
        .where(eq(venueSendingDomains.id, row.id));

      if (isVerified) {
        verified++;
        await audit.log({
          organisationId: row.organisationId,
          action: "enquiry.sending_domain.verified",
          targetType: "venue",
          targetId: row.venueId,
          metadata: { domain: updated.name, source: "cron" },
        });
      } else {
        unchanged++;
      }
    } catch {
      // Bump lastCheckedAt so the next run doesn't immediately
      // re-hammer a row that just errored — gives Resend / DNS a tick
      // to settle. Error class is already sanitised at the wrapper.
      await db
        .update(venueSendingDomains)
        .set({ lastCheckedAt: new Date() })
        .where(eq(venueSendingDomains.id, row.id))
        .catch(() => undefined);
      errored++;
    }
  }

  return {
    scanned: rows.length,
    verified,
    unchanged,
    errored,
  };
}
