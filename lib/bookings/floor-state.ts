// Floor-plan-specific state vocabulary.
//
// `STATUS_FILL` / `STATUS_SVG_FILL` in `./status-style.ts` carry six
// raw booking statuses and feed the timeline + dialogs. The floor
// plan needs a different read: it answers "what's happening on this
// table *right now*", so requested + confirmed collapse into one
// colour, soon-but-empty gets its own, and a seated booking past
// its end-time graduates to overdue.

import type { BookingStatus } from "./state";

export type FloorTableState = "empty" | "soon" | "confirmed" | "seated" | "overdue";

export type FloorStateStyle = {
  fillClass: string;
  strokeClass: string;
  textClass: string;
};

export const FLOOR_STATE_STYLE: Record<FloorTableState, FloorStateStyle> = {
  empty: { fillClass: "fill-white", strokeClass: "stroke-hairline", textClass: "fill-ink" },
  soon: {
    fillClass: "fill-amber-100",
    strokeClass: "stroke-amber-400",
    textClass: "fill-amber-900",
  },
  confirmed: {
    fillClass: "fill-blue-100",
    strokeClass: "stroke-blue-400",
    textClass: "fill-blue-900",
  },
  seated: {
    fillClass: "fill-emerald-100",
    strokeClass: "stroke-emerald-500",
    textClass: "fill-emerald-900",
  },
  overdue: {
    fillClass: "fill-rose-100",
    strokeClass: "stroke-rose-500",
    textClass: "fill-rose-900",
  },
};

export const FLOOR_STATE_LABEL: Record<FloorTableState, string> = {
  empty: "Empty",
  soon: "Soon",
  confirmed: "Booked",
  seated: "Seated",
  overdue: "Overdue",
};

// Dot colour for the legend chips (HTML, not SVG).
export const FLOOR_STATE_DOT: Record<FloorTableState, string> = {
  empty: "bg-white border border-neutral-300",
  soon: "bg-amber-300",
  confirmed: "bg-blue-300",
  seated: "bg-emerald-400",
  overdue: "bg-rose-400",
};

export function deriveFloorState(
  active: { status: BookingStatus; endAt: Date } | null,
  upcoming: boolean,
  now: Date,
): FloorTableState {
  if (active) {
    if (active.status === "seated") {
      return active.endAt.getTime() < now.getTime() ? "overdue" : "seated";
    }
    // requested + confirmed both read as "booked" — operators care
    // that the seat is held, not which subtype is doing the holding.
    return "confirmed";
  }
  return upcoming ? "soon" : "empty";
}
