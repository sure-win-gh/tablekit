// parseTableCombining — defaults, bounds, and malformed slices.

import { describe, expect, it } from "vitest";

import { parseTableCombining, TABLE_COMBINING_DEFAULTS } from "@/lib/venues/table-combining";

describe("parseTableCombining", () => {
  it("returns defaults for empty / missing / malformed slices", () => {
    for (const settings of [
      {},
      null,
      undefined,
      { tableCombining: "junk" },
      { tableCombining: 42 },
    ]) {
      expect(parseTableCombining(settings)).toEqual(TABLE_COMBINING_DEFAULTS);
    }
  });

  it("round-trips an in-bounds maxTables", () => {
    expect(parseTableCombining({ tableCombining: { maxTables: 4 } })).toEqual({ maxTables: 4 });
  });

  it("rejects out-of-bounds or non-integer maxTables back to the default", () => {
    for (const bad of [1, 7, 0, -3, 3.5, "3", true, null]) {
      expect(parseTableCombining({ tableCombining: { maxTables: bad } }).maxTables).toBe(
        TABLE_COMBINING_DEFAULTS.maxTables,
      );
    }
  });
});
