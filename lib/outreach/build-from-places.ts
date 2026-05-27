// Pure transformation: Google Places (New) response → seed payload
// shaped like lib/venues/templates.ts. No DB, no I/O — PR 4's server
// action calls this and feeds the result into a transactional insert.
//
// The output is intentionally indistinguishable from the static
// `templates[venueType]` data so the existing createVenue flow can be
// reused with minimal divergence. Areas + tables come from the
// template; only the service hours are derived from Google data.
//
// Why we don't pull areas/tables from Google: Places API doesn't
// expose floor-plan information. We give the prospect a sensible
// starting layout from the template and let them rearrange.

import type {
  TemplateArea,
  TemplateService,
  VenueTemplate,
  VenueType,
} from "@/lib/venues/templates";
import { templates } from "@/lib/venues/templates";

import type { PlaceDetails, PlaceOpeningPeriod } from "@/lib/google/places";

// --- Venue type inference ----------------------------------------------------
//
// Google's `types` array can list many tags per place (e.g. a pub
// might be `["bar", "restaurant", "food", "point_of_interest"]`).
// We probe in priority order: pub/bar wins over restaurant when both
// are present, because the operator can switch to restaurant later
// but the wider opening hours of a pub template are a better starting
// point for a bar-leaning venue.
//
// Gastropub call: a UK gastropub gets tagged `["restaurant", "pub"]`
// by Google and lands here as `"bar_pub"`. That's intentional — they
// trade as pubs first, kitchens second; the bar/pub template's wider
// hours and bar area are the safer default. One click to switch.

const PUB_BAR_TYPES = new Set(["pub", "bar", "night_club", "wine_bar"]);
const CAFE_TYPES = new Set(["cafe", "coffee_shop", "bakery", "tea_house"]);
// Anything else falls through to "restaurant" — Places assigns this
// to most full-service eateries.

export function inferVenueType(types: string[]): VenueType {
  for (const t of types) {
    if (PUB_BAR_TYPES.has(t)) return "bar_pub";
  }
  for (const t of types) {
    if (CAFE_TYPES.has(t)) return "cafe";
  }
  return "restaurant";
}

// --- Hours → services --------------------------------------------------------

type DayKey = "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun";

// Google's day convention is 0=Sunday … 6=Saturday. Ours is named.
const GOOGLE_DAY: Record<number, DayKey> = {
  0: "sun",
  1: "mon",
  2: "tue",
  3: "wed",
  4: "thu",
  5: "fri",
  6: "sat",
};

const DAY_ORDER: DayKey[] = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];

function hhmm(hour: number, minute: number): string {
  return `${hour.toString().padStart(2, "0")}:${minute.toString().padStart(2, "0")}`;
}

type Window = { start: string; end: string };

// Pick a human-readable service name from a window's start time. The
// operator will rename if they want — these are seeds, not contracts.
//
// Heuristic only applies for 1–2 windows (the common Open / Lunch+Dinner
// cases). With 3+ windows the start-hour buckets collide too often
// (e.g. an 11:00 and 13:00 both reading as "Lunch"), so we fall back
// to "Service N" and let the operator name them.
function nameForWindow(window: Window, index: number, total: number): string {
  if (total === 1) return "Open";
  if (total >= 3) return `Service ${index + 1}`;
  const startHour = Number(window.start.slice(0, 2));
  if (startHour < 11) return "Breakfast";
  if (startHour < 15) return "Lunch";
  if (startHour < 18) return "Afternoon";
  if (startHour < 22) return "Dinner";
  return `Service ${index + 1}`;
}

// Default turn time per service heuristic — same numbers the static
// templates use so the seed reads "native".
function turnMinutesFor(window: Window, venueType: VenueType): number {
  if (venueType === "cafe") return 45;
  if (venueType === "bar_pub") return 60;
  const startHour = Number(window.start.slice(0, 2));
  // Bar service inside a restaurant template tends to be shorter; we
  // mirror that by giving early-day windows 60 minutes and dinner 90.
  return startHour < 16 ? 75 : 90;
}

// Convert a list of opening periods into deduped {start,end} → days
// buckets. Cross-midnight periods (e.g. a bar open Sat 17:00 to Sun
// 02:00) are truncated at 23:59 on the open day; we don't model
// cross-day services. The truncation is intentionally lossy — the
// operator can adjust the seed if they actually need a 2am close.
function groupPeriodsByWindow(periods: PlaceOpeningPeriod[]): Map<string, Set<DayKey>> {
  const buckets = new Map<string, Set<DayKey>>();

  for (const p of periods) {
    const openDay = GOOGLE_DAY[p.open.day];
    if (!openDay) continue;

    // A period without `close` is an always-open / 24-hour entry; we
    // emit a single 00:00–23:59 window for the open day.
    const start = hhmm(p.open.hour, p.open.minute);
    let end: string;
    if (!p.close) {
      end = "23:59";
    } else if (p.close.day !== p.open.day) {
      // Cross-midnight: truncate.
      end = "23:59";
    } else {
      end = hhmm(p.close.hour, p.close.minute);
    }

    const key = `${start}-${end}`;
    let days = buckets.get(key);
    if (!days) {
      days = new Set<DayKey>();
      buckets.set(key, days);
    }
    days.add(openDay);
  }

  return buckets;
}

// Returns the template fallback when Google had no hours.
function fallbackServices(venueType: VenueType): TemplateService[] {
  return templates[venueType].services.map((s) => ({
    ...s,
    schedule: { ...s.schedule, days: [...s.schedule.days] },
  }));
}

export function placesHoursToServices(
  periods: PlaceOpeningPeriod[],
  venueType: VenueType,
): TemplateService[] {
  if (periods.length === 0) return fallbackServices(venueType);

  const buckets = groupPeriodsByWindow(periods);

  // Sort windows by start time so naming ("Lunch" then "Dinner")
  // lines up with how a human would scan the list.
  const windows = Array.from(buckets.entries())
    .map(([key, days]) => {
      const [start, end] = key.split("-") as [string, string];
      return { window: { start, end }, days };
    })
    .sort((a, b) => a.window.start.localeCompare(b.window.start));

  return windows.map(({ window, days }, i) => ({
    name: nameForWindow(window, i, windows.length),
    schedule: {
      // Preserve our canonical Mon-Sun ordering — sets don't.
      days: DAY_ORDER.filter((d) => days.has(d)),
      start: window.start,
      end: window.end,
    },
    turnMinutes: turnMinutesFor(window, venueType),
  }));
}

// --- Top-level: full seed payload -------------------------------------------

export type OutreachSeed = {
  organisation: { name: string; outreachSource: string };
  venue: { name: string; venueType: VenueType };
  areas: TemplateArea[];
  services: TemplateService[];
};

export function buildSeedPayload(place: PlaceDetails): OutreachSeed {
  const venueType = inferVenueType(place.types);
  const template: VenueTemplate = templates[venueType];

  return {
    organisation: {
      name: place.displayName,
      outreachSource: `places:${place.id}`,
    },
    venue: {
      name: place.displayName,
      venueType,
    },
    areas: template.areas.map((a) => ({
      name: a.name,
      tables: a.tables.map((t) => ({ ...t, position: { ...t.position } })),
    })),
    services: placesHoursToServices(place.regularOpeningPeriods, venueType),
  };
}
