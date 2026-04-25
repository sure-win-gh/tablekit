// Pure wait-time estimator.
//
// Spec: position × avg turn time, capped at 90 minutes.
// Position is 1-indexed (the first person waiting has 1 unit ahead of
// them, not 0 — they're still waiting for a free table).
//
// avgTurnMinutes is taken from the venue's services in the dashboard
// caller; default fallback is 60 if no services are loaded.

export const WAIT_CAP_MINUTES = 90;

export function estimateWaitMinutes(opts: {
  position: number; // 1-indexed
  avgTurnMinutes: number;
}): number {
  if (opts.position < 1) return 0;
  const raw = opts.position * opts.avgTurnMinutes;
  return Math.min(raw, WAIT_CAP_MINUTES);
}

// Human-friendly summary for the dashboard / SMS templates.
// "5 min", "15 min", "1h", "1h 30m" etc.
export function formatWaitMinutes(minutes: number): string {
  if (minutes <= 0) return "now";
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}
