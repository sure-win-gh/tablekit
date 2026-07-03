// buildFaq — derived FAQ for the rich booking page. Every answer must be
// grounded in provided data; missing data drops the question entirely.

import { describe, expect, it } from "vitest";

import { buildFaq } from "@/lib/public/faq";

const HOURS = [
  { label: "Monday", windows: [{ start: "12:00", end: "22:00" }] },
  { label: "Tuesday", windows: [] },
  {
    label: "Saturday",
    windows: [
      { start: "12:00", end: "15:00" },
      { start: "18:00", end: "23:00" },
    ],
  },
];

describe("buildFaq", () => {
  it("always includes the booking question", () => {
    const faq = buildFaq({ venueName: "Noko", profile: undefined, openingHours: undefined });
    expect(faq).toHaveLength(1);
    expect(faq[0]?.q).toContain("book a table at Noko");
    expect(faq[0]?.a).toContain("instant");
  });

  it("builds hours from open days only, joining split windows", () => {
    const faq = buildFaq({ venueName: "Noko", profile: undefined, openingHours: HOURS });
    const hours = faq.find((f) => f.q.includes("open"));
    expect(hours?.a).toContain("Monday 12:00–22:00");
    expect(hours?.a).toContain("Saturday 12:00–15:00, 18:00–23:00");
    expect(hours?.a).not.toContain("Tuesday");
  });

  it("includes cuisine, price wording, and address when present", () => {
    const faq = buildFaq({
      venueName: "Noko",
      profile: {
        cuisine: "Modern Asian",
        priceRange: "££",
        address: { street: "11 Sayer Street", city: "London", postcode: "SE17 1FY" },
      },
      openingHours: [],
    });
    expect(faq.find((f) => f.q.includes("food"))?.a).toBe("Noko serves Modern Asian.");
    expect(faq.find((f) => f.q.includes("expensive"))?.a).toContain("moderately priced");
    expect(faq.find((f) => f.q.includes("Where"))?.a).toBe("11 Sayer Street, London, SE17 1FY");
  });

  it("drops questions whose data is absent", () => {
    const faq = buildFaq({ venueName: "Noko", profile: {}, openingHours: [] });
    expect(faq.some((f) => f.q.includes("food"))).toBe(false);
    expect(faq.some((f) => f.q.includes("expensive"))).toBe(false);
    expect(faq.some((f) => f.q.includes("Where"))).toBe(false);
    expect(faq.some((f) => f.q.includes("open"))).toBe(false);
  });
});
