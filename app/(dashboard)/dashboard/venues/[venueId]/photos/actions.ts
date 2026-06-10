"use server";

import { randomUUID } from "node:crypto";

import { and, eq, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";

import { requireRole } from "@/lib/auth/require-role";
import { venuePhotos, venues } from "@/lib/db/schema";
import { adminDb } from "@/lib/server/admin/db";
import { removeVenuePhotoObjects, uploadVenuePhotoObject } from "@/lib/server/admin/storage";
import { audit } from "@/lib/server/admin/audit";
import { MAX_PHOTO_BYTES, MAX_PHOTOS_PER_VENUE, photoExtensionForMime } from "@/lib/venues/photos";

export type PhotoActionState =
  | { status: "idle" }
  | { status: "error"; message: string }
  | { status: "saved" };

const err = (message: string): PhotoActionState => ({ status: "error", message });

// Verify the venue belongs to the caller's org. adminDb() bypasses RLS, so
// this guard carries the multi-tenant weight (the enforce trigger is a
// backstop). Returns orgId on success.
async function guardVenue(
  venueIdRaw: FormDataEntryValue | null,
): Promise<{ ok: true; venueId: string; orgId: string; userId: string } | { ok: false }> {
  const venueId = z.uuid().safeParse(venueIdRaw);
  if (!venueId.success) return { ok: false };
  const { orgId, userId } = await requireRole("manager");
  const db = adminDb();
  const [venue] = await db
    .select({ id: venues.id })
    .from(venues)
    .where(and(eq(venues.id, venueId.data), eq(venues.organisationId, orgId)))
    .limit(1);
  if (!venue) return { ok: false };
  return { ok: true, venueId: venueId.data, orgId, userId };
}

export async function uploadVenuePhoto(
  _prev: PhotoActionState,
  formData: FormData,
): Promise<PhotoActionState> {
  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) return err("Pick an image to upload.");
  if (file.size > MAX_PHOTO_BYTES) {
    return err(`Image is too large (max ${(MAX_PHOTO_BYTES / 1_048_576).toFixed(0)}MB).`);
  }
  // file.type is client-asserted; this allowlist is advisory UX. The real
  // enforcement is the bucket's allowedMimeTypes (lib/server/admin/storage.ts),
  // which rejects a spoofed content type at upload.
  const ext = photoExtensionForMime(file.type);
  if (!ext) return err("Use a JPEG, PNG or WebP image.");

  const guard = await guardVenue(formData.get("venue_id"));
  if (!guard.ok) return err("Venue not found or not in your organisation.");
  const { venueId, orgId, userId } = guard;

  const db = adminDb();
  const aggRows = await db
    .select({
      count: sql<number>`count(*)::int`,
      maxSort: sql<number>`coalesce(max(${venuePhotos.sortOrder}), -1)::int`,
    })
    .from(venuePhotos)
    .where(eq(venuePhotos.venueId, venueId));
  const count = aggRows[0]?.count ?? 0;
  const maxSort = aggRows[0]?.maxSort ?? -1;
  if (count >= MAX_PHOTOS_PER_VENUE) {
    return err(`You can add up to ${MAX_PHOTOS_PER_VENUE} photos per venue.`);
  }

  const storagePath = `${venueId}/${randomUUID()}.${ext}`;
  const bytes = Buffer.from(await file.arrayBuffer());
  await uploadVenuePhotoObject(storagePath, bytes, file.type);

  const caption = ((formData.get("caption") as string | null)?.trim() ?? "").slice(0, 200) || null;
  try {
    await db.insert(venuePhotos).values({
      organisationId: orgId, // overwritten by the enforce trigger from the venue
      venueId,
      storagePath,
      caption,
      sortOrder: maxSort + 1,
    });
  } catch (e) {
    // Roll back the orphaned object so a failed insert doesn't leak storage.
    await removeVenuePhotoObjects([storagePath]).catch(() => undefined);
    throw e;
  }

  await audit.log({
    organisationId: orgId,
    actorUserId: userId,
    action: "venue.photo_uploaded",
    targetType: "venue",
    targetId: venueId,
  });
  revalidatePath(`/dashboard/venues/${venueId}/photos`, "layout");
  return { status: "saved" };
}

// Plain form actions (single FormData arg) — server-rendered forms in the
// photos manager post directly to these. They operate on already-valid rows
// so they no-op silently on a bad payload rather than surfacing field errors.
export async function deleteVenuePhoto(formData: FormData): Promise<void> {
  const photoId = z.uuid().safeParse(formData.get("photo_id"));
  if (!photoId.success) return;
  const { orgId, userId } = await requireRole("manager");
  const db = adminDb();
  const [photo] = await db
    .select({
      id: venuePhotos.id,
      storagePath: venuePhotos.storagePath,
      venueId: venuePhotos.venueId,
    })
    .from(venuePhotos)
    .where(and(eq(venuePhotos.id, photoId.data), eq(venuePhotos.organisationId, orgId)))
    .limit(1);
  if (!photo) return;

  await db
    .delete(venuePhotos)
    .where(and(eq(venuePhotos.id, photoId.data), eq(venuePhotos.organisationId, orgId)));
  // Best-effort object removal — a left-behind object is harmless (orphaned,
  // unreferenced) and cheaper than failing the user's delete.
  await removeVenuePhotoObjects([photo.storagePath]).catch(() => undefined);

  await audit.log({
    organisationId: orgId,
    actorUserId: userId,
    action: "venue.photo_deleted",
    targetType: "venue",
    targetId: photo.venueId,
  });
  revalidatePath(`/dashboard/venues/${photo.venueId}/photos`, "layout");
}

export async function reorderVenuePhotos(formData: FormData): Promise<void> {
  const guard = await guardVenue(formData.get("venue_id"));
  if (!guard.ok) return;
  const { venueId, orgId } = guard;

  const ids = ((formData.get("order") as string | null) ?? "").split(",").filter(Boolean);
  const parsed = z.array(z.uuid()).safeParse(ids);
  if (!parsed.success || parsed.data.length === 0) return;

  const db = adminDb();
  await db.transaction(async (tx) => {
    for (let i = 0; i < parsed.data.length; i++) {
      await tx
        .update(venuePhotos)
        .set({ sortOrder: i })
        .where(
          and(
            eq(venuePhotos.id, parsed.data[i]!),
            eq(venuePhotos.venueId, venueId),
            eq(venuePhotos.organisationId, orgId),
          ),
        );
    }
  });
  revalidatePath(`/dashboard/venues/${venueId}/photos`, "layout");
}
