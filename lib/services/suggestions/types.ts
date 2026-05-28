// Service-management suggestion engine — types.
//
// Each rule is a pure (ServiceContext) => Suggestion | null. The runner
// evaluates them in priority order and returns the first hit, so a service
// shows at most one nudge. Context is assembled server-side in
// ./context.ts; rules never touch the DB.

export type Suggestion = {
  rule: string; // stable id, e.g. "underbooked-72h"
  message: string; // operator-facing nudge
};

export type ServiceContext = {
  serviceId: string;
  utilisation: number; // booked / capacity (0..n)
  startsAt: Date; // service window start, UTC
  now: Date;
  windowMinutes: number; // service window length
  turnMinutes: number;
  // Walk-in covers as a share of total covers on this weekday over the
  // recent past (venue-level, 0..1).
  walkInWeekdayShare: number;
  // How many of this service's bookings today are from guests with a prior
  // no-show.
  noShowProneBookingCount: number;
};

export type Rule = (ctx: ServiceContext) => Suggestion | null;
