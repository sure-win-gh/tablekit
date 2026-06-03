import "server-only";

import type { MessageBookingContext, RenderedWhatsApp } from "@/lib/messaging/context";

import { approvedTemplateSid } from "./approved";

// WhatsApp 24-hour reminder.
export function renderBookingReminder24hWhatsApp(ctx: MessageBookingContext): RenderedWhatsApp {
  const body =
    `Reminder: your table at ${ctx.venueName} is tomorrow, ${ctx.startAtLocal} ` +
    `for ${ctx.partySize}. Ref ${ctx.reference}.`;
  const contentSid = approvedTemplateSid("booking.reminder_24h");
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
