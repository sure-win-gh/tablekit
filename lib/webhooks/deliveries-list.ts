// Read query for the dashboard delivery log (PR6c).
//
// Returns the most recent deliveries for a subscription, scoped to
// the caller's org. Run via withUser so the
// `webhook_deliveries_member_read` RLS policy enforces the org
// boundary. The explicit subscriptionId + organisationId WHERE
// is defence-in-depth + lets the index do its job.

import "server-only";

import { and, desc, eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import * as schema from "@/lib/db/schema";
import { webhookDeliveries } from "@/lib/db/schema";

type Db = NodePgDatabase<typeof schema>;

export type DeliveryRow = {
  id: string;
  eventType: string;
  eventId: string;
  status: string;
  attempts: number;
  lastStatus: number | null;
  lastError: string | null;
  sentAt: Date | null;
  nextAttemptAt: Date | null;
  createdAt: Date;
};

export async function loadDeliveries(
  db: Db,
  args: { subscriptionId: string; organisationId: string; limit?: number },
): Promise<DeliveryRow[]> {
  return db
    .select({
      id: webhookDeliveries.id,
      eventType: webhookDeliveries.eventType,
      eventId: webhookDeliveries.eventId,
      status: webhookDeliveries.status,
      attempts: webhookDeliveries.attempts,
      lastStatus: webhookDeliveries.lastStatus,
      lastError: webhookDeliveries.lastError,
      sentAt: webhookDeliveries.sentAt,
      nextAttemptAt: webhookDeliveries.nextAttemptAt,
      createdAt: webhookDeliveries.createdAt,
    })
    .from(webhookDeliveries)
    .where(
      and(
        eq(webhookDeliveries.subscriptionId, args.subscriptionId),
        eq(webhookDeliveries.organisationId, args.organisationId),
      ),
    )
    .orderBy(desc(webhookDeliveries.createdAt))
    .limit(args.limit ?? 100);
}
