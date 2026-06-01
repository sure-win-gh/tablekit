import "server-only";

import type { MessageBookingContext, RenderedWhatsApp } from "@/lib/messaging/context";

import { approvedTemplateSid } from "./approved";

// WhatsApp booking confirmation.
export function renderBookingConfirmationWhatsApp(ctx: MessageBookingContext): RenderedWhatsApp {
  const body =
    `${ctx.venueName}: your table is confirmed for ${ctx.startAtLocal}, ` +
    `party of ${ctx.partySize}. Ref ${ctx.reference}.`;
  const contentSid = approvedTemplateSid("booking.confirmation");
  return contentSid
    ? {
        body,
        contentSid,
        contentVariables: {
          "1": ctx.venueName,
          "2": ctx.startAtLocal,
          "3": String(ctx.partySize),
          "4": ctx.reference,
        },
      }
    : { body };
}
