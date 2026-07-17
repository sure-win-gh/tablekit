import { notFound } from "next/navigation";
import Link from "next/link";
import { CalendarDays, ExternalLink, Ticket } from "lucide-react";

import { captchaEnabled } from "@/lib/public/captcha";
import {
  eventCheckoutAvailable,
  loadPublicEvent,
  loadPublicEventAreaNames,
  loadPublicEventTicketTypes,
} from "@/lib/public/events";
import { loadPublicVenueByIdOrSlug } from "@/lib/public/venue";

import { EventCheckout } from "./checkout";

type Params = Promise<{ venueSlug: string; eventSlug: string }>;

export async function generateMetadata({ params }: { params: Params }) {
  const { venueSlug, eventSlug } = await params;
  const lookup = await loadPublicVenueByIdOrSlug(venueSlug);
  if (!lookup) return { title: "Event · TableKit" };
  const event = await loadPublicEvent(lookup.venue.id, eventSlug);
  return { title: event ? `${event.name} · ${lookup.venue.name}` : "Event · TableKit" };
}

export default async function PublicEventPage({ params }: { params: Params }) {
  const { venueSlug, eventSlug } = await params;

  const lookup = await loadPublicVenueByIdOrSlug(venueSlug);
  if (!lookup) notFound();
  const { venue } = lookup;

  const event = await loadPublicEvent(venue.id, eventSlug);
  if (!event) notFound();

  const [ticketTypes, areaNames, checkoutAvailable] = await Promise.all([
    loadPublicEventTicketTypes(event.id),
    loadPublicEventAreaNames(event.id),
    // Stripe kill switch / disconnected account / plan downgrade →
    // degrade to link-out or "contact the venue" instead of a form
    // that fails at the last step.
    eventCheckoutAvailable(event.id),
  ]);
  const captchaSitekey = captchaEnabled()
    ? (process.env["NEXT_PUBLIC_HCAPTCHA_SITEKEY"] ?? null)
    : null;

  const dateLabel = new Intl.DateTimeFormat("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: venue.timezone,
  }).format(event.startsAt);

  const timeFmt = new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: venue.timezone,
  });
  const timeLabel =
    event.blockScope === "whole_day"
      ? "All day"
      : `${timeFmt.format(event.startsAt)} – ${timeFmt.format(event.endsAt)}`;

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-xl flex-col gap-6 px-5 py-10">
      <div className="flex flex-col gap-1">
        <span className="text-ash text-sm font-medium">{venue.name}</span>
        <h1 className="text-ink text-2xl font-bold tracking-tight">{event.name}</h1>
      </div>

      <div className="border-hairline rounded-card flex flex-col gap-3 border bg-white p-5">
        <div className="text-ink flex items-center gap-2 text-sm font-semibold">
          <CalendarDays className="text-ash h-4 w-4" aria-hidden />
          <span>
            {dateLabel}
            <span className="text-ash font-normal">
              {" · "}
              {timeLabel}
              {areaNames.length > 0 ? ` · ${areaNames.join(" + ")}` : ""}
            </span>
          </span>
        </div>

        {event.description ? (
          <p className="text-charcoal text-sm whitespace-pre-wrap">{event.description}</p>
        ) : null}
      </div>

      {ticketTypes.length > 0 && checkoutAvailable ? (
        <EventCheckout
          eventId={event.id}
          venueName={venue.name}
          ticketTypes={ticketTypes}
          captchaSitekey={captchaSitekey}
        />
      ) : event.externalTicketUrl ? (
        <a
          href={event.externalTicketUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="bg-ink hover:bg-charcoal rounded-input inline-flex items-center justify-center gap-2 px-4 py-2.5 text-sm font-semibold text-white transition"
        >
          <Ticket className="h-4 w-4" aria-hidden />
          Get tickets
          <ExternalLink className="h-3.5 w-3.5 opacity-80" aria-hidden />
        </a>
      ) : (
        <p className="border-hairline text-ash rounded-input border border-dashed bg-white px-4 py-3 text-center text-sm">
          Tickets for this event aren&rsquo;t on sale online yet — contact {venue.name} to book.
        </p>
      )}

      <Link href={`/book/${venueSlug}`} className="text-ash hover:text-ink text-sm font-medium">
        ← Back to {venue.name}
      </Link>
    </main>
  );
}
