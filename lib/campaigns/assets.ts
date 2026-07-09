// Campaign email image assets (marketing-suite Phase A). Mirrors
// lib/venues/photos.ts: pure constants + URL builder shared by the client
// builder and the upload server action. Files live in the PUBLIC
// `campaign-assets` Supabase Storage bucket (UK region — residency rule
// 6; assets are operator marketing content, not guest PII).
//
// Follow-up (pre-GA polish): server-side re-encode + EXIF strip once an
// image library is added — for now the bucket's MIME allowlist + size cap
// are the enforcement, matching the venue-photos posture.

export const CAMPAIGN_ASSETS_BUCKET = "campaign-assets";

// Emails should stay light — 2 MB per image (spec), max width handled by
// the renderer (100% of the 560px shell).
export const MAX_CAMPAIGN_IMAGE_BYTES = 2 * 1024 * 1024; // 2 MB

export const ALLOWED_CAMPAIGN_IMAGE_MIME: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

export function campaignImageExtensionForMime(mime: string): string | null {
  return ALLOWED_CAMPAIGN_IMAGE_MIME[mime] ?? null;
}

// Deterministic public URL — the bucket is public, no service-role client
// needed to build it.
export function campaignAssetPublicUrl(storagePath: string): string {
  const base = (process.env["NEXT_PUBLIC_SUPABASE_URL"] ?? "").replace(/\/$/, "");
  return `${base}/storage/v1/object/public/${CAMPAIGN_ASSETS_BUCKET}/${storagePath}`;
}
