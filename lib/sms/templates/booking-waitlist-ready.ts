import "server-only";

import type { MessageBookingContext, RenderedSms } from "@/lib/messaging/context";

// Fires when a host seats a walk-in from the waitlist. Short by
// design — Twilio bills per 160-char segment and "table's ready"
// notifications must read at a glance.
export function renderBookingWaitlistReady(ctx: MessageBookingContext): RenderedSms {
  return {
    body:
      `${ctx.venueName}: your table for ${ctx.partySize} is ready. Come on in. ` +
      `Reply STOP to opt out.`,
  };
}
