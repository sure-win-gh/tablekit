// Rich booking-page photo gallery (Core+). Server component — a CSS
// scroll-snap carousel, no client JS. The first image loads eager (it's the
// hero / likely LCP); the rest lazy. Plain <img> (not next/image): the files
// are in our public bucket and CSP img-src https: covers them, matching the
// logo/profile rendering posture. See docs/specs/booking-page.md.

import type { PublicPhoto } from "@/lib/public/venue";

export function PhotoGallery({ photos, venueName }: { photos: PublicPhoto[]; venueName: string }) {
  if (photos.length === 0) return null;
  return (
    <section
      id="photos"
      aria-label={`Photos of ${venueName}`}
      className="border-hairline flex scroll-mt-16 flex-col gap-3 border-t pt-6"
    >
      <h2 className="text-ink text-lg font-bold tracking-tight">Photos</h2>
      <ul className="-mx-1 flex snap-x snap-mandatory gap-2 overflow-x-auto px-1 pb-1">
        {photos.map((p, i) => (
          <li
            key={p.id}
            className={
              photos.length === 1
                ? "w-full shrink-0 snap-start"
                : "w-[88%] shrink-0 snap-start sm:w-[48%]"
            }
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={p.url}
              alt={p.caption ?? venueName}
              loading={i === 0 ? "eager" : "lazy"}
              className="rounded-card border-hairline aspect-[3/2] w-full border object-cover"
            />
          </li>
        ))}
      </ul>
    </section>
  );
}
