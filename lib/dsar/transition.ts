// transitionDsarRequest — operator action on an existing request.
//
// Allowed transitions:
//   pending     → in_progress | rejected
//   in_progress → completed | rejected
//   completed/rejected → (terminal; no further transitions)
//
// `resolutionNotes` is plaintext (operator-authored). Setting status
// to a terminal state stamps `resolved_at`. The org-scope check is
// done explicitly here — adminDb bypasses RLS, so the action layer
// must verify the request belongs to the actor's org before we let
// the update through.

import "server-only";

import { and, eq, sql } from "drizzle-orm";

import { dsarRequests } from "@/lib/db/schema";
import { audit } from "@/lib/server/admin/audit";
import { adminDb } from "@/lib/server/admin/db";

export type DsarStatus = "pending" | "in_progress" | "completed" | "rejected";

const ALLOWED: Record<DsarStatus, DsarStatus[]> = {
  pending: ["in_progress", "rejected"],
  in_progress: ["completed", "rejected"],
  completed: [],
  rejected: [],
};

export type TransitionDsarInput = {
  organisationId: string;
  actorUserId: string;
  dsarId: string;
  to: DsarStatus;
  resolutionNotes?: string | undefined;
  // Operator-resolved guest match (when they identify the matching
  // profile after the fact). Optional — most flows leave it as the
  // create-time auto-match.
  guestId?: string | null | undefined;
};

export type TransitionDsarResult =
  | { ok: true; from: DsarStatus; to: DsarStatus }
  | { ok: false; reason: "not-found" | "wrong-org" | "invalid-transition"; from?: DsarStatus };

export async function transitionDsarRequest(
  input: TransitionDsarInput,
): Promise<TransitionDsarResult> {
  const db = adminDb();

  const [row] = await db
    .select({
      id: dsarRequests.id,
      organisationId: dsarRequests.organisationId,
      status: dsarRequests.status,
    })
    .from(dsarRequests)
    .where(eq(dsarRequests.id, input.dsarId))
    .limit(1);

  if (!row) return { ok: false, reason: "not-found" };
  if (row.organisationId !== input.organisationId) return { ok: false, reason: "wrong-org" };

  const from = row.status as DsarStatus;
  if (!ALLOWED[from].includes(input.to)) {
    return { ok: false, reason: "invalid-transition", from };
  }

  const isTerminal = input.to === "completed" || input.to === "rejected";

  await db
    .update(dsarRequests)
    .set({
      status: input.to,
      ...(input.resolutionNotes !== undefined ? { resolutionNotes: input.resolutionNotes } : {}),
      ...(input.guestId !== undefined ? { guestId: input.guestId } : {}),
      ...(isTerminal ? { resolvedAt: sql`now()` } : {}),
    })
    .where(
      and(
        eq(dsarRequests.id, input.dsarId),
        eq(dsarRequests.organisationId, input.organisationId),
      ),
    );

  // TS would otherwise widen the templated string; keep the union
  // explicit so the audit type stays exhaustive.
  const action =
    input.to === "in_progress"
      ? "dsar.in_progress"
      : input.to === "completed"
        ? "dsar.completed"
        : "dsar.rejected";
  await audit.log({
    organisationId: input.organisationId,
    actorUserId: input.actorUserId,
    action,
    targetType: "dsar_request",
    targetId: input.dsarId,
    metadata: { from, to: input.to },
  });

  return { ok: true, from, to: input.to };
}
