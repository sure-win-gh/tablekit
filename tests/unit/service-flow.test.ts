// parseServiceFlow — defaults, bounds, and the "never" sentinel.

import { describe, expect, it } from "vitest";

import { parseServiceFlow, SERVICE_FLOW_DEFAULTS } from "@/lib/venues/service-flow";

describe("parseServiceFlow", () => {
  it("returns defaults for empty / missing / malformed slices", () => {
    for (const settings of [{}, null, undefined, { serviceFlow: "junk" }, { serviceFlow: 42 }]) {
      expect(parseServiceFlow(settings)).toEqual(SERVICE_FLOW_DEFAULTS);
    }
  });

  it("round-trips explicit values", () => {
    const p = parseServiceFlow({
      serviceFlow: { autoFinishEnabled: false, overduePromptMinutes: 30 },
    });
    expect(p).toEqual({ autoFinishEnabled: false, overduePromptMinutes: 30 });
  });

  it("treats null prompt minutes as never", () => {
    const p = parseServiceFlow({ serviceFlow: { overduePromptMinutes: null } });
    expect(p.overduePromptMinutes).toBeNull();
    expect(p.autoFinishEnabled).toBe(true); // sibling default survives
  });

  it("rejects out-of-bounds or non-integer prompt minutes back to the default", () => {
    for (const bad of [4, 61, 0, -5, 12.5, "15", true]) {
      const p = parseServiceFlow({ serviceFlow: { overduePromptMinutes: bad } });
      expect(p.overduePromptMinutes).toBe(SERVICE_FLOW_DEFAULTS.overduePromptMinutes);
    }
  });

  it("ignores a non-boolean autoFinishEnabled", () => {
    const p = parseServiceFlow({ serviceFlow: { autoFinishEnabled: "yes" } });
    expect(p.autoFinishEnabled).toBe(true);
  });
});
