// Audit log writer.
//
// The only sanctioned way to write into public.audit_log. Uses adminDb()
// because RLS denies INSERT on audit_log for the authenticated role —
// writes must succeed regardless of caller (we want to capture failed
// auth attempts and system-initiated actions too).
//
// Retention: 2 years per docs/playbooks/gdpr.md. Cleanup lands as a
// scheduled job in a later phase.
//
// Action names are free-text strings; keep them short and dotted
// (`signup`, `invite.created`, `role.changed`). The `audit_log`
// index on (organisation_id, created_at desc) makes org-scoped
// chronological reads cheap; action-filtering is a sequential scan
// today, which is fine until volumes warrant it.

import "server-only";

import { auditLog } from "../../db/schema";
import { adminDb } from "./db";

export type AuditAction =
  // auth phase
  | "signup"
  | "login.success"
  | "login.failure"
  // venues phase
  | "venue.created"
  | "venue.updated"
  | "venue.deleted"
  // guests-minimal phase
  | "guest.created"
  | "guest.reused"
  | "guest.updated"
  // bookings phase
  | "booking.created"
  | "booking.transitioned"
  // payments-connect phase
  | "stripe.connect.started"
  | "stripe.account.updated"
  | "stripe.webhook.received"
  | "stripe.webhook.failed"
  // payments-deposits phase
  | "deposit_rule.created"
  | "deposit_rule.updated"
  | "deposit_rule.deleted"
  | "stripe.intent.created"
  | "stripe.intent.succeeded"
  | "stripe.intent.failed"
  | "stripe.refund.created"
  | "stripe.refund.succeeded"
  | "booking.deposit.requested"
  | "booking.deposit.abandoned"
  // follow-up phases (listed so TS flags unknown strings early)
  | "invite.created"
  | "invite.accepted"
  | "role.changed"
  | "mfa.enrolled"
  | "mfa.disabled";

export type AuditTargetType =
  | "user"
  | "membership"
  | "organisation"
  | "invitation"
  | "venue"
  | "guest"
  | "booking"
  | "stripe_account"
  | "deposit_rule"
  | "payment";

export type AuditInput = {
  organisationId: string;
  action: AuditAction;
  actorUserId?: string | null | undefined;
  targetType?: AuditTargetType | null | undefined;
  targetId?: string | null | undefined;
  metadata?: Record<string, unknown> | undefined;
};

export const audit = {
  async log(input: AuditInput): Promise<void> {
    await adminDb()
      .insert(auditLog)
      .values({
        organisationId: input.organisationId,
        action: input.action,
        actorUserId: input.actorUserId ?? null,
        targetType: input.targetType ?? null,
        targetId: input.targetId ?? null,
        metadata: input.metadata ?? {},
      });
  },
};
