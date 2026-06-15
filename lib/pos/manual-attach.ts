// Manual attach — an operator links an unmatched POS order to a guest by
// hand. Writes match_method='manual', recomputes spend, and audits.
//
// Split so the org-scoped core is testable without a request/auth context:
//   - attachOrderToGuestForOrg(orgId, …) — validation + write + rollup + audit
//   - manualAttachOrder(…)               — the public entry: manager+ auth,
//     per-venue scope, then delegates to the core.

import "server-only";

import { and, eq } from "drizzle-orm";

import { assertVenueVisible } from "@/lib/auth/venue-scope";
import { requireRole } from "@/lib/auth/require-role";
import { guests, posOrders } from "@/lib/db/schema";
import { audit } from "@/lib/server/admin/audit";
import { adminDb } from "@/lib/server/admin/db";

import { recomputeGuestSpend } from "./rollup";

export type ManualAttachResult =
  | { ok: true; orderId: string; guestId: string; venueId: string }
  | { ok: false; reason: "order-not-found" | "guest-not-found" | "forbidden" };

// Org-scoped core. Assumes the caller has already authorised access to the
// org (and, in the public wrapper, the venue). No request/session context.
export async function attachOrderToGuestForOrg(params: {
  orgId: string;
  orderId: string;
  guestId: string;
}): Promise<ManualAttachResult> {
  const { orgId, orderId, guestId } = params;
  const db = adminDb();

  const [order] = await db
    .select({
      id: posOrders.id,
      venueId: posOrders.venueId,
      previousGuestId: posOrders.guestId,
    })
    .from(posOrders)
    .where(and(eq(posOrders.id, orderId), eq(posOrders.organisationId, orgId)))
    .limit(1);
  if (!order) return { ok: false, reason: "order-not-found" };

  const [guest] = await db
    .select({ id: guests.id, erasedAt: guests.erasedAt })
    .from(guests)
    .where(and(eq(guests.id, guestId), eq(guests.organisationId, orgId)))
    .limit(1);
  if (!guest || guest.erasedAt) return { ok: false, reason: "guest-not-found" };

  await db
    .update(posOrders)
    .set({ guestId, matchMethod: "manual", updatedAt: new Date() })
    .where(eq(posOrders.id, order.id));

  // Refresh the new guest, and the previous one if it changed.
  await recomputeGuestSpend(guestId);
  if (order.previousGuestId && order.previousGuestId !== guestId) {
    await recomputeGuestSpend(order.previousGuestId);
  }

  await audit.log({
    organisationId: orgId,
    action: "pos.order.manual_attached",
    targetType: "pos_order",
    targetId: order.id,
    metadata: { venueId: order.venueId, guestId },
  });

  return { ok: true, orderId: order.id, guestId, venueId: order.venueId };
}

// Public entry — manager+ in the order's org, with per-venue scope.
export async function manualAttachOrder(input: {
  orderId: string;
  guestId: string;
}): Promise<ManualAttachResult> {
  const { orgId } = await requireRole("manager");
  const db = adminDb();

  // Read the order's venue first so we can check per-venue scope BEFORE any
  // write (and confirm the order is in the caller's org).
  const [order] = await db
    .select({ venueId: posOrders.venueId })
    .from(posOrders)
    .where(and(eq(posOrders.id, input.orderId), eq(posOrders.organisationId, orgId)))
    .limit(1);
  if (!order) return { ok: false, reason: "order-not-found" };
  if (!(await assertVenueVisible(order.venueId))) return { ok: false, reason: "forbidden" };

  return attachOrderToGuestForOrg({ orgId, orderId: input.orderId, guestId: input.guestId });
}
