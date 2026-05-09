// Webhook subscription CRUD.
//
// Domain helpers for registering, listing, and revoking outbound
// webhook subscriptions. Plaintext secret is generated here, shown
// to the operator exactly once via the action layer, then envelope-
// encrypted under the org's DEK before persisting. The plaintext
// never leaves the request that created it.
//
// PR6b (delivery + signing) will decrypt the secret at dispatch
// time to HMAC each delivery body. PR6c (delivery log + replay)
// adds the deliveries table.

import "server-only";

import { randomBytes } from "node:crypto";

import { and, desc, eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import * as schema from "@/lib/db/schema";
import { webhookSubscriptions } from "@/lib/db/schema";
import { type Plaintext, encryptPii } from "@/lib/security/crypto";
import { adminDb } from "@/lib/server/admin/db";

import type { WebhookEvent } from "./events";

type Db = NodePgDatabase<typeof schema>;

// Re-exports. The actual constant + type live in lib/webhooks/events.ts
// so client components can import them without dragging in
// `server-only`. Kept here for callers that already import from
// this module.
export { WEBHOOK_EVENTS, type WebhookEvent } from "./events";

// Secret format: `whsec_<32 base64url chars>` — 24 bytes of entropy
// (192 bits). Distinct prefix from `sk_live_` so an operator
// pasting the wrong one in the wrong place is obvious. The prefix
// is also handy in error logs (the prefix alone identifies the
// secret namespace without leaking the body).
const SECRET_PREFIX = "whsec_";
const SECRET_BYTES = 24;

export type CreatedSubscription = {
  id: string;
  // Plaintext shared secret — return to the operator once, never
  // again. Caller's responsibility to wipe from memory after
  // displaying.
  plaintextSecret: string;
};

export type SubscriptionRow = {
  id: string;
  url: string;
  label: string;
  events: string[];
  active: boolean;
  revokedAt: Date | null;
  createdAt: Date;
};

export async function createSubscription(args: {
  organisationId: string;
  createdByUserId: string;
  url: string;
  label: string;
  events: ReadonlyArray<WebhookEvent>;
}): Promise<CreatedSubscription> {
  const plaintextSecret = `${SECRET_PREFIX}${randomBytes(SECRET_BYTES).toString("base64url")}`;
  const secretCipher = await encryptPii(args.organisationId, plaintextSecret as Plaintext);

  const db = adminDb();
  const [row] = await db
    .insert(webhookSubscriptions)
    .values({
      organisationId: args.organisationId,
      createdByUserId: args.createdByUserId,
      url: args.url,
      label: args.label,
      secretCipher,
      events: [...args.events],
    })
    .returning({ id: webhookSubscriptions.id });
  if (!row) throw new Error("lib/webhooks/subscribe.ts: insert returned no row");

  return { id: row.id, plaintextSecret };
}

export async function revokeSubscription(args: {
  subscriptionId: string;
  organisationId: string;
}): Promise<{ revoked: boolean }> {
  const db = adminDb();
  const updated = await db
    .update(webhookSubscriptions)
    .set({ revokedAt: new Date(), active: false })
    .where(
      and(
        eq(webhookSubscriptions.id, args.subscriptionId),
        eq(webhookSubscriptions.organisationId, args.organisationId),
      ),
    )
    .returning({ id: webhookSubscriptions.id });
  return { revoked: updated.length > 0 };
}

export async function listSubscriptions(
  db: Db,
  args: { organisationId: string },
): Promise<SubscriptionRow[]> {
  return db
    .select({
      id: webhookSubscriptions.id,
      url: webhookSubscriptions.url,
      label: webhookSubscriptions.label,
      events: webhookSubscriptions.events,
      active: webhookSubscriptions.active,
      revokedAt: webhookSubscriptions.revokedAt,
      createdAt: webhookSubscriptions.createdAt,
    })
    .from(webhookSubscriptions)
    .where(eq(webhookSubscriptions.organisationId, args.organisationId))
    .orderBy(desc(webhookSubscriptions.createdAt))
    .limit(200);
}
