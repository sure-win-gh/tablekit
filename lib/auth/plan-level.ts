// Pure plan-comparison helpers, split out so they can be unit-tested
// without any DB plumbing. requirePlan lives in ./require-plan.ts and
// uses these.
//
// The tier ordering matches CLAUDE.md commercial model:
//   free  → up to 50 bookings/month, no Plus features
//   core  → £19/month, deposits + RWG + unlimited bookings
//   plus  → £39/month, multi-venue + AI enquiry + priority support

export type Plan = "free" | "core" | "plus";

export const planLevel: Record<Plan, number> = {
  free: 1,
  core: 2,
  plus: 3,
};

export function hasPlan(actual: Plan, min: Plan): boolean {
  return planLevel[actual] >= planLevel[min];
}

// Narrow an arbitrary string from the DB into a known Plan. Falls back
// to 'free' for any value not in the enum so a migration that adds a
// new tier doesn't crash existing gating code mid-deploy — the
// fallback errs on the side of withholding access.
export function toPlan(raw: string): Plan {
  return raw === "core" || raw === "plus" || raw === "free" ? raw : "free";
}
