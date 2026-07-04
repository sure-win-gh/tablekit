// Typed parser for the `serviceFlow` slice of venues.settings — the
// auto-finish + overdue-prompt behaviour knobs. See
// docs/specs/service-flow.md.
//
// Same posture as parseBranding / parseProfile: lenient and fully
// defaulted, so an empty or malformed slice reproduces the shipped
// behaviour (auto-finish on, prompt every 15 minutes). Pure (no
// "server-only") so the settings form and tests reuse it.

export type ServiceFlowSettings = {
  autoFinishEnabled: boolean;
  // Minutes between overdue-table prompts; null = never prompt.
  overduePromptMinutes: number | null;
};

export const SERVICE_FLOW_DEFAULTS: ServiceFlowSettings = {
  autoFinishEnabled: true,
  overduePromptMinutes: 15,
};

export const OVERDUE_PROMPT_CHOICES = [5, 10, 15, 20, 30, 45, 60] as const;

const PROMPT_MIN = 5;
const PROMPT_MAX = 60;

export function parseServiceFlow(settings: unknown): ServiceFlowSettings {
  const root =
    settings && typeof settings === "object"
      ? (settings as Record<string, unknown>)["serviceFlow"]
      : undefined;
  const raw = root && typeof root === "object" ? (root as Record<string, unknown>) : {};

  const out: ServiceFlowSettings = { ...SERVICE_FLOW_DEFAULTS };

  if (typeof raw["autoFinishEnabled"] === "boolean") {
    out.autoFinishEnabled = raw["autoFinishEnabled"];
  }

  const p = raw["overduePromptMinutes"];
  if (p === null) {
    out.overduePromptMinutes = null;
  } else if (typeof p === "number" && Number.isInteger(p) && p >= PROMPT_MIN && p <= PROMPT_MAX) {
    out.overduePromptMinutes = p;
  }

  return out;
}
