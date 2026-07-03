// Derived FAQ for the rich booking page — zero operator authoring. Every
// answer is built from data the venue already provides (opening hours,
// profile fields), so it can never say something the page doesn't. Pure
// (no server-only) so it's unit-testable: tests/unit/public-faq.test.ts.

import type { VenueProfile } from "@/lib/venues/profile";

export type FaqItem = { q: string; a: string };

type OpeningDayLike = { label: string; windows: { start: string; end: string }[] };

const PRICE_WORDING: Record<string, string> = {
  "£": "budget-friendly (£)",
  "££": "moderately priced (££)",
  "£££": "on the pricier side (£££)",
  "££££": "a special-occasion spot (££££)",
};

export function buildFaq(input: {
  venueName: string;
  profile: VenueProfile | undefined;
  openingHours?: OpeningDayLike[] | undefined;
}): FaqItem[] {
  const { venueName, profile, openingHours } = input;
  const out: FaqItem[] = [];

  out.push({
    q: `Can I book a table at ${venueName} online?`,
    a: "Yes — pick a party size, date and time on this page. Booking is free and confirmation is instant.",
  });

  const openDays = (openingHours ?? []).filter((d) => d.windows.length > 0);
  if (openDays.length > 0) {
    const hours = openDays
      .map((d) => `${d.label} ${d.windows.map((w) => `${w.start}–${w.end}`).join(", ")}`)
      .join(" · ");
    out.push({ q: `When is ${venueName} open?`, a: hours });
  }

  if (profile?.cuisine) {
    out.push({
      q: `What kind of food does ${venueName} serve?`,
      a: `${venueName} serves ${profile.cuisine}.`,
    });
  }

  if (profile?.priceRange && PRICE_WORDING[profile.priceRange]) {
    out.push({
      q: `How expensive is ${venueName}?`,
      a: `Guests rate it as ${PRICE_WORDING[profile.priceRange]}.`,
    });
  }

  const addr = [profile?.address?.street, profile?.address?.city, profile?.address?.postcode]
    .filter(Boolean)
    .join(", ");
  if (addr) {
    out.push({ q: `Where is ${venueName}?`, a: addr });
  }

  return out;
}
