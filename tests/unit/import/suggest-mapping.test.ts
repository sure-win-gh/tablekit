import { describe, expect, it } from "vitest";

import { suggestMapping } from "@/lib/import/suggest-mapping";

describe("suggestMapping", () => {
  it("matches common header variants to firstName + email", () => {
    const out = suggestMapping(["First Name", "Last Name", "Email", "Phone"]);
    expect(out.firstName).toBe("First Name");
    expect(out.lastName).toBe("Last Name");
    expect(out.email).toBe("Email");
    expect(out.phone).toBe("Phone");
  });

  it("is case-insensitive + punctuation-insensitive", () => {
    const out = suggestMapping(["FIRST_NAME", "e-mail", "MOBILE NUMBER"]);
    expect(out.firstName).toBe("FIRST_NAME");
    expect(out.email).toBe("e-mail");
    expect(out.phone).toBe("MOBILE NUMBER");
  });

  it("leaves a field unset when no header matches", () => {
    const out = suggestMapping(["Birthday", "Address"]);
    expect(out.firstName).toBeUndefined();
    expect(out.email).toBeUndefined();
  });

  it("matches surname for lastName", () => {
    const out = suggestMapping(["Surname"]);
    expect(out.lastName).toBe("Surname");
  });

  it("matches a generic 'Name' as firstName fallback", () => {
    const out = suggestMapping(["Name", "Email"]);
    expect(out.firstName).toBe("Name");
  });

  it("returns empty object for empty headers", () => {
    expect(suggestMapping([])).toEqual({});
  });
});
