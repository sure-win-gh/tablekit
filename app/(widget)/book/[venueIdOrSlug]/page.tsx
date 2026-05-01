import { notFound, permanentRedirect } from "next/navigation";

import { formatVenueDateLong, todayInZone } from "@/lib/bookings/time";
import { widgetDisabled } from "@/lib/feature-flags";
import { captchaEnabled } from "@/lib/public/captcha";
import {
  loadPublicAvailability,
  loadPublicShowcase,
  loadPublicVenueByIdOrSlug,
  type PublicShowcaseReview,
} from "@/lib/public/venue";

import { BookingForm, SlotPicker } from "./forms";

// Public, unauthenticated booking page. Reads go through adminDb
// helpers in lib/public/venue.ts — RLS doesn't apply to anonymous.
// Writes go through /api/v1/bookings, which rate-limits + captcha-
// verifies before calling the same createBooking domain function
// the host flow uses.

export const dynamic = "force-dynamic";

type SearchParams = {
  date?: string;
  party?: string;
  serviceId?: string;
  wallStart?: string;
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
  const { venue, matchedBy, canonicalSlug } = lookup;

  // 308 redirect UUID → slug URL when a slug exists. Preserves search
  // params so a deep-link with ?date=… survives. The iframe embed
  // route deliberately does NOT redirect (would flash the iframe).
  if (matchedBy === "id" && canonicalSlug) {
    const qs = new URLSearchParams();
    if (sp.date) qs.set("date", sp.date);
    if (sp.party) qs.set("party", sp.party);
    if (sp.serviceId) qs.set("serviceId", sp.serviceId);
    if (sp.wallStart) qs.set("wallStart", sp.wallStart);
    const tail = qs.toString() ? `?${qs.toString()}` : "";
    permanentRedirect(`/book/${canonicalSlug}${tail}`);
  }

  // Kill switch — operator-facing emergency halt. Renders a venue-
  // specific maintenance message so a guest mid-booking knows it's
  // not them. POST /api/v1/bookings also rejects in this state.
  if (widgetDisabled()) {
    return (
      <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-4 p-6">
        <header>
          <p className="text-coral text-xs font-semibold tracking-wider uppercase">
            Online booking
          </p>
          <h1 className="text-ink mt-2 text-3xl font-bold tracking-tight">{venue.name}</h1>
        </header>
        <p className="rounded-card border-hairline bg-cloud text-charcoal border p-6 text-sm">
          Online booking is temporarily unavailable. Please call or email the venue directly to make
          a reservation. We&apos;ll have this back up shortly.
        </p>
      </main>
    );
  }

  const date = sp.date ?? todayInZone(venue.timezone);
  const partySize = sp.party ? Math.max(1, Math.min(20, Number(sp.party))) : 2;

  const [availability, showcase] = await Promise.all([
    loadPublicAvailability(venue, { date, partySize }),
    loadPublicShowcase(venue.id),
  ]);

  const pickedSlot =
    sp.serviceId && sp.wallStart
      ? availability.slots.find((s) => s.serviceId === sp.serviceId && s.wallStart === sp.wallStart)
      : undefined;

  const dateLongUtc = availability.slots[0]?.startAt ?? new Date(`${date}T12:00:00Z`);

  return (
    <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-6 p-6">
      <header>
        <p className="text-coral text-xs font-semibold tracking-wider uppercase">Book a table</p>
        <h1 className="text-ink mt-2 text-4xl font-bold tracking-tight">{venue.name}</h1>
        <p className="text-ash mt-1 text-sm">
          {formatVenueDateLong(dateLongUtc, { timezone: venue.timezone })}
        </p>
      </header>

      <SlotPicker
        venueId={venue.id}
        date={date}
        partySize={partySize}
        slots={availability.slots.map((s) => ({
          serviceId: s.serviceId,
          serviceName: s.serviceName,
          wallStart: s.wallStart,
        }))}
        picked={
          pickedSlot ? { serviceId: pickedSlot.serviceId, wallStart: pickedSlot.wallStart } : null
        }
      />

      {pickedSlot ? (
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
      ) : null}

      {showcase.length > 0 ? <ShowcaseSection reviews={showcase} /> : null}
    </main>
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
