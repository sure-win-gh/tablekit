// Reusable star-rating glyph for the rich booking page. Server component,
// no state. Filled stars use the (themeable) coral token; empties use stone.
// Fractional ratings round to the nearest whole star for the glyph; callers
// show the numeric average alongside when they want precision.

import { cn } from "@/components/ui";

export function StarRating({
  rating,
  count,
  size = "md",
}: {
  rating: number;
  count?: number;
  size?: "sm" | "md";
}) {
  const filled = Math.max(0, Math.min(5, Math.round(rating)));
  const label = count != null ? `${rating} out of 5 from ${count} reviews` : `${rating} out of 5`;
  return (
    <span className={cn("inline-flex items-center gap-1", size === "sm" ? "text-sm" : "text-base")}>
      <span aria-hidden className="tracking-tight">
        {Array.from({ length: 5 }, (_, i) => (
          <span key={i} className={i < filled ? "text-coral" : "text-stone"}>
            ★
          </span>
        ))}
      </span>
      <span className="sr-only">{label}</span>
      {count != null ? (
        <span className="text-ash text-sm">
          {rating.toFixed(1)} · {count} {count === 1 ? "review" : "reviews"}
        </span>
      ) : null}
    </span>
  );
}
