// Typed parser for the `tableCombining` slice of venues.settings — the
// operator-controlled table-joins knobs. See docs/specs/table-combining.md.
//
// Same posture as parseServiceFlow / parseProfile: lenient and fully
// defaulted, so an empty or malformed slice reproduces the default
// behaviour (join at most 3 tables). Pure (no "server-only") so the
// settings form, the availability loaders, and tests all reuse it.

export type TableCombiningSettings = {
  // Most tables the engine will ever push together into one booking.
  // The operator-facing "Most tables you'd ever push together" control.
  maxTables: number;
};

export const TABLE_COMBINING_DEFAULTS: TableCombiningSettings = {
  maxTables: 3,
};

// Hard bounds on the operator control. 2 = pairs only (today's behaviour);
// the upper bound keeps connected-set enumeration cheap on the month view.
export const MAX_TABLES_MIN = 2;
export const MAX_TABLES_MAX = 6;

export function parseTableCombining(settings: unknown): TableCombiningSettings {
  const root =
    settings && typeof settings === "object"
      ? (settings as Record<string, unknown>)["tableCombining"]
      : undefined;
  const raw = root && typeof root === "object" ? (root as Record<string, unknown>) : {};

  const out: TableCombiningSettings = { ...TABLE_COMBINING_DEFAULTS };

  const m = raw["maxTables"];
  if (typeof m === "number" && Number.isInteger(m) && m >= MAX_TABLES_MIN && m <= MAX_TABLES_MAX) {
    out.maxTables = m;
  }

  return out;
}
