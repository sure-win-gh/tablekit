// Unit tests for the unsubscribe token helpers.
//
// Sign + verify round-trip, tamper detection, channel mismatch
// rejection. The pure parts of enqueue.ts (backoffMs, truncateError)
// are exercised here too — the dispatch worker's loop is exercised
// by the integration test in wave 7.

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { backoffMs, truncateError } from "@/lib/messaging/enqueue";

const originalMaster = process.env["TABLEKIT_MASTER_KEY"];

beforeAll(() => {
  // hashForLookup needs a master key. Use any 32-byte base64 string.
  process.env["TABLEKIT_MASTER_KEY"] = Buffer.from(new Uint8Array(32).fill(7)).toString("base64");
});
afterAll(() => {
  if (originalMaster === undefined) delete process.env["TABLEKIT_MASTER_KEY"];
  else process.env["TABLEKIT_MASTER_KEY"] = originalMaster;
});

describe("unsubscribe tokens", () => {
  it("sign + verify round-trip recovers the payload", async () => {
    const { signUnsubscribe, verifyUnsubscribe } = await import("@/lib/messaging/tokens");
    const payload = {
      guestId: "00000000-0000-0000-0000-000000000aaa",
      venueId: "00000000-0000-0000-0000-000000000bbb",
      channel: "email" as const,
    };
    const { p, s } = signUnsubscribe(payload);
    const verified = verifyUnsubscribe(p, s);
    expect(verified).toEqual(payload);
  });

  it("tampered signature rejected", async () => {
    const { signUnsubscribe, verifyUnsubscribe } = await import("@/lib/messaging/tokens");
    const { p, s } = signUnsubscribe({
      guestId: "00000000-0000-0000-0000-000000000aaa",
      venueId: "00000000-0000-0000-0000-000000000bbb",
      channel: "email",
    });
    // flip the last hex char
    const lastChar = s.charAt(s.length - 1);
    const replacement = lastChar === "f" ? "0" : "f";
    const tampered = s.slice(0, -1) + replacement;
    expect(verifyUnsubscribe(p, tampered)).toBeNull();
  });

  it("tampered payload rejected", async () => {
    const { signUnsubscribe, verifyUnsubscribe } = await import("@/lib/messaging/tokens");
    const { p, s } = signUnsubscribe({
      guestId: "00000000-0000-0000-0000-000000000aaa",
      venueId: "00000000-0000-0000-0000-000000000bbb",
      channel: "email",
    });
    // Decode, swap channel, re-encode — sig won't match.
    const decoded = Buffer.from(p, "base64url").toString("utf8");
    const swapped = decoded.replace(/\.email$/, ".sms");
    const tamperedP = Buffer.from(swapped, "utf8").toString("base64url");
    expect(verifyUnsubscribe(tamperedP, s)).toBeNull();
  });

  it("garbled base64 returns null cleanly (no throw)", async () => {
    const { verifyUnsubscribe } = await import("@/lib/messaging/tokens");
    expect(verifyUnsubscribe("not!base64$", "deadbeef")).toBeNull();
  });

  it("unsubscribeUrl produces a parseable URL", async () => {
    const { unsubscribeUrl } = await import("@/lib/messaging/tokens");
    const u = unsubscribeUrl("https://app.tablekit.test", {
      guestId: "00000000-0000-0000-0000-000000000aaa",
      venueId: "00000000-0000-0000-0000-000000000bbb",
      channel: "sms",
    });
    const parsed = new URL(u);
    expect(parsed.pathname).toBe("/unsubscribe");
    expect(parsed.searchParams.get("p")).toBeTruthy();
    expect(parsed.searchParams.get("s")).toBeTruthy();
  });
});

describe("backoffMs", () => {
  it("follows the 1m / 5m / 15m / 1h schedule", () => {
    expect(backoffMs(1)).toBe(60_000);
    expect(backoffMs(2)).toBe(5 * 60_000);
    expect(backoffMs(3)).toBe(15 * 60_000);
    expect(backoffMs(4)).toBe(60 * 60_000);
  });

  it("returns null at 5+ to signal exhaustion", () => {
    expect(backoffMs(5)).toBeNull();
    expect(backoffMs(6)).toBeNull();
    expect(backoffMs(99)).toBeNull();
  });
});

describe("truncateError", () => {
  it("passes short messages through unchanged", () => {
    expect(truncateError(new Error("short"))).toBe("short");
  });

  it("truncates messages longer than 500 chars to 500 with ellipsis", () => {
    const long = "x".repeat(800);
    const out = truncateError(new Error(long));
    expect(out.length).toBe(500);
    expect(out.endsWith("…")).toBe(true);
  });

  it("handles non-Error throws", () => {
    expect(truncateError("oops")).toBe("oops");
    expect(truncateError(42)).toBe("42");
  });
});
