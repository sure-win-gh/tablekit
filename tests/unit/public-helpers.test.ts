// Unit tests for the widget-phase public helpers.
//
// Covers the pieces that don't need a DB or network:
//   - bookingReference shape
//   - captcha pass-through when HCAPTCHA_SECRET is unset
//   - captcha rejects a missing token when HCAPTCHA_SECRET is set
//   - rate-limit pass-through when Upstash isn't configured
//   - ipFromHeaders header-precedence

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { bookingReference, captchaEnabled, verifyCaptcha } from "@/lib/public/captcha";
import { ipFromHeaders, rateLimit } from "@/lib/public/rate-limit";

describe("bookingReference", () => {
  it("formats the first 8 hex chars as XXXX-XXXX", () => {
    expect(bookingReference("4e2d1f8a-0000-0000-0000-000000000000")).toBe("4E2D-1F8A");
  });

  it("handles UUIDs with all-lower hex", () => {
    expect(bookingReference("abcdef01-2345-6789-abcd-ef0123456789")).toBe("ABCD-EF01");
  });
});

describe("rateLimit (no Upstash env)", () => {
  const originalUrl = process.env["UPSTASH_REDIS_REST_URL"];
  beforeEach(() => {
    delete process.env["UPSTASH_REDIS_REST_URL"];
  });
  afterEach(() => {
    if (originalUrl !== undefined) process.env["UPSTASH_REDIS_REST_URL"] = originalUrl;
  });

  it("returns ok without any network calls", async () => {
    const fetchSpy = vi.spyOn(global, "fetch");
    const r = await rateLimit("anything", 1, 60);
    expect(r.ok).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});

describe("ipFromHeaders", () => {
  it("prefers cf-connecting-ip", () => {
    const h = new Headers({ "cf-connecting-ip": "1.1.1.1", "x-forwarded-for": "2.2.2.2" });
    expect(ipFromHeaders(h)).toBe("1.1.1.1");
  });

  it("reads x-real-ip next", () => {
    const h = new Headers({ "x-real-ip": "3.3.3.3", "x-forwarded-for": "2.2.2.2" });
    expect(ipFromHeaders(h)).toBe("3.3.3.3");
  });

  it("takes the first x-forwarded-for entry", () => {
    const h = new Headers({ "x-forwarded-for": "4.4.4.4, 5.5.5.5" });
    expect(ipFromHeaders(h)).toBe("4.4.4.4");
  });

  it("falls back to 'unknown'", () => {
    expect(ipFromHeaders(new Headers())).toBe("unknown");
  });
});

describe("verifyCaptcha", () => {
  const originalSecret = process.env["HCAPTCHA_SECRET"];
  afterEach(() => {
    if (originalSecret === undefined) delete process.env["HCAPTCHA_SECRET"];
    else process.env["HCAPTCHA_SECRET"] = originalSecret;
  });

  it("passes through when HCAPTCHA_SECRET is unset", async () => {
    delete process.env["HCAPTCHA_SECRET"];
    await expect(verifyCaptcha(undefined)).resolves.toEqual({ ok: true });
    await expect(verifyCaptcha("anything")).resolves.toEqual({ ok: true });
  });

  it("rejects a missing token when HCAPTCHA_SECRET is set", async () => {
    process.env["HCAPTCHA_SECRET"] = "test-secret";
    const r = await verifyCaptcha(undefined);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("missing-token");
  });
});

describe("captchaEnabled", () => {
  const originalSecret = process.env["HCAPTCHA_SECRET"];
  afterEach(() => {
    if (originalSecret === undefined) delete process.env["HCAPTCHA_SECRET"];
    else process.env["HCAPTCHA_SECRET"] = originalSecret;
  });

  it("reflects HCAPTCHA_SECRET presence at import time", () => {
    // captchaEnabled() reads a module-level constant captured when
    // lib/public/captcha.ts was first imported. We can't re-toggle
    // mid-test without re-importing, so assert the current state:
    // either truthy (secret set) or falsy (unset).
    const expected = Boolean(process.env["HCAPTCHA_SECRET"]);
    expect(captchaEnabled()).toBe(expected);
  });
});
