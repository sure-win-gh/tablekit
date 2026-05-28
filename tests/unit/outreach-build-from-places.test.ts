// Unit tests for lib/outreach/build-from-places.ts — pure transform,
// no I/O. Covers venue-type inference, opening-hours grouping, and
// the top-level buildSeedPayload assembly.

import { describe, expect, it } from "vitest";

import {
  buildSeedPayload,
  inferVenueType,
  placesHoursToServices,
} from "@/lib/outreach/build-from-places";
import type { PlaceDetails, PlaceOpeningPeriod } from "@/lib/google/places";

// Helper — Places API day convention is 0=Sun … 6=Sat.
function period(
  openDay: number,
  open: string,
  closeDay: number,
  close: string,
): PlaceOpeningPeriod {
  const [oh, om] = open.split(":").map(Number) as [number, number];
  const [ch, cm] = close.split(":").map(Number) as [number, number];
  return {
    open: { day: openDay, hour: oh, minute: om },
    close: { day: closeDay, hour: ch, minute: cm },
  };
}

describe("inferVenueType", () => {
  it("returns 'bar_pub' when types contain pub/bar/night_club/wine_bar", () => {
    expect(inferVenueType(["pub", "restaurant", "food"])).toBe("bar_pub");
    expect(inferVenueType(["bar", "point_of_interest"])).toBe("bar_pub");
    expect(inferVenueType(["night_club"])).toBe("bar_pub");
    expect(inferVenueType(["wine_bar", "restaurant"])).toBe("bar_pub");
  });

  it("returns 'cafe' when no pub/bar but a cafe-ish type is present", () => {
    expect(inferVenueType(["cafe", "food"])).toBe("cafe");
    expect(inferVenueType(["coffee_shop"])).toBe("cafe");
    expect(inferVenueType(["bakery"])).toBe("cafe");
  });

  it("defaults to 'restaurant' for everything else", () => {
    expect(inferVenueType(["restaurant", "food"])).toBe("restaurant");
    expect(inferVenueType(["food"])).toBe("restaurant");
    expect(inferVenueType([])).toBe("restaurant");
  });

  it("pub beats restaurant when both are present", () => {
    expect(inferVenueType(["restaurant", "pub"])).toBe("bar_pub");
  });
});

describe("placesHoursToServices", () => {
  it("falls back to the venue template when there are no periods", () => {
    const services = placesHoursToServices([], "restaurant");
    expect(services).toHaveLength(2); // template has Lunch + Dinner
    expect(services.map((s) => s.name).sort()).toEqual(["Dinner", "Lunch"]);
  });

  it("groups single-window every-day opening into one 'Open' service", () => {
    // Café open 08:00–17:00 Mon–Sun.
    const periods = [1, 2, 3, 4, 5, 6, 0].map((d) => period(d, "08:00", d, "17:00"));
    const services = placesHoursToServices(periods, "cafe");
    expect(services).toEqual([
      {
        name: "Open",
        schedule: {
          days: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"],
          start: "08:00",
          end: "17:00",
        },
        turnMinutes: 45,
      },
    ]);
  });

  it("splits a lunch/dinner restaurant into two services with day grouping", () => {
    // Mon–Fri lunch 12:00–15:00 + dinner 18:00–22:00; weekends closed.
    const periods: PlaceOpeningPeriod[] = [];
    for (const d of [1, 2, 3, 4, 5]) {
      periods.push(period(d, "12:00", d, "15:00"));
      periods.push(period(d, "18:00", d, "22:00"));
    }
    const services = placesHoursToServices(periods, "restaurant");

    expect(services).toEqual([
      {
        name: "Lunch",
        schedule: { days: ["mon", "tue", "wed", "thu", "fri"], start: "12:00", end: "15:00" },
        turnMinutes: 75,
      },
      {
        name: "Dinner",
        schedule: { days: ["mon", "tue", "wed", "thu", "fri"], start: "18:00", end: "22:00" },
        turnMinutes: 90,
      },
    ]);
  });

  it("treats a periodless 24h day as 00:00–23:59", () => {
    const all_day: PlaceOpeningPeriod = {
      open: { day: 1, hour: 0, minute: 0 },
      // Intentionally no close — Places signals 24h this way.
    };
    const services = placesHoursToServices([all_day], "bar_pub");
    expect(services).toEqual([
      {
        name: "Open",
        schedule: { days: ["mon"], start: "00:00", end: "23:59" },
        turnMinutes: 60,
      },
    ]);
  });

  it("truncates a cross-midnight bar window at 23:59", () => {
    // Sat 17:00 → Sun 02:00.
    const bar = period(6, "17:00", 0, "02:00");
    const services = placesHoursToServices([bar], "bar_pub");
    expect(services).toHaveLength(1);
    expect(services[0]!.schedule).toEqual({ days: ["sat"], start: "17:00", end: "23:59" });
  });

  it("omits closed days from the resulting services", () => {
    // Café open Mon, Wed, Fri only.
    const periods = [1, 3, 5].map((d) => period(d, "09:00", d, "16:00"));
    const services = placesHoursToServices(periods, "cafe");
    expect(services).toEqual([
      {
        name: "Open",
        schedule: { days: ["mon", "wed", "fri"], start: "09:00", end: "16:00" },
        turnMinutes: 45,
      },
    ]);
  });

  it("collapses duplicate (day, start, end) periods", () => {
    // Google has been known to ship the same period twice on holiday
    // days. We dedupe by Set semantics on the day bucket.
    const dup = period(1, "09:00", 1, "17:00");
    const services = placesHoursToServices([dup, dup], "cafe");
    expect(services).toHaveLength(1);
    expect(services[0]!.schedule.days).toEqual(["mon"]);
  });

  it("names 3+ windows with the Service N pattern instead of meal heuristics", () => {
    const periods = [
      period(1, "09:00", 1, "11:00"),
      period(1, "12:00", 1, "15:00"),
      period(1, "18:00", 1, "22:00"),
    ];
    const services = placesHoursToServices(periods, "restaurant");
    expect(services.map((s) => s.name)).toEqual(["Service 1", "Service 2", "Service 3"]);
  });

  it("preserves canonical Mon-Sun ordering even when Google sends days out of order", () => {
    // Google emits Sun first in its 0=Sun convention; we want mon → sun in output.
    const periods = [0, 6, 1, 2].map((d) => period(d, "10:00", d, "20:00"));
    const services = placesHoursToServices(periods, "restaurant");
    expect(services[0]!.schedule.days).toEqual(["mon", "tue", "sat", "sun"]);
  });
});

