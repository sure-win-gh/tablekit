// Feature flags / kill switches.
//
// Per docs/playbooks/incident.md the operator can flip an env var on
// Vercel to take down a surface in ~30 seconds. The functions here
// are the single source of truth for "is this surface live right
// now". Each is `true` when the surface is **disabled**.
//
// Truthy values: '1', 'true', 'yes', 'on' (case-insensitive). Anything
// else (unset, '0', '', 'false') is false. Loosely permissive so an
// operator setting `WIDGET_DISABLED=true` from a phone Vercel app
// doesn't have to remember the magic value.
//
// Existing flags wired elsewhere — listed here so this file is the
// complete inventory:
//   - PAYMENTS_DISABLED → lib/stripe/client.ts  (paymentsDisabled)
//   - EMAIL_DISABLED    → lib/email/client.ts   (messagingDisabled)
//   - SMS_DISABLED      → lib/sms/client.ts     (messagingDisabled)
//
// New flags wired from this file:
//   - WIDGET_DISABLED   → public /book/<venueId> + POST /api/v1/bookings
//   - BOOKINGS_READ_ONLY → POST /api/v1/bookings + host createBookingAction
//   - RWG_DISABLED      → reserve-with-google endpoints (paused; checked
//                          here so the flag works as soon as RWG ships)

const TRUTHY = new Set(["1", "true", "yes", "on"]);

function isTruthy(name: string): boolean {
  const v = process.env[name];
  return typeof v === "string" && TRUTHY.has(v.trim().toLowerCase());
}

export function widgetDisabled(): boolean {
  return isTruthy("WIDGET_DISABLED");
}

export function bookingsReadOnly(): boolean {
  return isTruthy("BOOKINGS_READ_ONLY");
}

export function rwgDisabled(): boolean {
  return isTruthy("RWG_DISABLED");
}
