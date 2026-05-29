"use client";

import { useState, type PointerEvent, type RefObject } from "react";

import { FLOOR_STATE_STYLE, type FloorTableState } from "@/lib/bookings/floor-state";

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
  state: FloorTableState;
  selected: boolean;
  editMode: boolean;
  svgRef: RefObject<SVGSVGElement | null>;
  onSelect: (tableId: string) => void;
  onDragEnd?: ((tableId: string, next: TablePosition) => void) | undefined;
};

type ResizeDir = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";

const MIN_DIM = 1;
const POS_BOUND = 100;
const clampPos = (v: number) => Math.min(POS_BOUND, Math.max(-POS_BOUND, v));

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

// Live (un-snapped) resize given a directional handle. Clamps against
// the grid origin and a minimum dimension so the table can't invert
// or escape the canvas. Snapping happens on pointer-up.
//
// When `lockSquare` is true (circles), w and h are locked together
// using whichever dimension grew more. The opposite corner stays
// pinned so the table feels like it's pivoting around it.
function applyResize(
  anchor: TablePosition,
  dx: number,
  dy: number,
  dir: ResizeDir,
  lockSquare: boolean,
): TablePosition {
  let { x, y, w, h } = anchor;
  if (dir.includes("e")) {
    w = Math.max(MIN_DIM, anchor.w + dx);
  }
  if (dir.includes("w")) {
    const dxClamped = Math.min(dx, anchor.w - MIN_DIM);
    x = anchor.x + dxClamped;
    w = anchor.w - dxClamped;
  }
  if (dir.includes("s")) {
    h = Math.max(MIN_DIM, anchor.h + dy);
  }
  if (dir.includes("n")) {
    const dyClamped = Math.min(dy, anchor.h - MIN_DIM);
    y = anchor.y + dyClamped;
    h = anchor.h - dyClamped;
  }
  if (lockSquare) {
    const size = Math.max(MIN_DIM, w, h);
    if (dir.includes("w")) {
      x = anchor.x + anchor.w - size;
    }
    if (dir.includes("n")) {
      y = anchor.y + anchor.h - size;
    }
    w = size;
    h = size;
  }
  return { x, y, w, h };
}

