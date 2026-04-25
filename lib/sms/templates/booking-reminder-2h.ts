import "server-only";

import type { MessageBookingContext, RenderedSms } from "@/lib/messaging/context";

// SMS bodies stay short — Twilio bills per 160-char segment, and
// real-world recipient UIs truncate aggressively. Aim for one segment
// even with a venue name + time variation.
export function renderBookingReminder2h(ctx: MessageBookingContext): RenderedSms {
  return {
    body:
      `${ctx.venueName}: see you at ${ctx.startAtLocal} for ${ctx.partySize}. ` +
      `Ref ${ctx.reference}. Reply STOP to opt out.`,
  };
}
