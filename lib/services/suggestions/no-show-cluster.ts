import type { Rule } from "./types";

// Several of today's bookings are from guests who've no-showed before —
// worth a confirmation nudge to protect the covers.
export const noShowCluster: Rule = (ctx) => {
  if (ctx.noShowProneBookingCount >= 3) {
    return {
      rule: "no-show-cluster",
      message: `${ctx.noShowProneBookingCount} bookings from prior no-show guests — confirm them by SMS.`,
    };
  }
  return null;
};
