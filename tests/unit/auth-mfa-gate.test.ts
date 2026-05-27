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

  it("outreachOrigin bypasses the gate even for owner with no factor", () => {
    expect(decideMfaGate("owner", NO_FACTOR_AAL1, { outreachOrigin: true })).toEqual({
      kind: "pass",
    });
  });

  it("outreachOrigin bypasses challenge state too", () => {
    expect(decideMfaGate("owner", HAS_FACTOR_AAL1, { outreachOrigin: true })).toEqual({
      kind: "pass",
    });
  });

  it("outreachOrigin: false behaves like the default", () => {
    expect(decideMfaGate("manager", NO_FACTOR_AAL1, { outreachOrigin: false })).toEqual({
      kind: "enrol",
      factorId: null,
    });
  });
});
