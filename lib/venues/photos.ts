// Shared constants + helpers for venue gallery photos (booking-page Phase 2).
// Pure (no server-only, no IO) so both the dashboard client form, the upload
// server action, and the public render can share the limits + URL builder.
// The files live in the PUBLIC `venue-photos` Supabase Storage bucket; venue
// photos are operator branding, not guest PII.

export const VENUE_PHOTOS_BUCKET = "venue-photos";

// Per-photo size cap + per-venue count cap. Kept modest: the gallery is a
// handful of hero/interior shots, not an album.
export const MAX_PHOTO_BYTES = 5 * 1024 * 1024; // 5 MB
export const MAX_PHOTOS_PER_VENUE = 12;

// Allowed upload types → file extension used for the storage object name.
export const ALLOWED_PHOTO_MIME: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

export function photoExtensionForMime(mime: string): string | null {
  return ALLOWED_PHOTO_MIME[mime] ?? null;
}

// Deterministic public URL for a stored object. No network call — the bucket
// is public, so this is just the well-known object path. Uses the public
// NEXT_PUBLIC_SUPABASE_URL so the render layer needs no service-role client.
export function venuePhotoPublicUrl(storagePath: string): string {
  const base = (process.env["NEXT_PUBLIC_SUPABASE_URL"] ?? "").replace(/\/$/, "");
  return `${base}/storage/v1/object/public/${VENUE_PHOTOS_BUCKET}/${storagePath}`;
}