describe("buildSeedPayload", () => {
  const restaurant: PlaceDetails = {
    id: "ChIJpadella",
    displayName: "Padella Borough",
    formattedAddress: "6 Southwark St, London SE1 1TQ",
    internationalPhoneNumber: "+44 20 7407 0000",
    websiteUri: "https://padella.co",
    regularOpeningPeriods: [period(1, "12:00", 1, "15:00"), period(1, "18:00", 1, "22:00")],
    types: ["restaurant", "food", "point_of_interest"],
    location: { lat: 51.5055, lng: -0.0908 },
  };

  it("produces an organisation + venue + areas + services payload", () => {
    const seed = buildSeedPayload(restaurant);

    expect(seed.organisation).toEqual({
      name: "Padella Borough",
      outreachSource: "places:ChIJpadella",
    });
    expect(seed.venue).toEqual({ name: "Padella Borough", venueType: "restaurant" });
    // Areas + tables come from the template — restaurant template has Main + Bar.
    expect(seed.areas.map((a) => a.name)).toEqual(["Main", "Bar"]);
    expect(seed.services.map((s) => s.name)).toEqual(["Lunch", "Dinner"]);
  });

  it("uses template fallback hours when Google has none", () => {
    const noHours: PlaceDetails = { ...restaurant, regularOpeningPeriods: [] };
    const seed = buildSeedPayload(noHours);
    expect(seed.services.map((s) => s.name).sort()).toEqual(["Dinner", "Lunch"]);
  });

  it("infers bar_pub for a pub even when restaurant is also tagged", () => {
    const pub: PlaceDetails = {
      ...restaurant,
      displayName: "The Hand & Flowers",
      types: ["restaurant", "pub", "food"],
    };
    const seed = buildSeedPayload(pub);
    expect(seed.venue.venueType).toBe("bar_pub");
    // Bar/pub template has Inside + Outside areas.
    expect(seed.areas.map((a) => a.name)).toEqual(["Inside", "Outside"]);
  });

  it("does not share array references with the underlying template", () => {
    const seed = buildSeedPayload(restaurant);
    seed.areas[0]!.tables[0]!.label = "MUTATED";
    const seedAgain = buildSeedPayload(restaurant);
    expect(seedAgain.areas[0]!.tables[0]!.label).not.toBe("MUTATED");
  });
});
