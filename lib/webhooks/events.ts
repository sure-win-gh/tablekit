// Webhook event names — shared between server (subscription writes,
// PR6b dispatcher) and client (dashboard form checkboxes).
//
// Lives in its own file (no `server-only`) so it can be imported
// from a "use client" component without dragging in the encrypt /
// db / adminDb chain. PR6b's dispatcher imports the same array
// for its allow-list check, so this file is the single source of
// truth for the event taxonomy.

export const WEBHOOK_EVENTS = [
  "booking.created",
  "booking.updated",
  "booking.cancelled",
  "booking.seated",
  "booking.no_show",
] as const;

export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];
