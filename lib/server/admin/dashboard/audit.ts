// Platform-staff audit writer.
//
// Distinct from lib/server/admin/audit.ts (org-scoped audit_log).
// Writes only land in public.platform_audit_log via adminDb() — RLS
// denies authenticated/anon, so no operator can read these rows.
//
// Action names are short dotted strings; keep them in the union below
// so TS catches typos at the call site.

import "server-only";

import { platformAuditLog } from "@/lib/db/schema";

import { adminDb } from "../db";

export type PlatformAuditAction =
  | "login"
  | "viewed_org"
  | "exported"
  | "searched";

export type PlatformAuditTargetType = "organisation" | "venue" | "user";

export type PlatformAuditInput = {
  actorEmail: string;
  action: PlatformAuditAction;
  targetType?: PlatformAuditTargetType | null | undefined;
  targetId?: string | null | undefined;
  metadata?: Record<string, unknown> | undefined;
};

export const platformAudit = {
  async log(input: PlatformAuditInput): Promise<void> {
    await adminDb()
      .insert(platformAuditLog)
      .values({
        actorEmail: input.actorEmail,
        action: input.action,
        targetType: input.targetType ?? null,
        targetId: input.targetId ?? null,
        metadata: input.metadata ?? {},
      });
  },
};
