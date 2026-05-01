import { notFound } from "next/navigation";

import { formatVenueDateLong, todayInZone } from "@/lib/bookings/time";
import { widgetDisabled } from "@/lib/feature-flags";
import { captchaEnabled } from "@/lib/public/captcha";
import { loadPublicAvailability, loadPublicVenueByIdOrSlug } from "@/lib/public/venue";

import { BookingForm, SlotPicker } from "../../book/[venueIdOrSlug]/forms";
import { EmbedAutoHeight } from "./auto-height";

// Iframe target for the embeddable widget. Mirrors /book/<venueId>
// but skips the showcase reviews + the cookie banner (parent site
// owns cookie consent) and mounts EmbedAutoHeight so the loader can
// size the iframe to content.

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
  return { title: lookup ? `Book at ${lookup.venue.name}` : "Book" };
}

export default async function EmbedBookingPage({
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
  const { venue } = lookup;
  // The embed deliberately does NOT redirect UUID → slug — the iframe
  // URL is set once by the loader script and a redirect would flash
  // the iframe.

  if (widgetDisabled()) {
    return (
      <main className="mx-auto flex w-full max-w-2xl flex-col gap-3 p-4">
        <h1 className="text-ink text-xl font-bold tracking-tight">{venue.name}</h1>
        <p className="rounded-card border-hairline bg-cloud text-charcoal border p-4 text-sm">
          Online booking is temporarily unavailable. Please contact the venue directly.
        </p>
        <EmbedAutoHeight />
      </main>
    );
  }

  const date = sp.date ?? todayInZone(venue.timezone);
  const partySize = sp.party ? Math.max(1, Math.min(20, Number(sp.party))) : 2;

  const availability = await loadPublicAvailability(venue, { date, partySize });

  const pickedSlot =
    sp.serviceId && sp.wallStart
      ? availability.slots.find((s) => s.serviceId === sp.serviceId && s.wallStart === sp.wallStart)
      : undefined;

  const dateLongUtc = availability.slots[0]?.startAt ?? new Date(`${date}T12:00:00Z`);

  return (
    <main className="mx-auto flex w-full max-w-2xl flex-col gap-5 p-4">
      <header>
        <h1 className="text-ink text-2xl font-bold tracking-tight">{venue.name}</h1>
        <p className="text-ash mt-0.5 text-xs">
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

      <EmbedAutoHeight />
    </main>
  );
}
