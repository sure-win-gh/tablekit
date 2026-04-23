import { describe, expect, it } from "vitest";

import { hasRole, roleLevel } from "@/lib/auth/role-level";

describe("role ordering", () => {
  it("owner > manager > host", () => {
    expect(roleLevel.owner).toBeGreaterThan(roleLevel.manager);
    expect(roleLevel.manager).toBeGreaterThan(roleLevel.host);
  });

  it("hasRole accepts equal and higher", () => {
    expect(hasRole("owner", "owner")).toBe(true);
    expect(hasRole("owner", "manager")).toBe(true);
    expect(hasRole("owner", "host")).toBe(true);
    expect(hasRole("manager", "manager")).toBe(true);
    expect(hasRole("manager", "host")).toBe(true);
    expect(hasRole("host", "host")).toBe(true);
  });

  it("hasRole rejects lower", () => {
    expect(hasRole("host", "manager")).toBe(false);
    expect(hasRole("host", "owner")).toBe(false);
    expect(hasRole("manager", "owner")).toBe(false);
  });
});
