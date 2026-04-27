// Template registry. Maps (template, channel) → renderer.
//
// Adding a new template:
//   1. Drop the renderer file in lib/email/templates or lib/sms/templates.
//   2. Add the (template, channel) entry to TEMPLATE_REGISTRY here.
//   3. Add the template name to the migration's CHECK constraint
//      via a new migration (or revise the constraint inline if the
//      column was wide-open).
//
// The dispatch worker (wave 4) calls renderForChannel; the queue layer
// uses templateChannels to know which channels to enqueue when a
// trigger fires (so a single triggering event can produce one email +
// one SMS row, etc).

import "server-only";

import type { MessageBookingContext, RenderedEmail, RenderedSms } from "./context";

import { renderBookingCancelled } from "@/lib/email/templates/booking-cancelled";
import { renderBookingConfirmation } from "@/lib/email/templates/booking-confirmation";
import { renderBookingReminder24h } from "@/lib/email/templates/booking-reminder-24h";
import { renderBookingReviewRequest } from "@/lib/email/templates/booking-review-request";
import { renderBookingThankYou } from "@/lib/email/templates/booking-thank-you";
import { renderReviewOperatorReply } from "@/lib/email/templates/review-operator-reply";
import { renderBookingReminder2h } from "@/lib/sms/templates/booking-reminder-2h";
import { renderBookingWaitlistReady } from "@/lib/sms/templates/booking-waitlist-ready";

export type MessageChannel = "email" | "sms";

export type MessageTemplate =
  | "booking.confirmation"
  | "booking.reminder_24h"
  | "booking.reminder_2h"
  | "booking.cancelled"
  | "booking.thank_you"
  | "booking.waitlist_ready"
  | "booking.review_request"
  | "review.operator_reply";

type EmailRenderer = (ctx: MessageBookingContext) => Promise<RenderedEmail>;
type SmsRenderer = (ctx: MessageBookingContext) => RenderedSms;

type RegistryEntry = {
  email?: EmailRenderer;
  sms?: SmsRenderer;
};

const TEMPLATE_REGISTRY: Record<MessageTemplate, RegistryEntry> = {
  "booking.confirmation": { email: renderBookingConfirmation },
  "booking.reminder_24h": { email: renderBookingReminder24h },
  "booking.reminder_2h": { sms: renderBookingReminder2h },
  "booking.cancelled": { email: renderBookingCancelled },
  "booking.thank_you": { email: renderBookingThankYou },
  "booking.waitlist_ready": { sms: renderBookingWaitlistReady },
  "booking.review_request": { email: renderBookingReviewRequest },
  "review.operator_reply": { email: renderReviewOperatorReply },
};

// Channels a given template currently supports. Inline triggers
// consult this to decide what to enqueue.
export function templateChannels(template: MessageTemplate): MessageChannel[] {
  const entry = TEMPLATE_REGISTRY[template];
  const channels: MessageChannel[] = [];
  if (entry.email) channels.push("email");
  if (entry.sms) channels.push("sms");
  return channels;
}

export type RenderResult =
  | { kind: "email"; rendered: RenderedEmail }
  | { kind: "sms"; rendered: RenderedSms }
  | { kind: "no-renderer" };

export async function renderForChannel(
  template: MessageTemplate,
  channel: MessageChannel,
  ctx: MessageBookingContext,
): Promise<RenderResult> {
  const entry = TEMPLATE_REGISTRY[template];
  if (channel === "email" && entry.email) {
    return { kind: "email", rendered: await entry.email(ctx) };
  }
  if (channel === "sms" && entry.sms) {
    return { kind: "sms", rendered: entry.sms(ctx) };
  }
  return { kind: "no-renderer" };
}
