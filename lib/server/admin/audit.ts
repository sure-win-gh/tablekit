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
  | "guest.contact_updated"
  | "guest.consent.email.on"
  | "guest.consent.email.off"
  | "guest.consent.sms.on"
  | "guest.consent.sms.off"
  | "guest.erasure_requested"
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
  // payments-card-hold phase (phase 2 — flow B)
  | "stripe.setup_intent.created"
  | "stripe.setup_intent.succeeded"
  | "stripe.setup_intent.failed"
  | "stripe.no_show_capture.succeeded"
  | "stripe.no_show_capture.failed"
  | "booking.no_show.captured"
  // messaging phase
  | "message.queued"
  | "message.sent"
  | "message.failed"
  | "message.bounced"
  | "guest.unsubscribed"
  | "guest.contact_invalidated"
  // reviews phase
  | "review.submitted"
  | "review.responded"
  | "review.escalated"
  | "review.recovery_sent"
  // oauth (Phase 3a/3c — Google Business Profile)
  | "oauth.connected"
  | "oauth.disconnected"
  | "oauth.location_picked"
  // waitlist phase
  | "waitlist.added"
  | "waitlist.seated"
  | "waitlist.cancelled"
  | "waitlist.left"
  // dsar phase
  | "dsar.created"
  | "dsar.in_progress"
  | "dsar.completed"
  | "dsar.rejected"
  // multi-venue phase
  | "org.group_crm.enabled"
  | "org.group_crm.disabled"
  // import-export phase
  | "data.exported"
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
  | "payment"
  | "message"
  | "waitlist"
  | "dsar_request"
  | "review"
  | "export";

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
