"use server";

import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";

import { requireRole } from "@/lib/auth/require-role";
import { assertVenueVisible } from "@/lib/auth/venue-scope";
import { venueOauthConnections } from "@/lib/db/schema";
import { syncGoogleReviewsForVenue } from "@/lib/google/sync-reviews";
import { audit } from "@/lib/server/admin/audit";
import { adminDb } from "@/lib/server/admin/db";

const Schema = z.object({ venueId: z.uuid() });

export type DisconnectGoogleState =
  | { status: "idle" }
  | { status: "error"; message: string }
  | { status: "saved" };

export async function disconnectGoogle(
  _prev: DisconnectGoogleState,
  formData: FormData,
): Promise<DisconnectGoogleState> {
  const parsed = Schema.safeParse({ venueId: formData.get("venue_id") });
  if (!parsed.success) return { status: "error", message: "Invalid request." };

  const { orgId, userId } = await requireRole("manager");
  const { venueId } = parsed.data;

  // Per-venue scope check via RLS (matches the pattern in
  // reviews/actions.ts). Without this, a manager scoped to one venue
  // could disconnect another venue's connection in the same org.
  if (!(await assertVenueVisible(venueId))) {
    return { status: "error", message: "Venue not found." };
  }

  const db = adminDb();
  await db
    .delete(venueOauthConnections)
    .where(
      and(
        eq(venueOauthConnections.venueId, venueId),
        eq(venueOauthConnections.organisationId, orgId),
        eq(venueOauthConnections.provider, "google"),
      ),
    );

  await audit.log({
    organisationId: orgId,
    actorUserId: userId,
    action: "oauth.disconnected",
    targetType: "venue",
    targetId: venueId,
    metadata: { provider: "google" },
  });

  revalidatePath(`/dashboard/venues/${venueId}/settings`);
  return { status: "saved" };
}

// --- pickGoogleLocation -----------------------------------------------------

const PickSchema = z.object({
  venueId: z.uuid(),
  // Resource shape Google returns: accounts/{digits}/locations/{digits-or-letters}
  locationResource: z
    .string()
    .trim()
    .regex(
      /^accounts\/[A-Za-z0-9-]+\/locations\/[A-Za-z0-9-]+$/,
      "That doesn't look like a Google location resource.",
    ),
});

export type PickGoogleLocationState =
  | { status: "idle" }
  | { status: "error"; message: string }
  | { status: "saved" };

export async function pickGoogleLocation(
  _prev: PickGoogleLocationState,
  formData: FormData,
): Promise<PickGoogleLocationState> {
  const parsed = PickSchema.safeParse({
    venueId: formData.get("venue_id"),
    locationResource: formData.get("location_resource"),
  });
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return { status: "error", message: first?.message ?? "Invalid input." };
  }
  const { orgId, userId } = await requireRole("manager");
  const { venueId, locationResource } = parsed.data;

  // Per-venue scope check via RLS — same pattern as disconnectGoogle.
  if (!(await assertVenueVisible(venueId))) {
    return { status: "error", message: "Venue not found." };
  }

  const db = adminDb();
  const updated = await db
    .update(venueOauthConnections)
    .set({ externalAccountId: locationResource })
    .where(
      and(
        eq(venueOauthConnections.venueId, venueId),
        eq(venueOauthConnections.organisationId, orgId),
        eq(venueOauthConnections.provider, "google"),
      ),
    )
    .returning({ id: venueOauthConnections.id });
  if (updated.length === 0) {
    return { status: "error", message: "Google connection not found." };
  }

  await audit.log({
    organisationId: orgId,
    actorUserId: userId,
    action: "oauth.location_picked",
    targetType: "venue",
    targetId: venueId,
    metadata: { provider: "google" },
  });

  revalidatePath(`/dashboard/venues/${venueId}/settings`);
  return { status: "saved" };
}

// --- syncNowGoogle ----------------------------------------------------------
// Manual "Sync now" button on the reviews page. Same idempotent path
// the cron uses; just runs it inline so the operator gets immediate
// feedback after a connect or location change.

const SyncSchema = z.object({ venueId: z.uuid() });

export type SyncNowGoogleState =
  | { status: "idle" }
  | { status: "error"; message: string }
  | { status: "saved"; fetched: number; upserted: number };

export async function syncNowGoogle(
  _prev: SyncNowGoogleState,
  formData: FormData,
): Promise<SyncNowGoogleState> {
  const parsed = SyncSchema.safeParse({ venueId: formData.get("venue_id") });
  if (!parsed.success) return { status: "error", message: "Invalid request." };
  await requireRole("manager");
  const { venueId } = parsed.data;

  if (!(await assertVenueVisible(venueId))) {
    return { status: "error", message: "Venue not found." };
  }

  const outcome = await syncGoogleReviewsForVenue(venueId);
  if (!outcome.ok) {
    return { status: "error", message: `Sync failed: ${outcome.reason ?? "unknown"}` };
  }
  revalidatePath(`/dashboard/venues/${venueId}/reviews`);
  return { status: "saved", fetched: outcome.fetched, upserted: outcome.upserted };
}
