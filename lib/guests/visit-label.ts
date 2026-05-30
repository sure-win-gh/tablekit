// Pure visit-history labelling — safe to import from client + server.
// The DB-backed prior-visit counts live in `visit-history.ts` (server
// only). This module is what GuestBadges renders against, so it must
// not pull in any server-only dependency chain.

export type VisitLabel = {
  text: string;
  tone: "info" | "success";
  // Total visit ordinal including this one (1 = first, 2 = second, ...).
  ordinal: number;
};

export function visitLabel(prior: number): VisitLabel {
  if (prior <= 0) return { text: "First visit", tone: "info", ordinal: 1 };
  if (prior === 1) return { text: "2nd visit", tone: "info", ordinal: 2 };
  return { text: `Regular · ${prior + 1} visits`, tone: "success", ordinal: prior + 1 };
}
