// Unit tests for the pure decideMfaGate() function. State-dependent
// behaviour is set explicitly via the MfaState argument so the test
// doesn't need Supabase mocking.

import { describe, expect, it } from "vitest";

import { decideMfaGate, type MfaState } from "@/lib/auth/mfa";

const NO_FACTOR_AAL1: MfaState = {
  hasVerifiedFactor: false,
  factorId: null,
  currentLevel: "aal1",
  nextLevel: "aal1",
};

const HAS_FACTOR_AAL1: MfaState = {
  hasVerifiedFactor: true,
  factorId: "factor-1",
  currentLevel: "aal1",
  nextLevel: "aal2",
};

const HAS_FACTOR_AAL2: MfaState = {
  hasVerifiedFactor: true,
  factorId: "factor-1",
  currentLevel: "aal2",
  nextLevel: "aal2",
};

describe("decideMfaGate", () => {
  it("host: always passes", () => {
    expect(decideMfaGate("host", NO_FACTOR_AAL1)).toEqual({ kind: "pass" });
  });

  it("owner with no factor: enrol", () => {
    expect(decideMfaGate("owner", NO_FACTOR_AAL1)).toEqual({ kind: "enrol", factorId: null });
  });

  it("owner with factor but aal1: challenge", () => {
    expect(decideMfaGate("owner", HAS_FACTOR_AAL1)).toEqual({
      kind: "challenge",
      factorId: "factor-1",
    });
  });

  it("owner with factor + aal2: pass", () => {
    expect(decideMfaGate("owner", HAS_FACTOR_AAL2)).toEqual({ kind: "pass" });
  });

  it("outreachOrigin: false behaves like the default", () => {
    expect(decideMfaGate("manager", NO_FACTOR_AAL1, { outreachOrigin: false })).toEqual({
      kind: "enrol",
      factorId: null,
    });
  });
});

describe("decideMfaGate — outreach grace window", () => {
  const CLAIMED = new Date("2026-06-01T00:00:00Z");
  const WITHIN = new Date("2026-06-05T00:00:00Z"); // 4 days after claim
  const AFTER = new Date("2026-06-10T00:00:00Z"); // 9 days after claim (> 7)

  it("bypasses the wall during the grace window (owner, no factor)", () => {
    expect(
      decideMfaGate("owner", NO_FACTOR_AAL1, {
        outreachOrigin: true,
        outreachClaimedAt: CLAIMED,
        now: WITHIN,
      }),
    ).toEqual({ kind: "pass" });
  });

  it("enforces at exactly the grace boundary (window is half-open)", () => {
    const exactlySevenDays = new Date("2026-06-08T00:00:00Z");
    expect(
      decideMfaGate("owner", NO_FACTOR_AAL1, {
        outreachOrigin: true,
        outreachClaimedAt: CLAIMED,
        now: exactlySevenDays,
      }),
    ).toEqual({ kind: "enrol", factorId: null });
  });

  it("enforces enrolment once the grace window lapses", () => {
    expect(
      decideMfaGate("owner", NO_FACTOR_AAL1, {
        outreachOrigin: true,
        outreachClaimedAt: CLAIMED,
        now: AFTER,
      }),
    ).toEqual({ kind: "enrol", factorId: null });
  });

  it("enforces challenge after grace when a factor exists but session is aal1", () => {
    expect(
      decideMfaGate("owner", HAS_FACTOR_AAL1, {
        outreachOrigin: true,
        outreachClaimedAt: CLAIMED,
        now: AFTER,
      }),
    ).toEqual({ kind: "challenge", factorId: "factor-1" });
  });

  it("never grants an indefinite bypass when claimed_at is missing", () => {
    expect(
      decideMfaGate("owner", NO_FACTOR_AAL1, {
        outreachOrigin: true,
        outreachClaimedAt: null,
        now: WITHIN,
      }),
    ).toEqual({ kind: "enrol", factorId: null });
  });

  it("an outreach owner already at aal2 still passes", () => {
    expect(
      decideMfaGate("owner", HAS_FACTOR_AAL2, {
        outreachOrigin: true,
        outreachClaimedAt: CLAIMED,
        now: AFTER,
      }),
    ).toEqual({ kind: "pass" });
  });

  it("non-outreach owner is unaffected by claimed_at", () => {
    expect(
      decideMfaGate("owner", NO_FACTOR_AAL1, {
        outreachOrigin: false,
        outreachClaimedAt: CLAIMED,
        now: WITHIN,
      }),
    ).toEqual({ kind: "enrol", factorId: null });
  });
});
