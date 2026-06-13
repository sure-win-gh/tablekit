// Resolve the org/venue context an inbound POS payload needs before it can
// be ingested. Webhook handlers find a connection (by provider account id,
// or by connection id for the generic path), and need the venue, the Art. 9
// line-item gate, and the org's group-CRM flag to drive matching.

import "server-only";

import { and, eq } from "drizzle-orm";

import { organisations, posConnections } from "@/lib/db/schema";
import { adminDb } from "@/lib/server/admin/db";

import type { PosProvider } from "./connection";

export type IngestContext = {
  connectionId: string;
  organisationId: string;
  venueId: string;
  provider: PosProvider;
  lineItemsEnabled: boolean;
  groupCrmEnabled: boolean;
  status: string;
};

function selectCtx() {
  return adminDb()
    .select({
      connectionId: posConnections.id,
      organisationId: posConnections.organisationId,
      venueId: posConnections.venueId,
      provider: posConnections.provider,
      lineItemsEnabled: posConnections.lineItemsEnabled,
      groupCrmEnabled: organisations.groupCrmEnabled,
      status: posConnections.status,
    })
    .from(posConnections)
    .innerJoin(organisations, eq(organisations.id, posConnections.organisationId));
}

export async function loadIngestContextByConnectionId(
  connectionId: string,
): Promise<IngestContext | null> {
  const [row] = await selectCtx().where(eq(posConnections.id, connectionId)).limit(1);
  return row ?? null;
}

// Square/Lightspeed map a webhook to us by the provider-side account id
// (Square merchant id, Lightspeed business id) stored on the connection.
export async function loadIngestContextByAccount(
  provider: PosProvider,
  externalAccountId: string,
): Promise<IngestContext | null> {
  const [row] = await selectCtx()
    .where(
      and(
        eq(posConnections.provider, provider),
        eq(posConnections.externalAccountId, externalAccountId),
      ),
    )
    .limit(1);
  return row ?? null;
}
