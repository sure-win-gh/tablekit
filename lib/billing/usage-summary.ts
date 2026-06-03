// Operator-facing usage summary — current month's send volume + est
// pass-through cost per channel, read from the message_usage ledger.

import "server-only";

import { and, eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import { messageUsage } from "@/lib/db/schema";
import type * as schema from "@/lib/db/schema";

import { billingPeriod } from "./usage";

type Db = NodePgDatabase<typeof schema>;

export type UsageRow = { channel: string; count: number; costPence: number };
export type UsageSummary = { period: string; rows: UsageRow[]; totalCostPence: number };

// Current-period usage for an org. Reads under the caller's db handle —
// withUser (RLS member-read) for operator surfaces, adminDb for admin.
export async function getUsageSummary(
  db: Db,
  organisationId: string,
  now: Date,
): Promise<UsageSummary> {
  const period = billingPeriod(now);
  const rows = await db
    .select({
      channel: messageUsage.channel,
      count: messageUsage.count,
      costPence: messageUsage.estCostPence,
    })
    .from(messageUsage)
    .where(and(eq(messageUsage.organisationId, organisationId), eq(messageUsage.period, period)));

  const ordered: UsageRow[] = ["email", "sms", "whatsapp"]
    .map((ch) => rows.find((r) => r.channel === ch))
    .filter((r): r is UsageRow => Boolean(r));
  const totalCostPence = ordered.reduce((s, r) => s + r.costPence, 0);
  return { period, rows: ordered, totalCostPence };
}
