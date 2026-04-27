import { notFound } from "next/navigation";

import { formatVenueDateLong, todayInZone } from "@/lib/bookings/time";
import { widgetDisabled } from "@/lib/feature-flags";
import { captchaEnabled } from "@/lib/public/captcha";
import {
  loadPublicAvailability,
  loadPublicShowcase,
  loadPublicVenue,
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

export async function generateMetadata({ params }: { params: Promise<{ venueId: string }> }) {
  const { venueId } = await params;
  const venue = await loadPublicVenue(venueId);
  return { title: venue ? `Book at ${venue.name} · TableKit` : "Book · TableKit" };
}

export default async function PublicBookingPage({
  params,
  searchParams,
}: {
  params: Promise<{ venueId: string }>;
  searchParams: Promise<SearchParams>;
}) {
  const { venueId } = await params;
  const sp = await searchParams;
  const venue = await loadPublicVenue(venueId);
  if (!venue) notFound();

  // Kill switch — operator-facing emergency halt. Renders a venue-
  // specific maintenance message so a guest mid-booking knows it's
  // not them. POST /api/v1/bookings also rejects in this state.
  if (widgetDisabled()) {
    return (
      <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-4 p-6">
        <header>
          <p className="text-xs font-semibold uppercase tracking-wider text-coral">
            Online booking
          </p>
          <h1 className="mt-2 text-3xl font-bold tracking-tight text-ink">{venue.name}</h1>
        </header>
        <p className="rounded-card border border-hairline bg-cloud p-6 text-sm text-charcoal">
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
    loadPublicShowcase(venueId),
  ]);

  const pickedSlot =
    sp.serviceId && sp.wallStart
      ? availability.slots.find((s) => s.serviceId === sp.serviceId && s.wallStart === sp.wallStart)
      : undefined;

  const dateLongUtc = availability.slots[0]?.startAt ?? new Date(`${date}T12:00:00Z`);

  return (
    <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-6 p-6">
      <header>
        <p className="text-xs font-semibold uppercase tracking-wider text-coral">
          Book a table
        </p>
        <h1 className="mt-2 text-4xl font-bold tracking-tight text-ink">
          {venue.name}
        </h1>
        <p className="mt-1 text-sm text-ash">
          {formatVenueDateLong(dateLongUtc, { timezone: venue.timezone })}
        </p>
      </header>

      <SlotPicker
        venueId={venueId}
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
          venueId={venueId}
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
      className="flex flex-col gap-3 border-t border-hairline pt-6"
    >
      <h2 className="text-sm font-semibold uppercase tracking-wider text-ash">
        Recent guests said
      </h2>
      <ul className="flex flex-col gap-3">
        {reviews.map((r) => (
          <li
            key={r.id}
            className="rounded-card border border-hairline bg-white p-4 text-sm text-charcoal"
          >
            <p className="text-coral" aria-label={`${r.rating} stars`}>
              {"★".repeat(r.rating)}
              <span className="text-stone">{"★".repeat(5 - r.rating)}</span>
            </p>
            <p className="mt-2 whitespace-pre-line">{r.comment}</p>
            <p className="mt-2 text-xs text-ash">
              — {r.firstName},{" "}
              {r.submittedAt.toLocaleDateString(undefined, { year: "numeric", month: "short" })}
            </p>
          </li>
        ))}
      </ul>
    </section>
  );
}
