// Shared list of booking statuses that "count" as a realised visit
// for reporting + guest history. Cancelled / no-show / requested
// don't earn a visit. Kept here (not in state.ts) so the guest
// history and reporting modules can import without dragging the
// transition state machine along with them.

export const REALISED_STATUSES = ["confirmed", "seated", "finished"] as const;

export type RealisedStatus = (typeof REALISED_STATUSES)[number];
