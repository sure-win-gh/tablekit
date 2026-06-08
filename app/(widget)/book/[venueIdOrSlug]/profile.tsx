// Rich booking-page profile sections (Core+). Server components.
// VenueInfoHeader = the TheFork-style top block (logo/name + cuisine, price,
// aggregate rating). AboutSection = description + address + contact.
// See docs/specs/booking-page.md.

import { Badge } from "@/components/ui";
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
  return (
    <header className="flex flex-col gap-3">
      <p className="text-coral text-xs font-semibold tracking-wider uppercase">Book a table</p>
      {logoUrl ? (
        // Plain <img>, not next/image — operator logos are arbitrary HTTPS
        // hosts (see branding.tsx for the SSRF rationale). CSP img-src https:.
        // eslint-disable-next-line @next/next/no-img-element
        <img src={logoUrl} alt={venueName} loading="lazy" className="h-12 w-auto" />
      ) : (
        <h1 className="text-ink text-4xl font-bold tracking-tight">{venueName}</h1>
      )}
      {logoUrl ? <h1 className="text-ink text-2xl font-bold tracking-tight">{venueName}</h1> : null}
      <div className="text-ash flex flex-wrap items-center gap-x-3 gap-y-2 text-sm">
        {profile?.cuisine ? <Badge tone="coral">{profile.cuisine}</Badge> : null}
        {profile?.priceRange ? (
          <span className="text-charcoal font-medium">{profile.priceRange}</span>
        ) : null}
        {reviewCount > 0 ? <StarRating rating={average} count={reviewCount} size="sm" /> : null}
      </div>
    </header>
  );
}

export function AboutSection({ profile }: { profile: VenueProfile }) {
  const addressLine = [profile.address?.street, profile.address?.city, profile.address?.postcode]
    .filter(Boolean)
    .join(", ");
  const hasContact = Boolean(profile.phone || profile.website || addressLine);
  if (!profile.description && !hasContact) return null;

  return (
    <section
      aria-label="About this venue"
      className="border-hairline flex flex-col gap-3 border-t pt-6"
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
              <dd>{addressLine}</dd>
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
    </section>
  );
}
