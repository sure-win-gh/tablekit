import { notFound, permanentRedirect } from "next/navigation";

import { widgetDisabled } from "@/lib/feature-flags";
import { captchaEnabled } from "@/lib/public/captcha";
import {
  loadPublicOpeningHours,
  loadPublicPhotos,
  loadPublicReviews,
  loadPublicShowcase,
  loadPublicVenueByIdOrSlug,
  type PublicShowcaseReview,
} from "@/lib/public/venue";
import { hasPlan } from "@/lib/auth/plan-level";
import { widgetThemeStyle } from "@/lib/branding/theme";

import { WidgetHeader, WidgetThemeProvider } from "./branding";
import { BookingWizard } from "./booking-wizard";
import { AboutSection, VenueInfoHeader } from "./profile";
import { ReviewsSection } from "./reviews";
import { PhotoGallery } from "./gallery";

// Public, unauthenticated booking page. Reads go through adminDb helpers in
// lib/public/venue.ts — RLS doesn't apply to anonymous. The booking itself is
// the conversational wizard (Party → Date → Time → Details), identical on
// every surface; only the surrounding chrome differs (rich Core+ vs Free).
// See docs/specs/booking-page.md.

export const dynamic = "force-dynamic";

type SearchParams = {
  date?: string;
  party?: string;
  serviceId?: string;
  wallStart?: string;
  month?: string;
};

export async function generateMetadata({ params }: { params: Promise<{ venueIdOrSlug: string }> }) {
  const { venueIdOrSlug } = await params;
  const lookup = await loadPublicVenueByIdOrSlug(venueIdOrSlug);
  return {
    title: lookup ? `Book at ${lookup.venue.name} · TableKit` : "Book · TableKit",
  };
}

export default async function PublicBookingPage({
  params,
  searchParams,
}: {
  params: Promise<{ venueIdOrSlug: string }>;
  searchParams: Promise<SearchParams>;
}) {
  const { venueIdOrSlug } = await params;
  const sp = await searchParams;
  const lookup = await loadPublicVenueByIdOrSlug(venueIdOrSlug);
  if (!lookup) notFound();
  const { venue, matchedBy, canonicalSlug, plan, branding, profile } = lookup;

  // 308 redirect UUID → slug URL when a slug exists. Preserves wizard params
  // so a deep-link survives. The iframe embed deliberately does NOT redirect.
  if (matchedBy === "id" && canonicalSlug) {
    const qs = new URLSearchParams();
    if (sp.party) qs.set("party", sp.party);
    if (sp.date) qs.set("date", sp.date);
    if (sp.month) qs.set("month", sp.month);
    if (sp.serviceId) qs.set("serviceId", sp.serviceId);
    if (sp.wallStart) qs.set("wallStart", sp.wallStart);
    const tail = qs.toString() ? `?${qs.toString()}` : "";
    permanentRedirect(`/book/${canonicalSlug}${tail}`);
  }

  // Widget theming is Plus-gated (orthogonal to the rich-page gate below).
  // The rich layout is Core+; Free keeps the simple chrome. The wizard flow
  // itself is identical on both.
  const isPlus = hasPlan(plan, "plus");
  const rich = hasPlan(plan, "core");
  const themeStyle = widgetThemeStyle(branding, { gated: isPlus });
  const logoUrl = isPlus ? (branding?.logoUrl ?? null) : null;
  const captchaSitekey = captchaEnabled()
    ? (process.env["NEXT_PUBLIC_HCAPTCHA_SITEKEY"] ?? null)
    : null;
  const basePath = `/book/${venueIdOrSlug}`;

  // Kill switch — operator-facing emergency halt.
  if (widgetDisabled()) {
    return (
      <WidgetThemeProvider style={themeStyle}>
        <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-4 p-6">
          <header>
            <p className="text-coral text-xs font-semibold tracking-wider uppercase">
              Online booking
            </p>
            <h1 className="text-ink mt-2 text-3xl font-bold tracking-tight">{venue.name}</h1>
          </header>
          <p className="rounded-card border-hairline bg-cloud text-charcoal border p-6 text-sm">
            Online booking is temporarily unavailable. Please call or email the venue directly to
            make a reservation. We&apos;ll have this back up shortly.
          </p>
        </main>
      </WidgetThemeProvider>
    );
  }

  const wizard = (
    <BookingWizard venue={venue} basePath={basePath} captchaSitekey={captchaSitekey} sp={sp} />
  );

  // --- Rich page (Core+) -------------------------------------------------
  if (rich) {
    const [reviews, photos, openingHours] = await Promise.all([
      loadPublicReviews(venue.id),
      loadPublicPhotos(venue.id),
      loadPublicOpeningHours(venue.id),
    ]);
    return (
      <WidgetThemeProvider style={themeStyle}>
        <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-8 p-6">
          <VenueInfoHeader
            venueName={venue.name}
            logoUrl={logoUrl}
            profile={profile}
            average={reviews.average}
            reviewCount={reviews.count}
          />

          {photos.length > 0 ? <PhotoGallery photos={photos} venueName={venue.name} /> : null}

          {wizard}

          <AboutSection profile={profile ?? {}} openingHours={openingHours} />

          <ReviewsSection reviews={reviews} />
        </main>
      </WidgetThemeProvider>
    );
  }

  // --- Simple page (Free) ------------------------------------------------
  const showcase = await loadPublicShowcase(venue.id);
  return (
    <WidgetThemeProvider style={themeStyle}>
      <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-6 p-6">
        <WidgetHeader variant="hosted" venueName={venue.name} logoUrl={logoUrl} />

        {wizard}

        {showcase.length > 0 ? <ShowcaseSection reviews={showcase} /> : null}
      </main>
    </WidgetThemeProvider>
  );
}

function ShowcaseSection({ reviews }: { reviews: PublicShowcaseReview[] }) {
  return (
    <section
      aria-label="Recent guest reviews"
      className="border-hairline flex flex-col gap-3 border-t pt-6"
    >
      <h2 className="text-ash text-sm font-semibold tracking-wider uppercase">
        Recent guests said
      </h2>
      <ul className="flex flex-col gap-3">
        {reviews.map((r) => (
          <li
            key={r.id}
            className="rounded-card border-hairline text-charcoal border bg-white p-4 text-sm"
          >
            <p className="text-coral" aria-label={`${r.rating} stars`}>
              {"★".repeat(r.rating)}
              <span className="text-stone">{"★".repeat(5 - r.rating)}</span>
            </p>
            <p className="mt-2 whitespace-pre-line">{r.comment}</p>
            <p className="text-ash mt-2 text-xs">
              — {r.firstName},{" "}
              {r.submittedAt.toLocaleDateString("en-GB", { year: "numeric", month: "short" })}
            </p>
          </li>
        ))}
      </ul>
    </section>
  );
}
