"use server";

import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";

import { requireRole } from "@/lib/auth/require-role";
import { assertVenueVisible } from "@/lib/auth/venue-scope";
import { posConnections } from "@/lib/db/schema";
import { manualAttachOrder } from "@/lib/pos/manual-attach";
import { audit } from "@/lib/server/admin/audit";
import { adminDb } from "@/lib/server/admin/db";

const DisconnectSchema = z.object({
  venueId: z.uuid(),
  provider: z.enum(["square", "lightspeed_k", "generic"]),
});

export type PosActionState =
  | { status: "idle" }
  | { status: "error"; message: string }
  | { status: "saved" };

export async function disconnectPos(
  _prev: PosActionState,
  formData: FormData,
): Promise<PosActionState> {
  const parsed = DisconnectSchema.safeParse({
    venueId: formData.get("venue_id"),
    provider: formData.get("provider"),
  });
  if (!parsed.success) return { status: "error", message: "Invalid request." };

  const { orgId, userId } = await requireRole("manager");
  const { venueId, provider } = parsed.data;

  if (!(await assertVenueVisible(venueId))) {
    return { status: "error", message: "Venue not found." };
  }

  // Revoke + clear secrets rather than delete, so existing orders keep their
  // connection_id FK (de-linking orders is a DSAR concern, not disconnect).
  const db = adminDb();
  await db
    .update(posConnections)
    .set({
      status: "revoked",
      accessTokenCipher: null,
      refreshTokenCipher: null,
      webhookSecretCipher: null,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(posConnections.venueId, venueId),
        eq(posConnections.organisationId, orgId),
        eq(posConnections.provider, provider),
      ),
    );

  await audit.log({
    organisationId: orgId,
    actorUserId: userId,
    action: "pos.connection.disconnected",
    targetType: "venue",
    targetId: venueId,
    metadata: { provider },
  });

  revalidatePath(`/dashboard/venues/${venueId}/settings/pos`);
  return { status: "saved" };
}

const AttachSchema = z.object({
  venueId: z.uuid(),
  orderId: z.uuid(),
  guestId: z.uuid(),
});

export async function attachOrderToGuest(
  _prev: PosActionState,
  formData: FormData,
): Promise<PosActionState> {
  const parsed = AttachSchema.safeParse({
    venueId: formData.get("venue_id"),
    orderId: formData.get("order_id"),
    guestId: formData.get("guest_id"),
  });
  if (!parsed.success) return { status: "error", message: "Invalid request." };

  const result = await manualAttachOrder({
    orderId: parsed.data.orderId,
    guestId: parsed.data.guestId,
  });
  if (!result.ok) {
    const messages: Record<string, string> = {
      "order-not-found": "Order not found.",
      "guest-not-found": "Guest not found.",
      forbidden: "You can't edit this venue's orders.",
    };
    return { status: "error", message: messages[result.reason] ?? "Couldn't attach." };
  }

  revalidatePath(`/dashboard/venues/${parsed.data.venueId}/settings/pos`);
  return { status: "saved" };
}
