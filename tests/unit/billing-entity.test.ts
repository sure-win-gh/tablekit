// Unit coverage for entityForOrg — the canonical org → billing-entity
// resolver every billing/Connect path depends on. Must throw on a missing
// org and on an unknown entity value (fail closed — never default to the
// UK account), and narrow correctly for both known entities.

import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockSelect } = vi.hoisted(() => ({ mockSelect: vi.fn() }));

vi.mock("@/lib/server/admin/db", () => ({ adminDb: () => ({ select: mockSelect }) }));

import { entityForOrg } from "@/lib/billing/entity";

// adminDb().select(...).from(...).where(...).limit(n) resolves to `rows`.
function stubOrgRow(billingEntity: string | null): void {
  const rows = billingEntity === null ? [] : [{ billingEntity }];
  mockSelect.mockReturnValue({
    from: () => ({ where: () => ({ limit: () => Promise.resolve(rows) }) }),
  });
}

describe("entityForOrg", () => {
  beforeEach(() => vi.clearAllMocks());

  it("resolves both known entities", async () => {
    stubOrgRow("uk");
    await expect(entityForOrg("org_1")).resolves.toBe("uk");
    stubOrgRow("us");
    await expect(entityForOrg("org_1")).resolves.toBe("us");
  });

  it("throws when the org does not exist", async () => {
    stubOrgRow(null);
    await expect(entityForOrg("org_missing")).rejects.toThrow("not found");
  });

  it("THROWS on an unknown entity value — never falls back to uk", async () => {
    stubOrgRow("de");
    await expect(entityForOrg("org_1")).rejects.toThrow('unknown billing entity "de"');
  });
});
