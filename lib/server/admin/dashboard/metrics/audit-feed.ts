// Platform-wide audit_log feed for /admin/audit.
//
// Reads the last N rows from public.audit_log (org-scoped — every
// operator-side event is recorded here). Optional filters narrow by
// action prefix (e.g. 'stripe.') or organisation id.
//
// Joins to organisations for the org name + to users for the actor
// email (operator user, plaintext-stored for login). No PII
// decryption — guest data is never touched.
//
// At year-1 volumes this is a tight LIMIT 100 ORDER BY created_at
// scan. The (organisation_id, created_at DESC) index helps when an
// org filter is applied; an unfiltered scan walks the table — fine
// for now, revisit if the audit_log grows.

import "server-only";

import { and, desc, eq, like, sql } from "drizzle-orm";

import { auditLog, organisations, users } from "@/lib/db/schema";

import type { AdminDb } from "../types";

export type AuditFeedRow = {
  id: string;
  organisationId: string;
  organisationName: string | null;
  actorUserId: string | null;
  actorEmail: string | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  metadata: Record<string, unknown>;
  createdAt: Date;
};

export type AuditFeedFilter = {
  actionPrefix?: string | undefined;
  orgId?: string | undefined;
  limit?: number | undefined;
};

export async function getAuditFeed(
  db: AdminDb,
  filter: AuditFeedFilter = {},
): Promise<AuditFeedRow[]> {
  const limit = Math.min(filter.limit ?? 100, 500);
  const conditions = [];
  if (filter.actionPrefix && filter.actionPrefix.length > 0) {
    conditions.push(like(auditLog.action, `${filter.actionPrefix}%`));
  }
  if (filter.orgId) {
    conditions.push(eq(auditLog.organisationId, filter.orgId));
  }

  const rows = await db
    .select({
      id: auditLog.id,
      organisationId: auditLog.organisationId,
      organisationName: organisations.name,
      actorUserId: auditLog.actorUserId,
      actorEmail: sql<string | null>`${users.email}::text`,
      action: auditLog.action,
      targetType: auditLog.targetType,
      targetId: auditLog.targetId,
      metadata: auditLog.metadata,
      createdAt: auditLog.createdAt,
    })
    .from(auditLog)
    .leftJoin(organisations, eq(organisations.id, auditLog.organisationId))
    .leftJoin(users, eq(users.id, auditLog.actorUserId))
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(auditLog.createdAt))
    .limit(limit);

  return rows.map((r) => ({
    ...r,
    metadata: (r.metadata ?? {}) as Record<string, unknown>,
  }));
}

export const AUDIT_PREFIX_OPTIONS: { value: string; label: string }[] = [
  { value: "", label: "All actions" },
  { value: "login.", label: "login.*" },
  { value: "signup", label: "signup" },
  { value: "venue.", label: "venue.*" },
  { value: "booking.", label: "booking.*" },
  { value: "stripe.", label: "stripe.*" },
  { value: "deposit_rule.", label: "deposit_rule.*" },
  { value: "message.", label: "message.*" },
  { value: "review.", label: "review.*" },
  { value: "waitlist.", label: "waitlist.*" },
  { value: "dsar.", label: "dsar.*" },
  { value: "oauth.", label: "oauth.*" },
  { value: "guest.", label: "guest.*" },
  { value: "data.", label: "data.*" },
  { value: "org.", label: "org.*" },
  { value: "role.", label: "role.*" },
  { value: "mfa.", label: "mfa.*" },
];
