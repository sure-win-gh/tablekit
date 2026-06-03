// Effective send channel for a lifecycle message.
//
// The seam between "what a template can render" (registry capability),
// "what the operator chose" (venue messaging settings), and "what the
// guest is reachable + opted-in on" (suppression state). Triggers call
// this to decide which single channel to enqueue — first deliverable
// channel in the operator's preference order wins, so we never
// double-message (or double-bill) a guest across channels.
//
// Returns null when no channel is deliverable (disabled event, erased
// guest, or every preferred channel suppressed) — the caller enqueues
// nothing. Dispatch (load-context) remains the final suppression gate
// for the window between enqueue and send.

import "server-only";

import { templateChannels, type MessageChannel } from "./registry";
import { FLOW_EVENT_TEMPLATE, type FlowEvent, type FlowEventSettings } from "./venue-settings";

// Per-guest deliverability snapshot, loaded once per trigger.
export type GuestChannelState = {
  hasPhone: boolean;
  erasedAt: Date | null;
  emailInvalid: boolean;
  phoneInvalid: boolean;
  whatsappInvalid: boolean;
  emailUnsubscribedVenues: string[];
  smsUnsubscribedVenues: string[];
  whatsappUnsubscribedVenues: string[];
};

function deliverable(channel: MessageChannel, venueId: string, guest: GuestChannelState): boolean {
  switch (channel) {
    case "email":
      return !guest.emailInvalid && !guest.emailUnsubscribedVenues.includes(venueId);
    case "sms":
      return (
        guest.hasPhone && !guest.phoneInvalid && !guest.smsUnsubscribedVenues.includes(venueId)
      );
    case "whatsapp":
      return (
        guest.hasPhone &&
        !guest.whatsappInvalid &&
        !guest.whatsappUnsubscribedVenues.includes(venueId)
      );
  }
}

export type ResolveInput = {
  event: FlowEvent;
  venueId: string;
  config: FlowEventSettings;
  guest: GuestChannelState;
};

// The single channel to enqueue for this event, or null for none.
export function resolveChannel(input: ResolveInput): MessageChannel | null {
  if (!input.config.enabled) return null;
  if (input.guest.erasedAt) return null;

  const capable = new Set(templateChannels(FLOW_EVENT_TEMPLATE[input.event]));
  for (const channel of input.config.channels) {
    if (!capable.has(channel)) continue; // operator picked a channel the template can't render
    if (deliverable(channel, input.venueId, input.guest)) return channel;
  }
  return null;
}
