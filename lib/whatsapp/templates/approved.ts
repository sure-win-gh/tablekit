import "server-only";

import type { MessageTemplate } from "@/lib/messaging/registry";

// Business-initiated WhatsApp messages must use a Meta-approved message
// template (HSM) to deliver outside the 24-hour customer-service
// window. Twilio identifies an approved template by its Content SID
// (HX…). We map our internal template name → the approved Content SID,
// sourced from env so each environment (sandbox / prod) can point at
// its own approved copies.
//
// When no SID is configured the renderer falls back to a freeform body
// — valid only inside an open session window (and the Twilio sandbox),
// which is fine for local/dev. Production go-live requires the SIDs to
// be set once the templates are approved in the Twilio console.
const ENV_KEY: Partial<Record<MessageTemplate, string>> = {
  "booking.confirmation": "TWILIO_WA_TEMPLATE_BOOKING_CONFIRMATION",
  "booking.reminder_24h": "TWILIO_WA_TEMPLATE_BOOKING_REMINDER_24H",
  "booking.reminder_2h": "TWILIO_WA_TEMPLATE_BOOKING_REMINDER_2H",
};

export function approvedTemplateSid(template: MessageTemplate): string | undefined {
  const key = ENV_KEY[template];
  if (!key) return undefined;
  const sid = process.env[key];
  if (!sid || sid.includes("YOUR_") || !sid.startsWith("HX")) return undefined;
  return sid;
}
