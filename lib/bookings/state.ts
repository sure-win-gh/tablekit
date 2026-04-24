// Booking state machine.
//
// Encoded in TS so reviewers can see the graph at a glance, and
// enforced in the `transitionBooking` server action. Terminal states
// (finished, cancelled, no_show) have no outgoing edges.
//
// `requested` exists today only as a placeholder — host-created
// bookings go straight to `confirmed`. The deposit flow (payments
// phase) will introduce the `requested → confirmed` edge when a
// deposit intent succeeds.

export const BOOKING_STATUSES = [
  "requested",
  "confirmed",
  "seated",
  "finished",
  "cancelled",
  "no_show",
] as const;

export type BookingStatus = (typeof BOOKING_STATUSES)[number];

export const TRANSITIONS: Record<BookingStatus, readonly BookingStatus[]> = {
  requested: ["confirmed", "cancelled"],
  confirmed: ["seated", "cancelled", "no_show"],
  seated: ["finished", "cancelled"],
  finished: [],
  cancelled: [],
  no_show: [],
};

export class InvalidTransitionError extends Error {
  readonly from: BookingStatus;
  readonly to: BookingStatus;
  constructor(from: BookingStatus, to: BookingStatus) {
    super(`Invalid booking transition: ${from} → ${to}`);
    this.name = "InvalidTransitionError";
    this.from = from;
    this.to = to;
  }
}

export function canTransition(from: BookingStatus, to: BookingStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function assertTransition(from: BookingStatus, to: BookingStatus): void {
  if (!canTransition(from, to)) throw new InvalidTransitionError(from, to);
}

// For UI: what actions a user can take next. Used by the dashboard
// status column to render the right buttons.
export function nextActions(from: BookingStatus): BookingStatus[] {
  return [...TRANSITIONS[from]];
}
