// Plan-tier gate, used wherever a feature is restricted to a specific
// pricing tier (today: AI enquiry handler — Plus tier).
//
// Two shapes for the two call-site contexts:
//
//   1. Dashboard / RSC / server actions: caller is logged in. Compose
//      with requireRole — `requireRole('manager')` first to get
//      `orgId`, then `requirePlan(orgId, 'plus')` to assert the plan.
//
//   2. Webhooks / cron / no-session paths: caller has resolved the
//      target org from upstream context (e.g. the inbound email's
//      recipient → venue → org). Same `requirePlan(orgId, 'plus')`
//      call works here.
//
// Reads `organisations.plan` via adminDb (no RLS — webhooks have no
// session). The result is the plan string; throws
// InsufficientPlanError when below `min`. Callers in webhook paths
// catch this and 200-OK + log (don't bounce — the upstream provider
// would retry).

import "server-only";

import { eq } from "drizzle-orm";

import { organisations } from "@/lib/db/schema";
import { adminDb } from "@/lib/server/admin/db";

import { hasPlan, type Plan, toPlan } from "./plan-level";

export class InsufficientPlanError extends Error {
  constructor(
    public readonly actual: Plan,
    public readonly required: Plan,
  ) {
    super(`requirePlan: org plan '${actual}' is below '${required}'`);
    this.name = "InsufficientPlanError";
  }
}

export class OrgNotFoundError extends Error {
  constructor(public readonly orgId: string) {
    super(`requirePlan: org ${orgId} not found`);
    this.name = "OrgNotFoundError";
  }
}

export async function requirePlan(orgId: string, min: Plan): Promise<Plan> {
  const db = adminDb();
  const [row] = await db
    .select({ plan: organisations.plan })
    .from(organisations)
    .where(eq(organisations.id, orgId))
    .limit(1);
  if (!row) throw new OrgNotFoundError(orgId);
  const plan = toPlan(row.plan);
  if (!hasPlan(plan, min)) {
    throw new InsufficientPlanError(plan, min);
  }
  return plan;
}
