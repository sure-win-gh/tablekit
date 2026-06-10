// Integration test for the venue-photos Storage round-trip (booking-page
// Phase 2). Provisions the public bucket (idempotent), uploads a tiny object,
// confirms it's publicly fetchable at the well-known URL, then cleans up.

import { afterAll, describe, expect, it } from "vitest";

import {
  ensureVenuePhotosBucket,
  removeVenuePhotoObjects,
  uploadVenuePhotoObject,
} from "@/lib/server/admin/storage";
import { venuePhotoPublicUrl } from "@/lib/venues/photos";

// 1x1 transparent PNG.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
const path = `__test__/storage-${Date.now().toString(36)}.png`;

afterAll(async () => {
  await removeVenuePhotoObjects([path]).catch(() => undefined);
});

describe("venue-photos storage round-trip", () => {
  it("provisions the bucket, uploads, and serves a public URL", async () => {
    await ensureVenuePhotosBucket();
    await uploadVenuePhotoObject(path, PNG, "image/png");

    const res = await fetch(venuePhotoPublicUrl(path));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("image/png");
  });

  it("removes an object without error", async () => {
    // The object is gone from storage; the post-delete public URL status is
    // CDN-cache-dependent, so we only assert the removal call itself succeeds.
    await expect(removeVenuePhotoObjects([path])).resolves.toBeUndefined();
  });
});
