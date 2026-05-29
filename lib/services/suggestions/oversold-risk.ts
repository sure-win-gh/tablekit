import type { Rule } from "./types";

// Nearly/over capacity with no slack for another sitting — tight turns the
// operator may want to review. "Turn-time gap" is read as the leftover
// window after whole sittings (windowMinutes mod turnMinutes); < 30 min
// means the service is packed end-to-end.
export const oversoldRisk: Rule = (ctx) => {
  if (ctx.turnMinutes <= 0) return null;
  const slackMinutes = ctx.windowMinutes % ctx.turnMinutes;
  if (ctx.utilisation >= 0.95 && slackMinutes < 30) {
    return {
      rule: "oversold-risk",
      message: "Near capacity with tight turns — review or extend the window.",
    };
  }
  return null;
};
