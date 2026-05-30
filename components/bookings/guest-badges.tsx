import { AlertTriangle, Baby, Sparkles, Star } from "lucide-react";

import { Badge } from "@/components/ui";
import type { GuestEnrichment } from "@/lib/bookings/detail";
import { visitLabel } from "@/lib/guests/visit-label";

// Shared at-a-glance row used everywhere booking details surface:
// bookings list row, booking detail dialog header, floor-plan side
// panel, timeline block. Pure presentational — props mirror the
// GuestEnrichment shape on BookingDetailPayload.
//
// `density` controls how much we show: "row" keeps it tight for a
// list (no tags, no notes preview); "full" surfaces tags inline too.
// Wording / icons stay identical across densities so an operator's
// glance pattern is the same on every surface.

type Props = GuestEnrichment & {
  density?: "row" | "full";
  className?: string;
};

const MAX_TAGS_INLINE = 3;

export function GuestBadges({
  guestTags,
  guestNotes,
  dietaryNotes,
  highChairs,
  priorVisits,
  density = "row",
  className,
}: Props) {
  const visit = visitLabel(priorVisits);
  const hasAllergy = Boolean(guestNotes?.trim()) || Boolean(dietaryNotes?.trim());
  const VisitIcon = priorVisits >= 2 ? Star : Sparkles;

  return (
    <div className={`flex flex-wrap items-center gap-1.5 ${className ?? ""}`}>
      <Badge tone={visit.tone} aria-label={`Visit history: ${visit.text}`}>
        <VisitIcon className="h-3 w-3" aria-hidden />
        {visit.text}
      </Badge>

      {hasAllergy ? (
        <Badge tone="warning" aria-label="Dietary or allergy note on file">
          <AlertTriangle className="h-3 w-3" aria-hidden />
          Allergy / dietary
        </Badge>
      ) : null}

      {highChairs > 0 ? (
        <Badge tone="info" aria-label={`Highchair${highChairs > 1 ? "s" : ""} needed`}>
          <Baby className="h-3 w-3" aria-hidden />
          Highchair{highChairs > 1 ? ` ×${highChairs}` : ""}
        </Badge>
      ) : null}

      {density === "full" && guestTags.length > 0 ? (
        <>
          {guestTags.slice(0, MAX_TAGS_INLINE).map((t) => (
            <Badge key={t} tone="neutral">
              {t}
            </Badge>
          ))}
          {guestTags.length > MAX_TAGS_INLINE ? (
            <Badge tone="neutral">+{guestTags.length - MAX_TAGS_INLINE}</Badge>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
