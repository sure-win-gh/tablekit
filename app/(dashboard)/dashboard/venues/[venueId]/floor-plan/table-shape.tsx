"use client";

import { useState, type PointerEvent, type RefObject } from "react";

import type { BookingStatus } from "@/lib/bookings/state";
import { EMPTY_TABLE_SVG, STATUS_SVG_FILL, type SvgStatusStyle } from "@/lib/bookings/status-style";

export type TablePosition = { x: number; y: number; w: number; h: number };

export type TableShapeData = {
  id: string;
  label: string;
  shape: string; // "rect" | "circle" — defensive about legacy values
  position: TablePosition;
  minCover: number;
  maxCover: number;
};

type Props = {
  table: TableShapeData;
  status: BookingStatus | null;
  upcoming: boolean;
  selected: boolean;
  editMode: boolean;
  svgRef: RefObject<SVGSVGElement | null>;
  onSelect: (tableId: string) => void;
  onDragEnd?: ((tableId: string, next: TablePosition) => void) | undefined;
};

// Convert a pointer event's screen-space coordinates into SVG user
// space (the same units as `viewBox`). `getScreenCTM().inverse()` is
// the canonical way to do this with arbitrary viewport transforms.
function screenToSvg(
  svg: SVGSVGElement,
  clientX: number,
  clientY: number,
): { x: number; y: number } | null {
  const ctm = svg.getScreenCTM();
  if (!ctm) return null;
  const pt = svg.createSVGPoint();
  pt.x = clientX;
  pt.y = clientY;
  const local = pt.matrixTransform(ctm.inverse());
  return { x: local.x, y: local.y };
}

export function TableShape({
  table,
  status,
  upcoming,
  selected,
  editMode,
  svgRef,
  onSelect,
  onDragEnd,
}: Props) {
  const style: SvgStatusStyle = status ? STATUS_SVG_FILL[status] : EMPTY_TABLE_SVG;
  // Anchor lives inside drag state so we never read a ref during
  // render. Captured once at pointer-down so optimistic position
  // updates from a parent can't shift the anchor mid-drag.
  const [drag, setDrag] = useState<{
    anchor: TablePosition;
    startUserX: number;
    startUserY: number;
    dx: number;
    dy: number;
  } | null>(null);

  const onPointerDown = (e: PointerEvent<SVGGElement>) => {
    if (!editMode || !onDragEnd) return;
    if (!svgRef.current) return;
    const local = screenToSvg(svgRef.current, e.clientX, e.clientY);
    if (!local) return;
    e.stopPropagation(); // keep the canvas viewport-drag handler from grabbing this
    (e.target as Element).setPointerCapture(e.pointerId);
    setDrag({
      anchor: table.position,
      startUserX: local.x,
      startUserY: local.y,
      dx: 0,
      dy: 0,
    });
  };

  const onPointerMove = (e: PointerEvent<SVGGElement>) => {
    if (!drag || !svgRef.current) return;
    const local = screenToSvg(svgRef.current, e.clientX, e.clientY);
    if (!local) return;
    setDrag({
      ...drag,
      dx: local.x - drag.startUserX,
      dy: local.y - drag.startUserY,
    });
  };

  const onPointerUp = (e: PointerEvent<SVGGElement>) => {
    if (!drag) return;
    (e.target as Element).releasePointerCapture(e.pointerId);
    const { anchor } = drag;
    // Snap to integer grid units. tables.position columns are int.
    const nextX = Math.max(0, Math.round(anchor.x + drag.dx));
    const nextY = Math.max(0, Math.round(anchor.y + drag.dy));
    setDrag(null);
    if (onDragEnd && (nextX !== anchor.x || nextY !== anchor.y)) {
      onDragEnd(table.id, { x: nextX, y: nextY, w: anchor.w, h: anchor.h });
    }
  };

  const onClick = () => {
    if (drag) return; // a drag-end fires a click on some browsers; suppress
    onSelect(table.id);
  };

  // Render coords. During drag, follow the live (un-snapped) offset for
  // a fluid feel; outside drag, use the persisted position.
  const px = drag ? drag.anchor.x + drag.dx : table.position.x;
  const py = drag ? drag.anchor.y + drag.dy : table.position.y;
  const { w, h } = table.position;

  const cx = px + w / 2;
  const cy = py + h / 2;

  return (
    <g
      className={`${editMode ? "cursor-grab active:cursor-grabbing" : "cursor-pointer"} ${drag ? "opacity-90" : ""}`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onClick={onClick}
      tabIndex={0}
      role="button"
      aria-label={`Table ${table.label}${status ? `, ${status.replace("_", " ")}` : ", empty"}`}
    >
      <title>
        {`Table ${table.label} · ${table.minCover}–${table.maxCover} covers · ${
          status ? status.replace("_", " ") : upcoming ? "empty (next booking soon)" : "empty"
        }`}
      </title>
      {table.shape === "circle" ? (
        <ellipse
          cx={cx}
          cy={cy}
          rx={w / 2}
          ry={h / 2}
          className={`${style.fillClass} ${style.strokeClass} ${
            selected ? "stroke-coral" : ""
          } ${upcoming && !status ? "animate-pulse" : ""}`}
          strokeWidth={selected ? 0.15 : 0.08}
        />
      ) : (
        <rect
          x={px}
          y={py}
          width={w}
          height={h}
          rx={0.2}
          ry={0.2}
          className={`${style.fillClass} ${style.strokeClass} ${
            selected ? "stroke-coral" : ""
          } ${upcoming && !status ? "animate-pulse" : ""}`}
          strokeWidth={selected ? 0.15 : 0.08}
        />
      )}
      <text
        x={cx}
        y={cy}
        textAnchor="middle"
        dominantBaseline="central"
        className={`${style.textClass} pointer-events-none select-none`}
        style={{ fontSize: Math.min(w, h) * 0.4, fontWeight: 600 }}
      >
        {table.label}
      </text>
    </g>
  );
}
