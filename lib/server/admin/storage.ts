// Service-role Supabase Storage client for venue photos. BYPASSES storage
// RLS — used only by org-guarded server actions (the action verifies the
// venue belongs to the caller's org before uploading/removing). Mirrors the
// adminDb posture in ./db.ts: import ONLY from other lib/server/admin/**
// modules or the org-guarded action layer.

import "server-only";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import {
  ALLOWED_CAMPAIGN_IMAGE_MIME,
  CAMPAIGN_ASSETS_BUCKET,
  MAX_CAMPAIGN_IMAGE_BYTES,
} from "@/lib/campaigns/assets";
import { MAX_PHOTO_BYTES, VENUE_PHOTOS_BUCKET } from "@/lib/venues/photos";

let _client: SupabaseClient | null = null;

function storageClient(): SupabaseClient {
  if (_client) return _client;
  const url = process.env["NEXT_PUBLIC_SUPABASE_URL"];
  const key = process.env["SUPABASE_SERVICE_ROLE_KEY"];
  if (!url || !key) {
    throw new Error(
      "lib/server/admin/storage.ts: NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set.",
    );
  }
  _client = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return _client;
}

// Idempotent: create the public `venue-photos` bucket if it doesn't exist.
// Cached per server instance so we pay the getBucket round-trip at most once.
let _bucketEnsured = false;
export async function ensureVenuePhotosBucket(): Promise<void> {
  if (_bucketEnsured) return;
  const c = storageClient();
  const { data } = await c.storage.getBucket(VENUE_PHOTOS_BUCKET);
  if (data) {
    _bucketEnsured = true;
    return;
  }
  const { error } = await c.storage.createBucket(VENUE_PHOTOS_BUCKET, {
    public: true,
    fileSizeLimit: MAX_PHOTO_BYTES,
    allowedMimeTypes: ["image/jpeg", "image/png", "image/webp"],
  });
  if (error && !/already exists/i.test(error.message)) throw error;
  _bucketEnsured = true;
}

export async function uploadVenuePhotoObject(
  path: string,
  body: ArrayBuffer | Buffer,
  contentType: string,
): Promise<void> {
  await ensureVenuePhotosBucket();
  const { error } = await storageClient()
    .storage.from(VENUE_PHOTOS_BUCKET)
    .upload(path, body, { contentType, upsert: false });
  if (error) throw error;
}

export async function removeVenuePhotoObjects(paths: string[]): Promise<void> {
  if (paths.length === 0) return;
  const { error } = await storageClient().storage.from(VENUE_PHOTOS_BUCKET).remove(paths);
  if (error) throw error;
}

// --- Campaign email assets (marketing-suite Phase A) -----------------------
// Same public-bucket pattern as venue photos; org-scoped paths are
// enforced by the org-guarded upload action in the campaigns action layer.

let _campaignBucketEnsured = false;
export async function ensureCampaignAssetsBucket(): Promise<void> {
  if (_campaignBucketEnsured) return;
  const c = storageClient();
  const { data } = await c.storage.getBucket(CAMPAIGN_ASSETS_BUCKET);
  if (data) {
    _campaignBucketEnsured = true;
    return;
  }
  const { error } = await c.storage.createBucket(CAMPAIGN_ASSETS_BUCKET, {
    public: true,
    fileSizeLimit: MAX_CAMPAIGN_IMAGE_BYTES,
    allowedMimeTypes: Object.keys(ALLOWED_CAMPAIGN_IMAGE_MIME),
  });
  if (error && !/already exists/i.test(error.message)) throw error;
  _campaignBucketEnsured = true;
}

export async function uploadCampaignAssetObject(
  path: string,
  body: ArrayBuffer | Buffer,
  contentType: string,
): Promise<void> {
  await ensureCampaignAssetsBucket();
  const { error } = await storageClient()
    .storage.from(CAMPAIGN_ASSETS_BUCKET)
    .upload(path, body, { contentType, upsert: false });
  if (error) throw error;
}
