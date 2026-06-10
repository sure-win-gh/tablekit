import { asc, eq } from "drizzle-orm";
import { notFound } from "next/navigation";
import Link from "next/link";

import { hasPlan } from "@/lib/auth/plan-level";
import { getPlan } from "@/lib/auth/require-plan";
import { requireRole } from "@/lib/auth/require-role";
import { withUser } from "@/lib/db/client";
import { venuePhotos, venues } from "@/lib/db/schema";
import { MAX_PHOTOS_PER_VENUE, venuePhotoPublicUrl } from "@/lib/venues/photos";

import { deleteVenuePhoto, reorderVenuePhotos } from "./actions";
import { PhotoUploadForm } from "./photos-form";

export const metadata = { title: "Photos · TableKit" };

export default async function VenuePhotosPage({
  params,
}: {
  params: Promise<{ venueId: string }>;
}) {
  const { orgId } = await requireRole("manager");
  const orgPlan = await getPlan(orgId);
  const { venueId } = await params;

  const data = await withUser(async (db) => {
    const [venue] = await db
      .select({ id: venues.id, name: venues.name })
      .from(venues)
      .where(eq(venues.id, venueId))
      .limit(1);
    const photos = await db
      .select({
        id: venuePhotos.id,
        storagePath: venuePhotos.storagePath,
        caption: venuePhotos.caption,
      })
      .from(venuePhotos)
      .where(eq(venuePhotos.venueId, venueId))
      .orderBy(asc(venuePhotos.sortOrder), asc(venuePhotos.createdAt));
    return { venue, photos };
  });
  if (!data.venue) notFound();
  const { venue, photos } = data;

  const isCore = hasPlan(orgPlan, "core");
  const ids = photos.map((p) => p.id);
  // Compute the reordered id list for a single up/down swap, server-side, so
  // the reorder forms work without any client JS.
  const swapOrder = (i: number, j: number) => {
    const next = [...ids];
    [next[i], next[j]] = [next[j]!, next[i]!];
    return next.join(",");
  };

  return (
    <section className="mx-auto flex w-full max-w-3xl flex-col gap-6">
      <div>
        <h2 className="text-ink text-xl font-bold tracking-tight">Photos</h2>
        <p className="text-ash mt-0.5 text-sm">
          Up to {MAX_PHOTOS_PER_VENUE} photos appear on your booking page (Core and Plus). JPEG, PNG
          or WebP, max 5&nbsp;MB. The first photo is used as the hero image.
        </p>
      </div>

      {!isCore ? (
        <p className="rounded-card border-coral/30 bg-coral/5 text-charcoal border p-3 text-sm">
          Photos show on your booking page on{" "}
          <Link href="/dashboard/upgrade" className="text-coral font-medium underline">
            Core and Plus
          </Link>
          . You can upload them now so they&apos;re ready when you upgrade.
        </p>
      ) : null}

      <PhotoUploadForm venueId={venue.id} atLimit={photos.length >= MAX_PHOTOS_PER_VENUE} />

      {photos.length === 0 ? (
        <p className="text-ash text-sm">No photos yet — add your first above.</p>
      ) : (
        <ul className="grid grid-cols-2 gap-4 sm:grid-cols-3">
          {photos.map((p, i) => (
            <li
              key={p.id}
              className="rounded-card border-hairline flex flex-col gap-2 overflow-hidden border bg-white"
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={venuePhotoPublicUrl(p.storagePath)}
                alt={p.caption ?? venue.name}
                className="aspect-[4/3] w-full object-cover"
              />
              <div className="flex flex-col gap-2 p-2">
                {p.caption ? <p className="text-charcoal truncate text-xs">{p.caption}</p> : null}
                <div className="flex items-center gap-1">
                  {i > 0 ? (
                    <form action={reorderVenuePhotos}>
                      <input type="hidden" name="venue_id" value={venue.id} />
                      <input type="hidden" name="order" value={swapOrder(i, i - 1)} />
                      <button
                        type="submit"
                        aria-label="Move earlier"
                        className="border-hairline text-charcoal hover:border-ink rounded border px-2 py-1 text-xs"
                      >
                        ↑
                      </button>
                    </form>
                  ) : null}
                  {i < photos.length - 1 ? (
                    <form action={reorderVenuePhotos}>
                      <input type="hidden" name="venue_id" value={venue.id} />
                      <input type="hidden" name="order" value={swapOrder(i, i + 1)} />
                      <button
                        type="submit"
                        aria-label="Move later"
                        className="border-hairline text-charcoal hover:border-ink rounded border px-2 py-1 text-xs"
                      >
                        ↓
                      </button>
                    </form>
                  ) : null}
                  <form action={deleteVenuePhoto} className="ml-auto">
                    <input type="hidden" name="photo_id" value={p.id} />
                    <button
                      type="submit"
                      className="rounded border border-red-200 px-2 py-1 text-xs text-red-600 hover:border-red-400"
                    >
                      Delete
                    </button>
                  </form>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
