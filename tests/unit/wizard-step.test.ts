import { describe, expect, it } from "vitest";

import { buildStepUrl, deriveStep, floorMonth, validParty } from "@/lib/public/wizard-step";

describe("validParty", () => {
  it("accepts 1–20 integers", () => {
    expect(validParty("1")).toBe(1);
    expect(validParty("20")).toBe(20);
  });
  it("rejects junk / out of range / non-integers", () => {
    expect(validParty(undefined)).toBeUndefined();
    expect(validParty("")).toBeUndefined();
    expect(validParty("abc")).toBeUndefined();
    expect(validParty("0")).toBeUndefined();
    expect(validParty("21")).toBeUndefined();
    expect(validParty("2.5")).toBeUndefined();
  });
});

describe("deriveStep", () => {
  it("party step when no party", () => {
    expect(deriveStep({})).toEqual({ step: "party", params: {} });
  });
  it("party step when party is invalid", () => {
    expect(deriveStep({ party: "abc" })).toEqual({ step: "party", params: {} });
  });
  it("date step when party set, no date (keeps browse month)", () => {
    expect(deriveStep({ party: "4", month: "2027-06" })).toEqual({
      step: "date",
      params: { party: 4, month: "2027-06" },
    });
  });
  it("time step when party + date set, no slot", () => {
    expect(deriveStep({ party: "4", date: "2027-06-12" })).toEqual({
      step: "time",
      params: { party: 4, date: "2027-06-12" },
    });
  });
  it("details step when party + date + slot set", () => {
    expect(
      deriveStep({ party: "4", date: "2027-06-12", serviceId: "svc", wallStart: "19:00" }),
    ).toEqual({
      step: "details",
      params: { party: 4, date: "2027-06-12", serviceId: "svc", wallStart: "19:00" },
    });
  });

  it("drops orphan later params (date/slot without party → party step)", () => {
    expect(deriveStep({ date: "2027-06-12", serviceId: "s", wallStart: "19:00" })).toEqual({
      step: "party",
      params: {},
    });
  });
  it("drops orphan slot when date missing (→ date step, party kept)", () => {
    expect(deriveStep({ party: "4", serviceId: "s", wallStart: "19:00" })).toEqual({
      step: "date",
      params: { party: 4 },
    });
  });
  it("ignores month outside the date step", () => {
    expect(deriveStep({ party: "4", date: "2027-06-12", month: "2027-07" })).toEqual({
      step: "time",
      params: { party: 4, date: "2027-06-12" },
    });
  });
});

describe("buildStepUrl", () => {
  it("omits absent keys", () => {
    expect(buildStepUrl({})).toBe("");
    expect(buildStepUrl({ party: 4 })).toBe("party=4");
    expect(buildStepUrl({ party: 4, date: "2027-06-12", month: "2027-06" })).toBe(
      "party=4&date=2027-06-12&month=2027-06",
    );
  });
  it("round-trips clear-forward edit params", () => {
    // edit "time" keeps party + date + month, drops the slot
    expect(buildStepUrl({ party: 2, date: "2027-06-12", month: "2027-06" })).toBe(
      "party=2&date=2027-06-12&month=2027-06",
    );
  });
});

describe("floorMonth", () => {
  it("floors a past month to the minimum", () => {
    expect(floorMonth("2020-01", "2026-06")).toBe("2026-06");
    expect(floorMonth("2027-01", "2026-06")).toBe("2027-01");
  });
});
