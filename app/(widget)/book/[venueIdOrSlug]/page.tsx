import { notFound, permanentRedirect } from "next/navigation";

import { formatVenueDateLong, todayInZone } from "@/lib/bookings/time";
import { widgetDisabled } from "@/lib/feature-flags";
import { captchaEnabled } from "@/lib/public/captcha";
import {
  loadPublicAvailability,
  loadPublicMonthAvailability,
  loadPublicPhotos,
  loadPublicReviews,
  loadPublicShowcase,
  loadPublicVenueByIdOrSlug,
  type PublicShowcaseReview,
} from "@/lib/public/venue";
import { hasPlan } from "@/lib/auth/plan-level";
import { widgetThemeStyle } from "@/lib/branding/theme";

import { BookingForm, SlotPicker } from "./forms";
import { WidgetHeader, WidgetThemeProvider } from "./branding";
import { AboutSection, VenueInfoHeader } from "./profile";
import { ReviewsSection } from "./reviews";
import { PhotoGallery } from "./gallery";

// Public, unauthenticated booking page. Reads go through adminDb
// helpers in lib/public/venue.ts — RLS doesn't apply to anonymous.
// Writes go through /api/v1/bookings, which rate-limits + captcha-
// verifies before calling the same createBooking domain function
// the host flow uses.
//
// Two layouts share one data load: Free venues get the original simple
// body; Core+ get the rich TheFork-style page (profile + combined
// reviews + gallery/map placeholders). See docs/specs/booking-page.md.

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

  // 308 redirect UUID → slug URL when a slug exists. Preserves search
  // params so a deep-link with ?date=… survives. The iframe embed
  // route deliberately does NOT redirect (would flash the iframe).
  if (matchedBy === "id" && canonicalSlug) {
    const qs = new URLSearchParams();
    if (sp.date) qs.set("date", sp.date);
    if (sp.party) qs.set("party", sp.party);
    if (sp.serviceId) qs.set("serviceId", sp.serviceId);
    if (sp.wallStart) qs.set("wallStart", sp.wallStart);
    if (sp.month) qs.set("month", sp.month);
    const tail = qs.toString() ? `?${qs.toString()}` : "";
    permanentRedirect(`/book/${canonicalSlug}${tail}`);
  }

  // Widget theming is Plus-gated (orthogonal to the rich-page gate below).
  // The rich layout is Core+; Free keeps the original simple body.
  const isPlus = hasPlan(plan, "plus");
  const rich = hasPlan(plan, "core");
  const themeStyle = widgetThemeStyle(branding, { gated: isPlus });
  const logoUrl = isPlus ? (branding?.logoUrl ?? null) : null;

  // Kill switch — operator-facing emergency halt. Renders a venue-
  // specific maintenance message so a guest mid-booking knows it's
  // not them. POST /api/v1/bookings also rejects in this state.
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

  // Validate untrusted params: a garbage ?date / ?party must not feed
  // Invalid Date / NaN into availability (which would silently grey the
  // whole calendar). Fall back to today / party of 2.
  const date =
    sp.date && /^\d{4}-\d{2}-\d{2}$/.test(sp.date) ? sp.date : todayInZone(venue.timezone);
  const partyNum = Number(sp.party);
  const partySize = Number.isFinite(partyNum) ? Math.max(1, Math.min(20, partyNum)) : 2;

  const availability = await loadPublicAvailability(venue, { date, partySize });

  const pickedSlot =
    sp.serviceId && sp.wallStart
      ? availability.slots.find((s) => s.serviceId === sp.serviceId && s.wallStart === sp.wallStart)
      : undefined;

  const dateLongUtc = availability.slots[0]?.startAt ?? new Date(`${date}T12:00:00Z`);

  // Shared slot data. The Free layout uses the native date input; the rich
  // layout swaps in the month calendar (monthAvailability passed below).
  const slotsLite = availability.slots.map((s) => ({
    serviceId: s.serviceId,
    serviceName: s.serviceName,
    wallStart: s.wallStart,
  }));
  const pickedLite = pickedSlot
    ? { serviceId: pickedSlot.serviceId, wallStart: pickedSlot.wallStart }
    : null;
  const slotPicker = (
    <SlotPicker
      venueId={venue.id}
      date={date}
      partySize={partySize}
      slots={slotsLite}
      picked={pickedLite}
    />
  );
  const bookingForm = pickedSlot ? (
    <BookingForm
      venueId={venue.id}
      serviceId={pickedSlot.serviceId}
      date={date}
      wallStart={pickedSlot.wallStart}
      partySize={partySize}
      captchaSitekey={
        captchaEnabled() ? (process.env["NEXT_PUBLIC_HCAPTCHA_SITEKEY"] ?? null) : null
      }
    />
  ) : null;

  // --- Rich page (Core+) -------------------------------------------------
  if (rich) {
    const minMonth = todayInZone(venue.timezone).slice(0, 7);
    // Accept ?month=YYYY-MM (01–12 only); default to the selected date's
    // month, then floor to the current month so a stale/hand-edited past
    // month snaps forward rather than rendering a dead all-greyed grid.
    const monthParam =
      sp.month && /^\d{4}-(0[1-9]|1[0-2])$/.test(sp.month) ? sp.month : date.slice(0, 7);
    const month = monthParam < minMonth ? minMonth : monthParam;
    const [reviews, photos, monthAvailability] = await Promise.all([
      loadPublicReviews(venue.id),
      loadPublicPhotos(venue.id),
      loadPublicMonthAvailability(venue, { month, partySize }),
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

          <section aria-label="Book a table" className="flex flex-col gap-6">
            <SlotPicker
              venueId={venue.id}
              date={date}
              partySize={partySize}
              slots={slotsLite}
              picked={pickedLite}
              monthAvailability={monthAvailability}
              minMonth={minMonth}
            />
            {bookingForm}
          </section>

          {profile ? <AboutSection profile={profile} /> : null}

          {/* Phase 4: map slot (uses profile.latitude / profile.longitude). */}

          <ReviewsSection reviews={reviews} />
        </main>
      </WidgetThemeProvider>
    );
  }

  // --- Simple page (Free) — unchanged ------------------------------------
  const showcase = await loadPublicShowcase(venue.id);
  return (
    <WidgetThemeProvider style={themeStyle}>
      <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-6 p-6">
        <WidgetHeader
          variant="hosted"
          venueName={venue.name}
          logoUrl={logoUrl}
          dateLine={formatVenueDateLong(dateLongUtc, { timezone: venue.timezone })}
        />

        {slotPicker}
        {bookingForm}

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
              {r.submittedAt.toLocaleDateString(undefined, { year: "numeric", month: "short" })}
            </p>
          </li>
        ))}
      </ul>
    </section>
  );
}
