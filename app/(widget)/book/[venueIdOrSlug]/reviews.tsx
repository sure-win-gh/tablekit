// Rich booking-page reviews section (Core+). Server component. Renders the
// aggregate + a short mixed list of internal + Google reviews loaded by
// loadPublicReviews. See docs/specs/booking-page.md.

import type { PublicReviews } from "@/lib/public/venue";

import { StarRating } from "./star-rating";

export function ReviewsSection({ reviews }: { reviews: PublicReviews }) {
  if (reviews.count === 0) return null;

  const sources = [
    reviews.bySource.google > 0 ? `${reviews.bySource.google} from Google` : null,
    reviews.bySource.internal > 0 ? `${reviews.bySource.internal} from diners` : null,
  ].filter(Boolean);

  return (
    <section aria-label="Reviews" className="border-hairline flex flex-col gap-4 border-t pt-6">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-ink text-lg font-bold tracking-tight">Reviews</h2>
        <StarRating rating={reviews.average} count={reviews.count} size="sm" />
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
