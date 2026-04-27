// Unit tests for the review-request token helpers. Mirrors the
// unsubscribe-token tests — same HMAC pattern, plus iat-based expiry.

import { afterAll, beforeAll, describe, expect, it } from "vitest";

const originalMaster = process.env["TABLEKIT_MASTER_KEY"];

beforeAll(() => {
  process.env["TABLEKIT_MASTER_KEY"] = Buffer.from(new Uint8Array(32).fill(7)).toString("base64");
});
afterAll(() => {
  if (originalMaster === undefined) delete process.env["TABLEKIT_MASTER_KEY"];
  else process.env["TABLEKIT_MASTER_KEY"] = originalMaster;
});

const BOOKING_ID = "00000000-0000-0000-0000-000000000abc";

describe("review tokens", () => {
  it("sign + verify round-trip recovers the bookingId", async () => {
    const { signReviewToken, verifyReviewToken } = await import(
      "@/lib/messaging/review-tokens"
    );
    const { p, s } = signReviewToken({ bookingId: BOOKING_ID });
    const result = verifyReviewToken(p, s);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.payload.bookingId).toBe(BOOKING_ID);
    expect(typeof result.payload.iat).toBe("number");
  });

  it("tampered signature rejected as bad-sig", async () => {
    const { signReviewToken, verifyReviewToken } = await import(
      "@/lib/messaging/review-tokens"
    );
    const { p, s } = signReviewToken({ bookingId: BOOKING_ID });
    const last = s.charAt(s.length - 1);
    const tampered = s.slice(0, -1) + (last === "f" ? "0" : "f");
    const r = verifyReviewToken(p, tampered);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("bad-sig");
  });

  it("tampered payload rejected", async () => {
    const { signReviewToken, verifyReviewToken } = await import(
      "@/lib/messaging/review-tokens"
    );
    const { p, s } = signReviewToken({ bookingId: BOOKING_ID });
    const decoded = Buffer.from(p, "base64url").toString("utf8");
    const swapped = decoded.replace(BOOKING_ID, BOOKING_ID.replace(/c$/, "d"));
    const tamperedP = Buffer.from(swapped, "utf8").toString("base64url");
    const r = verifyReviewToken(tamperedP, s);
    expect(r.ok).toBe(false);
  });

  it("rejects tokens older than 90 days as expired", async () => {
    const { signReviewToken, verifyReviewToken } = await import(
      "@/lib/messaging/review-tokens"
    );
    const oldIat = Math.floor(Date.now() / 1000) - 91 * 24 * 60 * 60;
    const { p, s } = signReviewToken({ bookingId: BOOKING_ID, iat: oldIat });
    const r = verifyReviewToken(p, s);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("expired");
  });

  it("rejects tokens with iat in the future as future", async () => {
    const { signReviewToken, verifyReviewToken } = await import(
      "@/lib/messaging/review-tokens"
    );
    const futureIat = Math.floor(Date.now() / 1000) + 60 * 60;
    const { p, s } = signReviewToken({ bookingId: BOOKING_ID, iat: futureIat });
    const r = verifyReviewToken(p, s);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("future");
  });

  it("garbled base64 returns bad-sig (mac fails before decode)", async () => {
    const { verifyReviewToken } = await import("@/lib/messaging/review-tokens");
    const r = verifyReviewToken("not!base64$", "deadbeef");
    expect(r.ok).toBe(false);
  });

  it("reviewUrl produces a parseable URL with mode=private when requested", async () => {
    const { reviewUrl } = await import("@/lib/messaging/review-tokens");
    const u = reviewUrl(
      "https://app.tablekit.test",
      { bookingId: BOOKING_ID },
      { mode: "private" },
    );
    const parsed = new URL(u);
    expect(parsed.pathname).toBe("/review");
    expect(parsed.searchParams.get("p")).toBeTruthy();
    expect(parsed.searchParams.get("s")).toBeTruthy();
    expect(parsed.searchParams.get("mode")).toBe("private");
  });
});
