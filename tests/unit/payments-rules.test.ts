// Unit tests for the pure part of the deposit-rule resolver
// (lib/payments/rules.ts#rankRules).
//
// The DB-bound resolveRule is exercised by the integration test; here
// we lock down the priority algorithm and the edge cases around
// wildcards, day-of-week, party-size, and tie-breaks.

import { describe, expect, it } from "vitest";

import { rankRules, type DepositRule } from "@/lib/payments/rules";

const VENUE = "00000000-0000-0000-0000-0000000000aa";
const OTHER_VENUE = "00000000-0000-0000-0000-0000000000bb";
const SVC = "00000000-0000-0000-0000-0000000000cc";
const OTHER_SVC = "00000000-0000-0000-0000-0000000000dd";
const ORG = "00000000-0000-0000-0000-0000000000ee";

function mkRule(overrides: Partial<DepositRule> = {}): DepositRule {
  return {
    id: crypto.randomUUID(),
    organisationId: ORG,
    venueId: VENUE,
    serviceId: null,
    minParty: 1,
    maxParty: null,
    dayOfWeek: [0, 1, 2, 3, 4, 5, 6],
    kind: "flat",
    amountMinor: 2000,
    currency: "GBP",
    refundWindowHours: 24,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

const FRIDAY = new Date("2026-05-08T19:00:00Z"); // day 5

describe("rankRules — filtering", () => {
  it("returns empty for zero rules", () => {
    expect(rankRules([], { venueId: VENUE, serviceId: SVC, partySize: 2, at: FRIDAY })).toEqual([]);
  });

  it("drops rules for another venue", () => {
    const r = mkRule({ venueId: OTHER_VENUE });
    const out = rankRules([r], { venueId: VENUE, serviceId: SVC, partySize: 2, at: FRIDAY });
    expect(out).toEqual([]);
  });

  it("drops rules for a different service (when the rule specifies one)", () => {
    const r = mkRule({ serviceId: OTHER_SVC });
    expect(rankRules([r], { venueId: VENUE, serviceId: SVC, partySize: 2, at: FRIDAY })).toEqual(
      [],
    );
  });

  it("keeps wildcard-service rules", () => {
    const r = mkRule({ serviceId: null });
    expect(rankRules([r], { venueId: VENUE, serviceId: SVC, partySize: 2, at: FRIDAY })).toEqual([
      r,
    ]);
  });

  it("drops rules when party size is below min_party", () => {
    const r = mkRule({ minParty: 5 });
    expect(rankRules([r], { venueId: VENUE, serviceId: SVC, partySize: 4, at: FRIDAY })).toEqual(
      [],
    );
  });

  it("drops rules when party size exceeds max_party", () => {
    const r = mkRule({ maxParty: 4 });
    expect(rankRules([r], { venueId: VENUE, serviceId: SVC, partySize: 6, at: FRIDAY })).toEqual(
      [],
    );
  });

  it("keeps rules when max_party is null (no ceiling)", () => {
    const r = mkRule({ maxParty: null });
    expect(rankRules([r], { venueId: VENUE, serviceId: SVC, partySize: 100, at: FRIDAY })).toEqual([
      r,
    ]);
  });

  it("drops rules whose day_of_week array doesn't include the booking day", () => {
    // Booking is Friday (5); rule fires only on weekends.
    const r = mkRule({ dayOfWeek: [0, 6] });
    expect(rankRules([r], { venueId: VENUE, serviceId: SVC, partySize: 2, at: FRIDAY })).toEqual(
      [],
    );
  });

  it("treats getUTCDay() matchfully — Sunday booking matches [0]-only rule", () => {
    const SUNDAY = new Date("2026-05-10T12:00:00Z"); // day 0
    const r = mkRule({ dayOfWeek: [0] });
    expect(rankRules([r], { venueId: VENUE, serviceId: SVC, partySize: 2, at: SUNDAY })).toEqual([
      r,
    ]);
  });
});

describe("rankRules — priority ordering", () => {
  it("service-match rule beats wildcard rule", () => {
    const wildcard = mkRule({ id: "w", serviceId: null, amountMinor: 1000 });
    const specific = mkRule({ id: "s", serviceId: SVC, amountMinor: 5000 });
    const out = rankRules([wildcard, specific], {
      venueId: VENUE,
      serviceId: SVC,
      partySize: 2,
      at: FRIDAY,
    });
    expect(out.map((r) => r.id)).toEqual(["s", "w"]);
  });

  it("narrower day_of_week wins when service specificity ties", () => {
    const weekend = mkRule({ id: "wkd", dayOfWeek: [5, 6] });
    const allDays = mkRule({ id: "all", dayOfWeek: [0, 1, 2, 3, 4, 5, 6] });
    const out = rankRules([allDays, weekend], {
      venueId: VENUE,
      serviceId: SVC,
      partySize: 2,
      at: FRIDAY,
    });
    expect(out.map((r) => r.id)).toEqual(["wkd", "all"]);
  });

  it("narrower party span wins when service + day specificity tie", () => {
    // Both cover all days, both wildcard on service. a is tighter on party range.
    const tight = mkRule({ id: "t", minParty: 4, maxParty: 6 });
    const loose = mkRule({ id: "l", minParty: 1, maxParty: null });
    const out = rankRules([loose, tight], {
      venueId: VENUE,
      serviceId: SVC,
      partySize: 5,
      at: FRIDAY,
    });
    expect(out.map((r) => r.id)).toEqual(["t", "l"]);
  });

  it("most recently created rule wins on a full tie", () => {
    const older = mkRule({ id: "old", createdAt: new Date("2026-01-01T00:00:00Z") });
    const newer = mkRule({ id: "new", createdAt: new Date("2026-02-01T00:00:00Z") });
    const out = rankRules([older, newer], {
      venueId: VENUE,
      serviceId: SVC,
      partySize: 2,
      at: FRIDAY,
    });
    expect(out.map((r) => r.id)).toEqual(["new", "old"]);
  });

  it("does not surface a rule that filters out even if it has the highest specificity", () => {
    const wrongDay = mkRule({ id: "x", serviceId: SVC, dayOfWeek: [6] }); // Saturday only
    const fallback = mkRule({ id: "y", serviceId: null });
    const out = rankRules([wrongDay, fallback], {
      venueId: VENUE,
      serviceId: SVC,
      partySize: 2,
      at: FRIDAY,
    });
    expect(out.map((r) => r.id)).toEqual(["y"]);
  });
});

describe("rankRules — realistic resolver end-to-end", () => {
  it("picks the right rule out of a mixed set", () => {
    // Venue has three rules:
    //   - weekend-brunch (service-specific, Sun/Sat, 1+): £25
    //   - big-party (wildcard, all days, 8+): £40
    //   - default (wildcard, all days, 1+): £10
    const brunch = mkRule({
      id: "brunch",
      serviceId: SVC,
      dayOfWeek: [0, 6],
      amountMinor: 2500,
    });
    const bigParty = mkRule({
      id: "big",
      minParty: 8,
      amountMinor: 4000,
    });
    const def = mkRule({ id: "def", amountMinor: 1000 });

    // Weekend brunch booking for 4:
    const SUNDAY = new Date("2026-05-10T11:00:00Z");
    const weekendBrunch = rankRules([brunch, bigParty, def], {
      venueId: VENUE,
      serviceId: SVC,
      partySize: 4,
      at: SUNDAY,
    });
    expect(weekendBrunch[0]?.id).toBe("brunch");

    // Friday dinner booking for 10 → big party rule applies.
    const bigFri = rankRules([brunch, bigParty, def], {
      venueId: VENUE,
      serviceId: SVC,
      partySize: 10,
      at: FRIDAY,
    });
    expect(bigFri[0]?.id).toBe("big");

    // Friday dinner booking for 2 → default.
    const smallFri = rankRules([brunch, bigParty, def], {
      venueId: VENUE,
      serviceId: SVC,
      partySize: 2,
      at: FRIDAY,
    });
    expect(smallFri[0]?.id).toBe("def");
  });
});
