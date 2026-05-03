// Domain logic for operator actions on the enquiry inbox.
//
// Two layers:
//   - `decide*` helpers: pure rules. Take the current row state +
//     action context, return the next state OR a typed rejection.
//   - `apply*` helpers: take an admin-DB handle + ids, fetch the row,
//     consult the matching `decide*`, and run the write with a
//     status-conditional WHERE. The conditional WHERE makes the apply
//     functions safe under concurrent calls — only the first
//     matching write lands.
//
// Server actions wrap these with auth (requireRole + requirePlan +
// assertVenueVisible). Integration tests exercise the apply helpers
// directly so we can cover the SQL behaviour without standing up a
// real Supabase session.

import { and, eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import * as schema from "@/lib/db/schema";
import { enquiries } from "@/lib/db/schema";

import type { EnquiryStatus } from "./types";

type AdminDb = NodePgDatabase<typeof schema>;

// Stale window for "reset orphaned parsing". Workers normally finish
// in under 30s; anything older than this is almost certainly a
// crashed worker. Conservative — re-running a parse costs Bedrock
// tokens but is otherwise safe (idempotent on the runner side).
export const ORPHAN_PARSING_STALE_MS = 5 * 60 * 1000;

export type ActionRejection =
  | { reason: "wrong-status"; current: EnquiryStatus }
  | { reason: "no-draft" }
  | { reason: "not-stale-enough"; ageMs: number };

export type ActionDecision<TNext> =
  | { ok: true; next: TNext }
  | { ok: false; rejection: ActionRejection };

// ---------------------------------------------------------------------------
// Send draft. `draft_ready` only — once sent we transition to `replied`.
// ---------------------------------------------------------------------------

export type SendDraftNext = {
  status: "replied";
  repliedAt: Date;
};

export function decideSendDraft(input: {
  status: EnquiryStatus;
  hasDraft: boolean;
  now: Date;
}): ActionDecision<SendDraftNext> {
  if (input.status !== "draft_ready") {
    return { ok: false, rejection: { reason: "wrong-status", current: input.status } };
  }
  if (!input.hasDraft) {
    return { ok: false, rejection: { reason: "no-draft" } };
  }
  return { ok: true, next: { status: "replied", repliedAt: input.now } };
}

// ---------------------------------------------------------------------------
// Dismiss. Operator escape hatch for "this isn't worth a reply" — e.g.
// auto-replies, marketing, confused emails the parser couldn't tell
// weren't booking requests. Allowed from any non-terminal status; not
// from `replied` (already sent — undo would be misleading).
// ---------------------------------------------------------------------------

export type DismissNext = { status: "discarded" };

export function decideDismiss(input: { status: EnquiryStatus }): ActionDecision<DismissNext> {
  const allowed: ReadonlyArray<EnquiryStatus> = ["received", "parsing", "draft_ready", "failed"];
  if (!allowed.includes(input.status)) {
    return { ok: false, rejection: { reason: "wrong-status", current: input.status } };
  }
  return { ok: true, next: { status: "discarded" } };
}

// ---------------------------------------------------------------------------
// Reset orphaned `parsing`. The runner crashed mid-claim; row is
// stuck. Only allowed if the row has been in `parsing` for longer
// than ORPHAN_PARSING_STALE_MS — guards against stomping a live
// worker that's still processing.
// ---------------------------------------------------------------------------

export type ResetOrphanNext = { status: "received" };

export function decideResetOrphan(input: {
  status: EnquiryStatus;
  updatedAt: Date;
  now: Date;
}): ActionDecision<ResetOrphanNext> {
  if (input.status !== "parsing") {
    return { ok: false, rejection: { reason: "wrong-status", current: input.status } };
  }
  const ageMs = input.now.getTime() - input.updatedAt.getTime();
  if (ageMs < ORPHAN_PARSING_STALE_MS) {
    return { ok: false, rejection: { reason: "not-stale-enough", ageMs } };
  }
  return { ok: true, next: { status: "received" } };
}

// ---------------------------------------------------------------------------
// Retry from failed. Rare: a permanent error that the operator wants
// the cron to re-attempt (e.g. after a fix landed). Resets the attempt
// counter and clears the error so the runner doesn't trip the budget.
// ---------------------------------------------------------------------------

export type RetryFailedNext = {
  status: "received";
  parseAttempts: 0;
  error: null;
};

export function decideRetryFailed(input: {
  status: EnquiryStatus;
}): ActionDecision<RetryFailedNext> {
  if (input.status !== "failed") {
    return { ok: false, rejection: { reason: "wrong-status", current: input.status } };
  }
  return {
    ok: true,
    next: { status: "received", parseAttempts: 0, error: null },
  };
}

// ---------------------------------------------------------------------------
// Apply helpers — DB-side. Each fetches the row scoped to its venueId
// (defence-in-depth: the action already asserted the venue is visible
// to the caller), runs the matching `decide*`, and writes with a
// status-conditional WHERE so a concurrent action can't double-fire.
// ---------------------------------------------------------------------------

export type ApplyResult =
  | { ok: true }
  | { ok: false; reason: ActionRejection["reason"]; current?: EnquiryStatus; ageMs?: number }
  | { ok: false; reason: "not-found" };

export async function applyDismiss(
  db: AdminDb,
  args: { enquiryId: string; venueId: string },
): Promise<ApplyResult> {
  const [row] = await db
    .select({ status: enquiries.status })
    .from(enquiries)
    .where(and(eq(enquiries.id, args.enquiryId), eq(enquiries.venueId, args.venueId)))
    .limit(1);
  if (!row) return { ok: false, reason: "not-found" };
  const decision = decideDismiss({ status: row.status as EnquiryStatus });
  if (!decision.ok) {
    return rejectionToApplyResult(decision.rejection);
  }
  await db
    .update(enquiries)
    .set({ status: "discarded" })
    .where(and(eq(enquiries.id, args.enquiryId), eq(enquiries.venueId, args.venueId)));
  return { ok: true };
}

export async function applyResetOrphan(
  db: AdminDb,
  args: { enquiryId: string; venueId: string; now: Date },
): Promise<ApplyResult> {
  const [row] = await db
    .select({ status: enquiries.status, updatedAt: enquiries.updatedAt })
    .from(enquiries)
    .where(and(eq(enquiries.id, args.enquiryId), eq(enquiries.venueId, args.venueId)))
    .limit(1);
  if (!row) return { ok: false, reason: "not-found" };
  const decision = decideResetOrphan({
    status: row.status as EnquiryStatus,
    updatedAt: row.updatedAt,
    now: args.now,
  });
  if (!decision.ok) return rejectionToApplyResult(decision.rejection);
  await db
    .update(enquiries)
    .set({ status: "received" })
    .where(
      and(
        eq(enquiries.id, args.enquiryId),
        eq(enquiries.venueId, args.venueId),
        eq(enquiries.status, "parsing"),
      ),
    );
  return { ok: true };
}

export async function applyRetryFailed(
  db: AdminDb,
  args: { enquiryId: string; venueId: string },
): Promise<ApplyResult> {
  const [row] = await db
    .select({ status: enquiries.status })
    .from(enquiries)
    .where(and(eq(enquiries.id, args.enquiryId), eq(enquiries.venueId, args.venueId)))
    .limit(1);
  if (!row) return { ok: false, reason: "not-found" };
  const decision = decideRetryFailed({ status: row.status as EnquiryStatus });
  if (!decision.ok) return rejectionToApplyResult(decision.rejection);
  await db
    .update(enquiries)
    .set({ status: "received", parseAttempts: 0, error: null })
    .where(
      and(
        eq(enquiries.id, args.enquiryId),
        eq(enquiries.venueId, args.venueId),
        eq(enquiries.status, "failed"),
      ),
    );
  return { ok: true };
}

// Conditional flip from draft_ready → replied. The action layer
// runs this AFTER the Resend send has succeeded, so the ciphertext
// passed in reflects what actually went out (not the original
// drafted body). The status WHERE makes a double-call safe: the
// second one is a no-op.
export async function applySendDraftPostSend(
  db: AdminDb,
  args: {
    enquiryId: string;
    venueId: string;
    finalBodyCipher: string;
    repliedAt: Date;
  },
): Promise<{ rowsAffected: number }> {
  const updated = await db
    .update(enquiries)
    .set({
      status: "replied",
      repliedAt: args.repliedAt,
      draftReplyCipher: args.finalBodyCipher,
    })
    .where(
      and(
        eq(enquiries.id, args.enquiryId),
        eq(enquiries.venueId, args.venueId),
        eq(enquiries.status, "draft_ready"),
      ),
    )
    .returning({ id: enquiries.id });
  return { rowsAffected: updated.length };
}

function rejectionToApplyResult(r: ActionRejection): ApplyResult {
  switch (r.reason) {
    case "wrong-status":
      return { ok: false, reason: "wrong-status", current: r.current };
    case "no-draft":
      return { ok: false, reason: "no-draft" };
    case "not-stale-enough":
      return { ok: false, reason: "not-stale-enough", ageMs: r.ageMs };
  }
}
