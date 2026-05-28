import type { Rule } from "./types";

// This weekday usually pulls a meaningful walk-in share, and the service
// still has room — hold a table back rather than booking it out.
export const walkInHeadroom: Rule = (ctx) => {
  if (ctx.utilisation < 0.6 && ctx.walkInWeekdayShare > 0.25) {
    return { rule: "walk-in-headroom", message: "Walk-ins are common on this day — keep a table free." };
  }
  return null;
};
