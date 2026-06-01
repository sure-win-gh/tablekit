import "server-only";

import type { MessageBookingContext, RenderedWhatsApp } from "@/lib/messaging/context";

import { approvedTemplateSid } from "./approved";

// WhatsApp 2-hour reminder. Mirrors the SMS copy. When an approved
// Content SID is configured, we send via the template (positional
// variables); otherwise we fall back to the freeform body for the
// session window / sandbox.
export function renderBookingReminder2hWhatsApp(ctx: MessageBookingContext): RenderedWhatsApp {
  const body =
    `${ctx.venueName}: see you at ${ctx.startAtLocal} for ${ctx.partySize}. ` +
    `Ref ${ctx.reference}.`;
  const contentSid = approvedTemplateSid("booking.reminder_2h");
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
