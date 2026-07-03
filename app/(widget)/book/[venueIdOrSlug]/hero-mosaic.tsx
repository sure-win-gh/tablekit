// TheFork-style photo mosaic hero (Core+). Server component, CSS grid,
// no client JS. Shows the lead photo large + up to two thumbnails; when
// more photos exist the last tile overlays a "+N photos" link that
// anchor-jumps to the full gallery (#photos). Falls back gracefully for
// one or two photos. Plain <img> — same CSP posture as gallery.tsx.

import type { PublicPhoto } from "@/lib/public/venue";

export function HeroMosaic({ photos, venueName }: { photos: PublicPhoto[]; venueName: string }) {
  if (photos.length === 0) return null;
  const [lead, second, third] = photos;
  const extra = photos.length - 3;

  if (photos.length === 1) {
    return (
      <section aria-label={`Photo highlights of ${venueName}`}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={lead!.url}
          alt={lead!.caption ?? venueName}
          loading="eager"
          fetchPriority="high"
          className="rounded-card border-hairline aspect-[21/9] w-full border object-cover"
        />
      </section>
    );
  }

  return (
    <section aria-label={`Photo highlights of ${venueName}`}>
      <div className="grid h-56 grid-cols-3 grid-rows-2 gap-1.5 sm:h-72">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={lead!.url}
          alt={lead!.caption ?? venueName}
          loading="eager"
          fetchPriority="high"
          className="rounded-l-card col-span-2 row-span-2 h-full w-full object-cover"
        />
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={second!.url}
          alt={second!.caption ?? venueName}
          loading="lazy"
          className="rounded-tr-card h-full w-full object-cover"
        />
        {third ? (
          <a
            href="#photos"
            className="rounded-br-card relative block h-full w-full overflow-hidden"
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={third.url}
              alt={third.caption ?? venueName}
              loading="lazy"
              className="h-full w-full object-cover"
            />
            {extra > 0 ? (
              <span className="bg-ink/60 absolute inset-0 flex items-center justify-center text-sm font-semibold text-white">
                +{extra} photo{extra === 1 ? "" : "s"}
              </span>
            ) : null}
          </a>
        ) : (
          <div className="rounded-br-card bg-cloud h-full w-full" aria-hidden />
        )}
      </div>
    </section>
  );
}
