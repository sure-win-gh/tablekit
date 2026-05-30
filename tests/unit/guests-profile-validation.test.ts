import { describe, expect, it } from "vitest";

import { parseAndValidateTags } from "@/lib/guests/profile-validation";

describe("parseAndValidateTags", () => {
  it("accepts simple comma-separated tags", () => {
    const r = parseAndValidateTags("VIP, allergy:nuts, loud-party");
    expect(r).toEqual({ ok: true, tags: ["VIP", "allergy:nuts", "loud-party"] });
  });

  it("trims whitespace and drops empty entries", () => {
    const r = parseAndValidateTags("  VIP  ,  ,allergy:gluten ");
    expect(r).toEqual({ ok: true, tags: ["VIP", "allergy:gluten"] });
  });

  it("dedupes case-sensitive duplicates", () => {
    const r = parseAndValidateTags("VIP, VIP, vip");
    expect(r).toEqual({ ok: true, tags: ["VIP", "vip"] });
  });

  it("accepts an empty input as zero tags", () => {
    const r = parseAndValidateTags("");
    expect(r).toEqual({ ok: true, tags: [] });
  });

  it("rejects more than 20 tags", () => {
    const r = parseAndValidateTags(Array.from({ length: 21 }, (_, i) => `t${i}`).join(","));
    expect(r).toEqual({ ok: false, reason: "too-many" });
  });

  it("rejects a tag longer than 32 characters", () => {
    const tag = "a".repeat(33);
    const r = parseAndValidateTags(tag);
    expect(r).toEqual({ ok: false, reason: "bad-shape", offending: tag });
  });

  it("rejects tags containing @ (email shape)", () => {
    const r = parseAndValidateTags("VIP, guest@example.com");
    expect(r).toEqual({ ok: false, reason: "looks-like-pii", offending: "guest@example.com" });
  });

  it("rejects tags with a phone-like digit run", () => {
    const r = parseAndValidateTags("VIP, 07700900123");
    expect(r).toEqual({ ok: false, reason: "looks-like-pii", offending: "07700900123" });
  });

  it("accepts short digit references (e.g. allergy codes)", () => {
    const r = parseAndValidateTags("table-12, party-99");
    expect(r).toEqual({ ok: true, tags: ["table-12", "party-99"] });
  });

  it("rejects non-printable / non-ASCII content", () => {
    const r = parseAndValidateTags("VIP, brûlée");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("bad-shape");
  });
});
