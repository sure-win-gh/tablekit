// Rich booking-page reviews section (Core+). Server component. Renders the
// aggregate + a short mixed list of internal + Google reviews loaded by
// loadPublicReviews. See docs/specs/booking-page.md.

import type { PublicReviews } from "@/lib/public/venue";

import { StarRating } from "./star-rating";

function DistributionBar({ label, n, total }: { label: string; n: number; total: number }) {
  const width = total === 0 || n === 0 ? 0 : Math.max(2, (n / total) * 100);
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="text-ash w-6 shrink-0 text-right tabular-nums">{label}</span>
      <span className="bg-cloud relative h-2 flex-1 overflow-hidden rounded-full">
        <span
          className="bg-coral absolute inset-y-0 left-0 rounded-full"
          style={{ width: `${width}%` }}
          aria-hidden
        />
      </span>
      <span className="text-ash w-8 shrink-0 tabular-nums">{n}</span>
    </div>
  );
}

export function ReviewsSection({ reviews }: { reviews: PublicReviews }) {
  if (reviews.count === 0) return null;

  const sources = [
    reviews.bySource.google > 0 ? `${reviews.bySource.google} from Google` : null,
    reviews.bySource.internal > 0 ? `${reviews.bySource.internal} from verified diners` : null,
  ].filter(Boolean);

  return (
    <section
      id="reviews"
      aria-label="Reviews"
      className="border-hairline flex scroll-mt-16 flex-col gap-4 border-t pt-6"
    >
      <h2 className="text-ink text-lg font-bold tracking-tight">Reviews</h2>
      <div className="flex flex-wrap items-center gap-6">
        <div className="flex flex-col">
          <span className="text-ink text-4xl font-bold tracking-tight tabular-nums">
            {reviews.average.toFixed(1)}
            <span className="text-ash text-base font-medium">/5</span>
          </span>
          <StarRating rating={reviews.average} count={reviews.count} size="sm" />
        </div>
        <div className="flex max-w-xs min-w-40 flex-1 flex-col gap-1">
          <DistributionBar label="5★" n={reviews.distribution.five} total={reviews.count} />
          <DistributionBar label="4★" n={reviews.distribution.four} total={reviews.count} />
          <DistributionBar label="≤3★" n={reviews.distribution.threeOrLess} total={reviews.count} />
        </div>
      </div>
      {sources.length > 0 ? <p className="text-ash text-xs">{sources.join(" · ")}</p> : null}

      {reviews.items.length > 0 ? (
        <ul className="flex flex-col gap-3">
          {reviews.items.map((r) => (
            <li
              key={r.id}
              className="rounded-card border-hairline text-charcoal border bg-white p-4 text-sm"
            >
              <div className="flex items-center justify-between gap-2">
                <StarRating rating={r.rating} size="sm" />
                <span className="text-ash text-xs">
                  {r.source === "google" ? "Google" : "Verified diner"}
                </span>
              </div>
              <p className="mt-2 whitespace-pre-line">{r.comment}</p>
              <p className="text-ash mt-2 text-xs">
                — {r.author},{" "}
                {r.submittedAt.toLocaleDateString("en-GB", { year: "numeric", month: "short" })}
                {r.externalUrl ? (
                  <>
                    {" · "}
                    <a
                      href={r.externalUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="hover:text-coral underline"
                    >
                      View on Google
                    </a>
                  </>
                ) : null}
              </p>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
