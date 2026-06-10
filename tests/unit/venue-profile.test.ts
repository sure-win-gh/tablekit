import { describe, expect, it } from "vitest";

import { parseProfile } from "@/lib/venues/profile";

describe("parseProfile", () => {
  it("returns undefined when absent or empty", () => {
    expect(parseProfile(undefined)).toBeUndefined();
    expect(parseProfile({})).toBeUndefined();
    expect(parseProfile({ profile: {} })).toBeUndefined();
    expect(parseProfile({ profile: null })).toBeUndefined();
  });

  it("parses a full valid profile", () => {
    const p = parseProfile({
      profile: {
        description: "Cosy neighbourhood bistro.",
        cuisine: "Modern British",
        priceRange: "££",
        address: { street: "1 High St", city: "Cardiff", postcode: "CF10 1AA" },
        phone: "+44 29 1234 5678",
        website: "https://example.com",
        latitude: 51.48,
        longitude: -3.18,
      },
    });
    expect(p).toEqual({
      description: "Cosy neighbourhood bistro.",
      cuisine: "Modern British",
      priceRange: "££",
      address: { street: "1 High St", city: "Cardiff", postcode: "CF10 1AA" },
      phone: "+44 29 1234 5678",
      website: "https://example.com",
      latitude: 51.48,
      longitude: -3.18,
    });
  });

  it("drops a non-https website (mixed-content guard)", () => {
    const p = parseProfile({ profile: { website: "http://example.com", cuisine: "Thai" } });
    expect(p?.website).toBeUndefined();
    expect(p?.cuisine).toBe("Thai");
  });

  it("drops an invalid price range but keeps the rest (salvage)", () => {
    const p = parseProfile({ profile: { priceRange: "cheap", description: "Great food" } });
    expect(p?.priceRange).toBeUndefined();
    expect(p?.description).toBe("Great food");
  });

  it("rejects out-of-range geo", () => {
    const p = parseProfile({ profile: { latitude: 999, longitude: -3.18, cuisine: "Tapas" } });
    expect(p?.latitude).toBeUndefined();
    expect(p?.longitude).toBe(-3.18);
  });

  it("truncates over-long strings", () => {
    const p = parseProfile({ profile: { description: "x".repeat(3000) } });
    expect(p?.description?.length).toBe(2000);
  });

  it("keeps a partial address and drops empty sub-fields", () => {
    const p = parseProfile({
      profile: { address: { city: "Bristol", street: "", postcode: null } },
    });
    expect(p?.address).toEqual({ city: "Bristol" });
  });

  it("returns undefined when an address is entirely empty", () => {
    const p = parseProfile({ profile: { address: { city: "", street: "" } } });
    expect(p?.address).toBeUndefined();
  });

  it("parses a TripAdvisor rating + https url", () => {
    const p = parseProfile({
      profile: { tripadvisorRating: 4.5, tripadvisorUrl: "https://www.tripadvisor.co.uk/r" },
    });
    expect(p?.tripadvisorRating).toBe(4.5);
    expect(p?.tripadvisorUrl).toBe("https://www.tripadvisor.co.uk/r");
  });

  it("drops an out-of-range TripAdvisor rating and a non-https url", () => {
    const p = parseProfile({
      profile: { tripadvisorRating: 9, tripadvisorUrl: "http://x.com", cuisine: "Thai" },
    });
    expect(p?.tripadvisorRating).toBeUndefined();
    expect(p?.tripadvisorUrl).toBeUndefined();
    expect(p?.cuisine).toBe("Thai");
  });
});
