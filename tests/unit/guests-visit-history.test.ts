import { describe, expect, it } from "vitest";

import { visitLabel } from "@/lib/guests/visit-history";

describe("visitLabel", () => {
  it("labels zero prior visits as first visit", () => {
    expect(visitLabel(0)).toEqual({ text: "First visit", tone: "info", ordinal: 1 });
  });

  it("labels one prior visit as 2nd visit", () => {
    expect(visitLabel(1)).toEqual({ text: "2nd visit", tone: "info", ordinal: 2 });
  });

  it("labels two or more prior visits as a regular with cumulative count", () => {
    expect(visitLabel(2)).toEqual({ text: "Regular · 3 visits", tone: "success", ordinal: 3 });
    expect(visitLabel(7)).toEqual({ text: "Regular · 8 visits", tone: "success", ordinal: 8 });
  });

  it("clamps negative counts to first visit (defensive)", () => {
    expect(visitLabel(-1)).toEqual({ text: "First visit", tone: "info", ordinal: 1 });
  });
});
