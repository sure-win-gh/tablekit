// Rich booking-page profile sections (Core+). Server components.
// VenueInfoHeader = the TheFork-style top block (logo/name + cuisine, price,
// aggregate rating, TripAdvisor badge). AboutSection = description + address +
// contact + opening hours + a "Get directions" map link-out (no embed, so no
// new sub-processor). See docs/specs/booking-page.md.

import { Badge } from "@/components/ui";
import type { OpeningDay } from "@/lib/public/venue";
import type { VenueProfile } from "@/lib/venues/profile";

import { StarRating } from "./star-rating";

export function VenueInfoHeader({
  venueName,
  logoUrl,
  profile,
  average,
  reviewCount,
}: {
  venueName: string;
  logoUrl: string | null;
  profile: VenueProfile | undefined;
  average: number;
  reviewCount: number;
}) {
  const ta = profile?.tripadvisorRating;
  const addressLine = [profile?.address?.street, profile?.address?.city, profile?.address?.postcode]
    .filter(Boolean)
    .join(", ");
  const directions = profile ? directionsUrl(profile) : null;
  return (
    <header className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-3">
        {logoUrl ? (
          // Plain <img>, not next/image — operator logos are arbitrary HTTPS
          // hosts (see branding.tsx for the SSRF rationale). CSP img-src https:.
          // eslint-disable-next-line @next/next/no-img-element
          <img src={logoUrl} alt="" loading="lazy" className="h-10 w-auto" />
        ) : null}
        <h1 className="text-ink text-3xl font-bold tracking-tight sm:text-4xl">{venueName}</h1>
      </div>
      {addressLine ? (
        <p className="text-ash text-sm">
          {addressLine}
          {directions ? (
            <>
              {" · "}
              <a
                href={directions}
                target="_blank"
                rel="noopener noreferrer"
                className="hover:text-coral underline underline-offset-2"
              >
                Get directions
              </a>
            </>
          ) : null}
        </p>
      ) : null}
      <div className="text-ash flex flex-wrap items-center gap-x-3 gap-y-2 text-sm">
        {profile?.cuisine ? <Badge tone="coral">{profile.cuisine}</Badge> : null}
        {profile?.priceRange ? (
          <span className="text-charcoal font-medium">{profile.priceRange}</span>
        ) : null}
        {reviewCount > 0 ? (
          <span className="flex items-baseline gap-1.5">
            <span className="text-ink text-lg font-bold tabular-nums">{average.toFixed(1)}</span>
            <StarRating rating={average} count={reviewCount} size="sm" />
          </span>
        ) : null}
        {ta != null ? <TripAdvisorBadge rating={ta} url={profile?.tripadvisorUrl ?? null} /> : null}
      </div>
    </header>
  );
}

function TripAdvisorBadge({ rating, url }: { rating: number; url: string | null }) {
  const inner = (
    <>
      <span className="font-semibold">Tripadvisor</span> {rating.toFixed(1)} ★
    </>
  );
  const cls =
    "border-hairline text-charcoal inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs";
  return url ? (
    <a href={url} target="_blank" rel="noopener noreferrer" className={`${cls} hover:border-ink`}>
      {inner}
      <span className="sr-only">— view on TripAdvisor</span>
    </a>
  ) : (
    <span className={cls}>{inner}</span>
  );
}

function directionsUrl(profile: VenueProfile): string | null {
  if (profile.latitude != null && profile.longitude != null) {
    const q = encodeURIComponent(`${profile.latitude},${profile.longitude}`);
    return `https://www.google.com/maps/search/?api=1&query=${q}`;
  }
  const addr = [profile.address?.street, profile.address?.city, profile.address?.postcode]
    .filter(Boolean)
    .join(", ");
  return addr
    ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(addr)}`
    : null;
}

export function AboutSection({
  profile,
  openingHours,
}: {
  profile: VenueProfile;
  openingHours?: OpeningDay[];
}) {
  const addressLine = [profile.address?.street, profile.address?.city, profile.address?.postcode]
    .filter(Boolean)
    .join(", ");
  const hasContact = Boolean(profile.phone || profile.website || addressLine);
  const directions = directionsUrl(profile);
  const hours = openingHours?.filter((d) => d.windows.length > 0).length ? openingHours : null;
  if (!profile.description && !hasContact && !hours) return null;

  return (
    <section
      id="about"
      aria-label="About this venue"
      className="border-hairline flex scroll-mt-16 flex-col gap-4 border-t pt-6"
    >
      <h2 className="text-ink text-lg font-bold tracking-tight">About</h2>
      {profile.description ? (
        <p className="text-charcoal text-sm whitespace-pre-line">{profile.description}</p>
      ) : null}

      {hasContact ? (
        <dl className="text-charcoal flex flex-col gap-1 text-sm">
          {addressLine ? (
            <div className="flex gap-2">
              <dt className="text-ash w-20 shrink-0">Address</dt>
              <dd>
                {addressLine}
                {directions ? (
                  <>
                    {" · "}
                    <a
                      href={directions}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="hover:text-coral underline"
                    >
                      Get directions
                    </a>
                  </>
                ) : null}
              </dd>
            </div>
          ) : null}
          {profile.phone ? (
            <div className="flex gap-2">
              <dt className="text-ash w-20 shrink-0">Phone</dt>
              <dd>
                <a href={`tel:${profile.phone}`} className="hover:text-coral underline">
                  {profile.phone}
                </a>
              </dd>
            </div>
          ) : null}
          {profile.website ? (
            <div className="flex gap-2">
              <dt className="text-ash w-20 shrink-0">Website</dt>
              <dd>
                <a
                  href={profile.website}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="hover:text-coral break-all underline"
                >
                  {profile.website.replace(/^https:\/\//, "")}
                </a>
              </dd>
            </div>
          ) : null}
        </dl>
      ) : null}

      {hours ? (
        <div className="flex flex-col gap-1">
          <h3 className="text-ink text-sm font-semibold tracking-tight">Opening hours</h3>
          <dl className="text-charcoal flex flex-col gap-0.5 text-sm">
            {hours.map((d) => (
              <div key={d.key} className="flex justify-between gap-4">
                <dt className="text-ash">{d.label}</dt>
                <dd className="tabular-nums">
                  {d.windows.length
                    ? d.windows.map((w) => `${w.start}–${w.end}`).join(", ")
                    : "Closed"}
                </dd>
              </div>
            ))}
          </dl>
        </div>
      ) : null}
    </section>
  );
}
