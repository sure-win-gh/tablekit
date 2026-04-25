import { notFound } from "next/navigation";

import { formatVenueDateLong, todayInZone } from "@/lib/bookings/time";
import { captchaEnabled } from "@/lib/public/captcha";
import { loadPublicAvailability, loadPublicVenue } from "@/lib/public/venue";

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

  const date = sp.date ?? todayInZone(venue.timezone);
  const partySize = sp.party ? Math.max(1, Math.min(20, Number(sp.party))) : 2;

  const availability = await loadPublicAvailability(venue, { date, partySize });

  const pickedSlot =
    sp.serviceId && sp.wallStart
      ? availability.slots.find((s) => s.serviceId === sp.serviceId && s.wallStart === sp.wallStart)
      : undefined;

  const dateLongUtc = availability.slots[0]?.startAt ?? new Date(`${date}T12:00:00Z`);

  return (
    <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-6 p-6">
      <header>
        <p className="text-xs font-semibold tracking-wide text-neutral-500 uppercase">
          Book a table
        </p>
        <h1 className="mt-1 text-3xl font-semibold tracking-tight text-neutral-900">
          {venue.name}
        </h1>
        <p className="mt-1 text-sm text-neutral-500">
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
    </main>
  );
}
