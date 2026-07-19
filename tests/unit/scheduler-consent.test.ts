import { describe, expect, it, vi } from "vitest";

import {
  readSchedulerConsent,
  SCHEDULER_CONSENT_KEY,
  SCHEDULER_CONSENT_VALUE,
  writeSchedulerConsent,
} from "@/lib/marketing/scheduler-consent";

// The consent gate for the /demo Cal.com embed (demo-scheduler.md). Locks the
// privacy-critical guarantee: nothing reads as consented until it's explicitly
// written, and storage failures never throw or falsely consent.

function fakeStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    _map: map,
  };
}

describe("scheduler consent", () => {
  it("defaults to NOT consented when nothing is stored", () => {
    expect(readSchedulerConsent(fakeStorage())).toBe(false);
  });

  it("reads consented only after the exact flag is written", () => {
    const s = fakeStorage();
    expect(readSchedulerConsent(s)).toBe(false);
    writeSchedulerConsent(s);
    expect(s._map.get(SCHEDULER_CONSENT_KEY)).toBe(SCHEDULER_CONSENT_VALUE);
    expect(readSchedulerConsent(s)).toBe(true);
  });

  it("treats a different stored value as not consented", () => {
    expect(readSchedulerConsent(fakeStorage({ [SCHEDULER_CONSENT_KEY]: "0" }))).toBe(false);
    expect(readSchedulerConsent(fakeStorage({ [SCHEDULER_CONSENT_KEY]: "true" }))).toBe(false);
  });

  it("null/absent storage (SSR, no window) ⇒ not consented, no throw", () => {
    expect(readSchedulerConsent(null)).toBe(false);
    expect(readSchedulerConsent(undefined)).toBe(false);
    expect(() => writeSchedulerConsent(null)).not.toThrow();
  });

  it("storage that throws (private mode / sandbox) is swallowed", () => {
    const throwing = {
      getItem: vi.fn(() => {
        throw new Error("SecurityError");
      }),
      setItem: vi.fn(() => {
        throw new Error("SecurityError");
      }),
    };
    // Read must not throw and must fail closed (gated).
    expect(readSchedulerConsent(throwing)).toBe(false);
    // Write must not throw even though setItem does.
    expect(() => writeSchedulerConsent(throwing)).not.toThrow();
    expect(throwing.setItem).toHaveBeenCalledOnce();
  });
});
