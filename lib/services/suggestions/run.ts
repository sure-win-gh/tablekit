import { noShowCluster } from "./no-show-cluster";
import { oversoldRisk } from "./oversold-risk";
import type { Rule, ServiceContext, Suggestion } from "./types";
import { underbooked72h } from "./underbooked-72h";
import { walkInHeadroom } from "./walk-in-headroom";

// Priority order — most operationally urgent first. The runner returns the
// first rule that fires, so each service surfaces at most one nudge:
//   1. oversold-risk     — a problem happening now
//   2. no-show-cluster   — needs action today
//   3. underbooked-72h   — a near-term promo opportunity
//   4. walk-in-headroom  — a softer optimisation
export const RULES: ReadonlyArray<Rule> = [
  oversoldRisk,
  noShowCluster,
  underbooked72h,
  walkInHeadroom,
];

export function runSuggestions(ctx: ServiceContext): Suggestion | null {
  for (const rule of RULES) {
    const hit = rule(ctx);
    if (hit) return hit;
  }
  return null;
}
