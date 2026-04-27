import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { isPlatformAdminEmail, platformAdminAllowlist } from "@/lib/server/admin/allowlist";

const ENV = "ADMIN_EMAILS";

describe("platform admin allowlist", () => {
  let original: string | undefined;

  beforeEach(() => {
    original = process.env[ENV];
  });

  afterEach(() => {
    if (original === undefined) delete process.env[ENV];
    else process.env[ENV] = original;
  });

  it("empty env = empty set, nobody allowed", () => {
    delete process.env[ENV];
    expect(platformAdminAllowlist().size).toBe(0);
    expect(isPlatformAdminEmail("anyone@example.com")).toBe(false);
  });

  it("blank env = empty set", () => {
    process.env[ENV] = "   ";
    expect(platformAdminAllowlist().size).toBe(0);
    expect(isPlatformAdminEmail("a@b.co")).toBe(false);
  });

  it("comma-separated emails", () => {
    process.env[ENV] = "a@b.co,c@d.co";
    const set = platformAdminAllowlist();
    expect(set.has("a@b.co")).toBe(true);
    expect(set.has("c@d.co")).toBe(true);
    expect(set.size).toBe(2);
  });

  it("whitespace-separated emails", () => {
    process.env[ENV] = "a@b.co c@d.co\ne@f.co";
    expect(platformAdminAllowlist().size).toBe(3);
  });

  it("trims and lowercases", () => {
    process.env[ENV] = "  Hello@World.CO ,  Other@Place.CO ";
    expect(isPlatformAdminEmail("hello@world.co")).toBe(true);
    expect(isPlatformAdminEmail("HELLO@WORLD.CO")).toBe(true);
    expect(isPlatformAdminEmail("  hello@world.co  ")).toBe(true);
  });

  it("rejects null / undefined / empty input", () => {
    process.env[ENV] = "a@b.co";
    expect(isPlatformAdminEmail(null)).toBe(false);
    expect(isPlatformAdminEmail(undefined)).toBe(false);
    expect(isPlatformAdminEmail("")).toBe(false);
  });

  it("rejects non-listed email even when allowlist is non-empty", () => {
    process.env[ENV] = "a@b.co";
    expect(isPlatformAdminEmail("c@d.co")).toBe(false);
  });
});
