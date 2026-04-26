// Unit tests for the feature-flag readers.
//
// These flags are env-driven kill switches. The tests pin the
// truthy-string semantics + confirm unset / falsy values stay false.
// Each `it` saves and restores the env var to keep test order
// independent.

import { afterEach, describe, expect, it } from "vitest";

import { bookingsReadOnly, rwgDisabled, widgetDisabled } from "@/lib/feature-flags";

const ENV_VARS = ["WIDGET_DISABLED", "BOOKINGS_READ_ONLY", "RWG_DISABLED"] as const;
const saved: Record<string, string | undefined> = {};

afterEach(() => {
  for (const k of ENV_VARS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
    delete saved[k];
  }
});

function setEnv(k: string, v: string | undefined) {
  saved[k] = process.env[k];
  if (v === undefined) delete process.env[k];
  else process.env[k] = v;
}

describe("feature flags", () => {
  it("default to false when unset", () => {
    setEnv("WIDGET_DISABLED", undefined);
    setEnv("BOOKINGS_READ_ONLY", undefined);
    setEnv("RWG_DISABLED", undefined);
    expect(widgetDisabled()).toBe(false);
    expect(bookingsReadOnly()).toBe(false);
    expect(rwgDisabled()).toBe(false);
  });

  it("treat 1 / true / yes / on as truthy (case-insensitive)", () => {
    for (const v of ["1", "true", "TRUE", "yes", "Yes", "on", "ON", " true ", " 1 "]) {
      setEnv("WIDGET_DISABLED", v);
      expect(widgetDisabled(), `value=${JSON.stringify(v)}`).toBe(true);
    }
  });

  it("treat 0 / false / empty / arbitrary strings as falsy", () => {
    for (const v of ["0", "false", "no", "off", "", "maybe"]) {
      setEnv("WIDGET_DISABLED", v);
      expect(widgetDisabled(), `value=${JSON.stringify(v)}`).toBe(false);
    }
  });

  it("BOOKINGS_READ_ONLY is independent of WIDGET_DISABLED", () => {
    setEnv("WIDGET_DISABLED", undefined);
    setEnv("BOOKINGS_READ_ONLY", "1");
    expect(widgetDisabled()).toBe(false);
    expect(bookingsReadOnly()).toBe(true);
  });

  it("RWG_DISABLED reads RWG_DISABLED only", () => {
    setEnv("RWG_DISABLED", "true");
    expect(rwgDisabled()).toBe(true);
    setEnv("RWG_DISABLED", undefined);
    expect(rwgDisabled()).toBe(false);
  });
});