export function TableShape({
  table,
  state,
  selected,
  editMode,
  svgRef,
  onSelect,
  onDragEnd,
}: Props) {
  const style = FLOOR_STATE_STYLE[state];
  const isSoon = state === "soon";
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

  const [resize, setResize] = useState<{
    anchor: TablePosition;
    startUserX: number;
    startUserY: number;
    dir: ResizeDir;
    current: TablePosition;
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
    const nextX = clampPos(Math.round(anchor.x + drag.dx));
    const nextY = clampPos(Math.round(anchor.y + drag.dy));
    setDrag(null);
    if (onDragEnd && (nextX !== anchor.x || nextY !== anchor.y)) {
      onDragEnd(table.id, { x: nextX, y: nextY, w: anchor.w, h: anchor.h });
    }
  };

  const onResizePointerDown = (dir: ResizeDir) => (e: PointerEvent<SVGRectElement>) => {
    if (!editMode || !onDragEnd) return;
    if (!svgRef.current) return;
    const local = screenToSvg(svgRef.current, e.clientX, e.clientY);
    if (!local) return;
    e.stopPropagation(); // do not start a move-drag on the parent <g>
    (e.target as Element).setPointerCapture(e.pointerId);
    setResize({
      anchor: table.position,
      startUserX: local.x,
      startUserY: local.y,
      dir,
      current: table.position,
    });
  };

  const onResizePointerMove = (e: PointerEvent<SVGRectElement>) => {
    if (!resize || !svgRef.current) return;
    const local = screenToSvg(svgRef.current, e.clientX, e.clientY);
    if (!local) return;
    const dx = local.x - resize.startUserX;
    const dy = local.y - resize.startUserY;
    setResize({
      ...resize,
      current: applyResize(resize.anchor, dx, dy, resize.dir, table.shape === "circle"),
    });
  };

  const onResizePointerUp = (e: PointerEvent<SVGRectElement>) => {
    if (!resize) return;
    (e.target as Element).releasePointerCapture(e.pointerId);
    const { anchor, current } = resize;
    const next: TablePosition = {
      x: clampPos(Math.round(current.x)),
      y: clampPos(Math.round(current.y)),
      w: Math.max(MIN_DIM, Math.round(current.w)),
      h: Math.max(MIN_DIM, Math.round(current.h)),
    };
    setResize(null);
    const changed =
      next.x !== anchor.x || next.y !== anchor.y || next.w !== anchor.w || next.h !== anchor.h;
    if (onDragEnd && changed) {
      onDragEnd(table.id, next);
    }
  };

  const onClick = () => {
    if (drag || resize) return; // a drag-end fires a click on some browsers; suppress
    onSelect(table.id);
  };

  // Render coords. During drag/resize, follow the live (un-snapped)
  // values for a fluid feel; outside both, use the persisted position.
  const px = drag ? drag.anchor.x + drag.dx : resize ? resize.current.x : table.position.x;
  const py = drag ? drag.anchor.y + drag.dy : resize ? resize.current.y : table.position.y;
  const w = resize ? resize.current.w : table.position.w;
  const h = resize ? resize.current.h : table.position.h;

  const cx = px + w / 2;
  const cy = py + h / 2;

  const showHandles = selected && editMode && !!onDragEnd;
  const handleSize = Math.min(0.5, Math.max(0.25, Math.min(w, h) * 0.18));
  const half = handleSize / 2;
  // Circles only expose corner handles — edge handles would let one
  // axis grow independently, breaking the locked square aspect.
  const isCircle = table.shape === "circle";
  const handles: { dir: ResizeDir; hx: number; hy: number; cursor: string }[] = [
    { dir: "nw", hx: px - half, hy: py - half, cursor: "cursor-nwse-resize" },
    ...(isCircle
      ? []
      : [{ dir: "n" as const, hx: px + w / 2 - half, hy: py - half, cursor: "cursor-ns-resize" }]),
    { dir: "ne", hx: px + w - half, hy: py - half, cursor: "cursor-nesw-resize" },
    ...(isCircle
      ? []
      : [
          {
            dir: "e" as const,
            hx: px + w - half,
            hy: py + h / 2 - half,
            cursor: "cursor-ew-resize",
          },
        ]),
    { dir: "se", hx: px + w - half, hy: py + h - half, cursor: "cursor-nwse-resize" },
    ...(isCircle
      ? []
      : [
          {
            dir: "s" as const,
            hx: px + w / 2 - half,
            hy: py + h - half,
            cursor: "cursor-ns-resize",
          },
        ]),
    { dir: "sw", hx: px - half, hy: py + h - half, cursor: "cursor-nesw-resize" },
    ...(isCircle
      ? []
      : [{ dir: "w" as const, hx: px - half, hy: py + h / 2 - half, cursor: "cursor-ew-resize" }]),
  ];

  return (
    <g
      className={`${editMode ? "cursor-grab active:cursor-grabbing" : "cursor-pointer"} ${drag || resize ? "opacity-90" : ""} outline-none focus:outline-none focus-visible:outline-none`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onClick={onClick}
      tabIndex={0}
      role="button"
      aria-label={`Table ${table.label}, ${state}`}
    >
      <title>
        {`Table ${table.label} · ${table.minCover}–${table.maxCover} covers · ${state}`}
      </title>
      {table.shape === "circle" ? (
        <ellipse
          cx={cx}
          cy={cy}
          rx={w / 2}
          ry={h / 2}
          className={`${style.fillClass} ${selected ? "stroke-coral" : style.strokeClass} ${
            isSoon ? "animate-pulse" : ""
          }`}
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
          className={`${style.fillClass} ${selected ? "stroke-coral" : style.strokeClass} ${
            isSoon ? "animate-pulse" : ""
          }`}
          strokeWidth={selected ? 0.15 : 0.08}
        />
      )}
      <text
        x={cx}
        y={cy - Math.min(w, h) * 0.1}
        textAnchor="middle"
        dominantBaseline="central"
        className={`${style.textClass} pointer-events-none select-none`}
        style={{ fontSize: Math.min(w, h) * 0.35, fontWeight: 600 }}
      >
        {table.label}
      </text>
      <text
        x={cx}
        y={cy + Math.min(w, h) * 0.28}
        textAnchor="middle"
        dominantBaseline="central"
        className={`${style.textClass} pointer-events-none opacity-70 select-none`}
        style={{ fontSize: Math.min(w, h) * 0.2, fontWeight: 500 }}
      >
        {table.minCover}–{table.maxCover}
      </text>
      {showHandles
        ? handles.map((p) => (
            <rect
              key={p.dir}
              x={p.hx}
              y={p.hy}
              width={handleSize}
              height={handleSize}
              rx={0.06}
              ry={0.06}
              className={`stroke-coral fill-white ${p.cursor}`}
              strokeWidth={0.06}
              onPointerDown={onResizePointerDown(p.dir)}
              onPointerMove={onResizePointerMove}
              onPointerUp={onResizePointerUp}
              onPointerCancel={onResizePointerUp}
            />
          ))
        : null}
    </g>
  );
}
