import type { BookingStatus } from "./state";

// Single source of truth for booking-status colour tokens. Used by
// the timeline (HTML blocks) and the floor plan SVG canvas. Adding
// a status here surfaces it in both places without re-mapping.
//
// The HTML variant tints `bg-* border-* text-*` on a div block.
// The SVG variant uses Tailwind's `fill-* stroke-*` utilities so the
// SVG nodes can share the same palette without parsing class names.

export const STATUS_FILL: Record<BookingStatus, string> = {
  requested: "bg-amber-100 border-amber-300 text-amber-900",
  confirmed: "bg-blue-100 border-blue-300 text-blue-900",
  seated: "bg-emerald-100 border-emerald-300 text-emerald-900",
  finished: "bg-neutral-100 border-neutral-300 text-neutral-700",
  cancelled: "bg-stone-100 border-stone-200 text-ash line-through",
  no_show: "bg-rose-100 border-rose-300 text-rose-900",
};

export type SvgStatusStyle = {
  fillClass: string;
  strokeClass: string;
  textClass: string;
};

export const STATUS_SVG_FILL: Record<BookingStatus, SvgStatusStyle> = {
  requested: {
    fillClass: "fill-amber-100",
    strokeClass: "stroke-amber-300",
    textClass: "fill-amber-900",
  },
  confirmed: {
    fillClass: "fill-blue-100",
    strokeClass: "stroke-blue-300",
    textClass: "fill-blue-900",
  },
  seated: {
    fillClass: "fill-emerald-100",
    strokeClass: "stroke-emerald-300",
    textClass: "fill-emerald-900",
  },
  finished: {
    fillClass: "fill-neutral-100",
    strokeClass: "stroke-neutral-300",
    textClass: "fill-neutral-700",
  },
  cancelled: {
    fillClass: "fill-stone-100",
    strokeClass: "stroke-stone-200",
    textClass: "fill-ash",
  },
  no_show: {
    fillClass: "fill-rose-100",
    strokeClass: "stroke-rose-300",
    textClass: "fill-rose-900",
  },
};

// Empty-table style — when no booking is active on a table.
export const EMPTY_TABLE_SVG: SvgStatusStyle = {
  fillClass: "fill-white",
  strokeClass: "stroke-hairline",
  textClass: "fill-ink",
};
