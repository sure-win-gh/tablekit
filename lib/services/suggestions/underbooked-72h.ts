import type { Rule } from "./types";

const HOURS_72_MS = 72 * 60 * 60 * 1000;

// A near-term service that's barely booked — a window to promote it.
export const underbooked72h: Rule = (ctx) => {
  const startsInMs = ctx.startsAt.getTime() - ctx.now.getTime();
  const soon = startsInMs > 0 && startsInMs < HOURS_72_MS;
  if (soon && ctx.utilisation < 0.3) {
    return { rule: "underbooked-72h", message: "Quiet and starting soon — consider promoting it." };
  }
  return null;
};
