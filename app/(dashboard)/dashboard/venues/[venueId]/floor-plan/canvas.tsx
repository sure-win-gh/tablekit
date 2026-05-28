"use client";

import { Maximize2, Minus, Pencil, Plus as PlusIcon } from "lucide-react";
import {
  useActionState,
  useCallback,
  useMemo,
  useOptimistic,
  useRef,
  useState,
  useTransition,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent as ReactWheelEvent,
} from "react";

import { Button } from "@/components/ui";
import {
  FLOOR_STATE_DOT,
  FLOOR_STATE_LABEL,
  type FloorTableState,
} from "@/lib/bookings/floor-state";

import { createTable, saveTablePosition } from "./actions";
import { NewAreaForm } from "./forms";
import { SidePanel, type ActiveBookingDetail } from "./side-panel";
import { TableShape, type TablePosition, type TableShapeData } from "./table-shape";
import type { ActionState } from "./types";

export type CanvasArea = {
  id: string;
  name: string;
};

export type CanvasTable = TableShapeData & {
  areaId: string;
};

type Props = {
  venueId: string;
  date: string;
  canEdit: boolean;
  areas: CanvasArea[];
  tables: CanvasTable[];
  activeByTableId: Record<string, ActiveBookingDetail>;
  upcomingByTableId: Record<string, ActiveBookingDetail>;
  floorStateByTableId: Record<string, FloorTableState>;
};

const idle: ActionState = { status: "idle" };

// SVG viewport in grid units. We pad the bounding box so tables don't
// hug the canvas edge.
function fitViewBox(tables: CanvasTable[]): {
  x: number;
  y: number;
  width: number;
  height: number;
} {
  if (tables.length === 0) {
    // Centre the origin (0,0) when there are no tables to fit around.
    return { x: -10, y: -7, width: 20, height: 14 };
  }
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const t of tables) {
    minX = Math.min(minX, t.position.x);
    minY = Math.min(minY, t.position.y);
    maxX = Math.max(maxX, t.position.x + t.position.w);
    maxY = Math.max(maxY, t.position.y + t.position.h);
  }
  const padding = 2;
  return {
    x: minX - padding,
    y: minY - padding,
    width: maxX - minX + padding * 2,
    height: maxY - minY + padding * 2,
  };
}

export function FloorPlanCanvas({
  venueId,
  date,
  canEdit,
  areas,
  tables,
  activeByTableId,
  upcomingByTableId,
  floorStateByTableId,
}: Props) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [editMode, setEditMode] = useState(false);
  const [selectedTableId, setSelectedTableId] = useState<string | null>(null);
  // The canvas always scopes to one area. Default to the first one.
  const [activeAreaId, setActiveAreaId] = useState<string | null>(() => areas[0]?.id ?? null);

  // Optimistic positions — drag-end updates this immediately, then the
  // server action revalidates and the RSC re-renders with the persisted
  // values. The reducer key is `tableId` so multiple drags compose.
  const [optimisticTables, applyOptimistic] = useOptimistic(
    tables,
    (current: CanvasTable[], next: { id: string; position: TablePosition }) =>
      current.map((t) => (t.id === next.id ? { ...t, position: next.position } : t)),
  );

  const visibleTables = useMemo(
    () =>
      activeAreaId ? optimisticTables.filter((t) => t.areaId === activeAreaId) : optimisticTables,
    [optimisticTables, activeAreaId],
  );

  const [, startTransition] = useTransition();
  const [, formAction] = useActionState(saveTablePosition, idle);
  const [createState, createAction, createPending] = useActionState(createTable, idle);

  // First render fits to whichever area is active by default.
  const [viewBox, setViewBox] = useState(() => {
    const subset = activeAreaId ? tables.filter((t) => t.areaId === activeAreaId) : tables;
    return fitViewBox(subset);
  });

  const fitToViewport = useCallback(() => {
    const subset = activeAreaId ? tables.filter((t) => t.areaId === activeAreaId) : tables;
    setViewBox(fitViewBox(subset));
  }, [tables, activeAreaId]);

  const handleAreaChange = useCallback(
    (id: string | null) => {
      setActiveAreaId(id);
      setSelectedTableId(null);
      const subset = id ? tables.filter((t) => t.areaId === id) : tables;
      setViewBox(fitViewBox(subset));
    },
    [tables],
  );

  // Wheel zoom — keep the cursor's user-coord point fixed under the
  // pointer so zoom feels anchored.
  const onWheel = useCallback(
    (e: ReactWheelEvent<SVGSVGElement>) => {
      e.preventDefault();
      const svg = svgRef.current;
      if (!svg) return;
      const rect = svg.getBoundingClientRect();
      const cursorRatioX = (e.clientX - rect.left) / rect.width;
      const cursorRatioY = (e.clientY - rect.top) / rect.height;
      const zoom = Math.exp(e.deltaY * 0.0015); // small smooth steps
      const newWidth = Math.min(200, Math.max(4, viewBox.width * zoom));
      const newHeight = Math.min(200, Math.max(4, viewBox.height * zoom));
      const cursorUserX = viewBox.x + cursorRatioX * viewBox.width;
      const cursorUserY = viewBox.y + cursorRatioY * viewBox.height;
      setViewBox({
        x: cursorUserX - cursorRatioX * newWidth,
        y: cursorUserY - cursorRatioY * newHeight,
        width: newWidth,
        height: newHeight,
      });
    },
    [viewBox],
  );

  // Background drag = viewport translate. We swallow events on the
  // background <rect>; table shapes stop propagation in their own
  // pointerdown, so dragging a table never moves the viewport.
  const dragRef = useRef<{
    startClientX: number;
    startClientY: number;
    startViewX: number;
    startViewY: number;
  } | null>(null);

  const onBgPointerDown = (e: ReactPointerEvent<SVGRectElement>) => {
    (e.target as Element).setPointerCapture(e.pointerId);
    dragRef.current = {
      startClientX: e.clientX,
      startClientY: e.clientY,
      startViewX: viewBox.x,
      startViewY: viewBox.y,
    };
  };

  const onBgPointerMove = (e: ReactPointerEvent<SVGRectElement>) => {
    const d = dragRef.current;
    if (!d) return;
    const svg = svgRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    const dxUser = ((e.clientX - d.startClientX) / rect.width) * viewBox.width;
    const dyUser = ((e.clientY - d.startClientY) / rect.height) * viewBox.height;
    setViewBox((v) => ({ ...v, x: d.startViewX - dxUser, y: d.startViewY - dyUser }));
  };

  const onBgPointerUp = (e: ReactPointerEvent<SVGRectElement>) => {
    (e.target as Element).releasePointerCapture(e.pointerId);
    dragRef.current = null;
  };

  // Auto-generate the next free numeric label so a fresh table never
  // collides with an existing one in this venue. Server still validates.
  const handleAddTable = useCallback(() => {
    if (!activeAreaId) return;
    const used = new Set(tables.map((t) => t.label));
    let label = "";
    for (let n = 1; n < 10000; n++) {
      const s = String(n);
      if (!used.has(s)) {
        label = s;
        break;
      }
    }
    if (!label) label = `T-${Date.now()}`;
    const fd = new FormData();
    fd.set("area_id", activeAreaId);
    fd.set("label", label);
    fd.set("min_cover", "2");
    fd.set("max_cover", "4");
    fd.set("shape", "rect");
    fd.set("x", "0");
    fd.set("y", "0");
    fd.set("w", "2");
    fd.set("h", "2");
    startTransition(() => {
      createAction(fd);
    });
  }, [activeAreaId, tables, createAction]);

  // Persist position changes from a table drag-end.
  const handleDragEnd = useCallback(
    (tableId: string, position: TablePosition) => {
      const fd = new FormData();
      fd.set("table_id", tableId);
      fd.set("x", String(position.x));
      fd.set("y", String(position.y));
      fd.set("w", String(position.w));
      fd.set("h", String(position.h));
      startTransition(() => {
        applyOptimistic({ id: tableId, position });
        formAction(fd);
      });
    },
    [applyOptimistic, formAction],
  );

  // Connectors between tables that share a multi-table booking.
  const connectors = useMemo(() => {
    type Pair = { aId: string; bId: string; status: string };
    const pairs: Pair[] = [];
    const byBooking = new Map<string, string[]>();
    for (const [tableId, b] of Object.entries(activeByTableId)) {
      const arr = byBooking.get(b.id) ?? [];
      arr.push(tableId);
      byBooking.set(b.id, arr);
    }
    for (const [, tableIds] of byBooking.entries()) {
      if (tableIds.length < 2) continue;
      const head = tableIds[0];
      if (!head) continue;
      const status = activeByTableId[head]?.status ?? "confirmed";
      for (let i = 1; i < tableIds.length; i++) {
        const tail = tableIds[i];
        if (!tail) continue;
        pairs.push({ aId: head, bId: tail, status });
      }
    }
    return pairs;
  }, [activeByTableId]);

  const tableById = useMemo(() => {
    const m = new Map<string, CanvasTable>();
    for (const t of optimisticTables) m.set(t.id, t);
    return m;
  }, [optimisticTables]);

  const selectedTable = selectedTableId ? (tableById.get(selectedTableId) ?? null) : null;

  return (
    <div className="rounded-card border-hairline relative h-[600px] overflow-hidden border bg-white">
      {/* Legend — top-right, mobile hides to keep the small viewport
          uncluttered (matches the edit-toggle's `hidden md:inline-flex`
          rule). */}
      <Legend />
      {/* Toolbar */}
      <div className="absolute top-3 left-3 z-10 flex flex-wrap items-center gap-2">
        <Button variant="secondary" size="sm" onClick={fitToViewport}>
          <Maximize2 className="h-3.5 w-3.5" aria-hidden />
          Fit
        </Button>
        <Button
          variant="secondary"
          size="sm"
          onClick={() =>
            setViewBox((v) => ({
              ...v,
              width: Math.max(4, v.width * 0.85),
              height: Math.max(4, v.height * 0.85),
            }))
          }
          aria-label="Zoom in"
        >
          <PlusIcon className="h-3.5 w-3.5" aria-hidden />
        </Button>
        <Button
          variant="secondary"
          size="sm"
          onClick={() =>
            setViewBox((v) => ({
              ...v,
              width: Math.min(200, v.width * 1.15),
              height: Math.min(200, v.height * 1.15),
            }))
          }
          aria-label="Zoom out"
        >
          <Minus className="h-3.5 w-3.5" aria-hidden />
        </Button>
        {canEdit ? (
          // Hidden below the md breakpoint — mobile is read-only per
          // floor-plan-visual.md acceptance. Drag handlers in
          // table-shape only fire when editMode is true; with the
          // toggle hidden the state never flips and pointer-drag on
          // touch screens can't move tables.
          <Button
            variant={editMode ? "primary" : "secondary"}
            size="sm"
            onClick={() => setEditMode((m) => !m)}
            className="hidden md:inline-flex"
          >
            <Pencil className="h-3.5 w-3.5" aria-hidden />
            {editMode ? "Editing" : "Edit"}
          </Button>
        ) : null}
        {areas.length > 1 ? (
          <div
            role="tablist"
            aria-label="Filter by area"
            className="border-hairline ml-1 flex items-center gap-0.5 rounded-md border bg-white p-0.5"
          >
            {areas.map((a) => (
              <AreaPill
                key={a.id}
                label={a.name}
                active={activeAreaId === a.id}
                onClick={() => handleAreaChange(a.id)}
              />
            ))}
          </div>
        ) : null}
        {editMode && activeAreaId ? (
          <Button variant="secondary" size="sm" onClick={handleAddTable} disabled={createPending}>
            <PlusIcon className="h-3.5 w-3.5" aria-hidden />
            {createPending ? "Adding…" : "Add table"}
          </Button>
        ) : null}
        {createState.status === "error" ? (
          <p role="alert" className="text-xs text-red-600">
            {createState.message}
          </p>
        ) : null}
      </div>

      {editMode ? (
        <div className="absolute bottom-3 left-3 z-10 flex max-w-[60%] flex-col gap-2">
          <NewAreaForm venueId={venueId} />
        </div>
      ) : null}

      <svg
        ref={svgRef}
        className={`h-full w-full ${editMode ? "bg-cloud" : "bg-white"}`}
        viewBox={`${viewBox.x} ${viewBox.y} ${viewBox.width} ${viewBox.height}`}
        onWheel={onWheel}
      >
        <defs>
          {/* 1×1 grid-unit pattern — matches the integer position grid
              that drag/resize snaps to. Stroke kept faint so it sits
              behind the tables. */}
          <pattern id="floor-grid" width={1} height={1} patternUnits="userSpaceOnUse">
            <path
              d="M 1 0 L 0 0 0 1"
              fill="none"
              stroke="#e5e5e5"
              strokeWidth={1}
              vectorEffect="non-scaling-stroke"
            />
          </pattern>
        </defs>
        {/* Background — drag to translate the viewport. Sized large so
            it covers any zoom level. */}
        <rect
          x={-1000}
          y={-1000}
          width={2000}
          height={2000}
          className={`${editMode ? "fill-cloud" : "fill-white"} cursor-grab active:cursor-grabbing`}
          onPointerDown={onBgPointerDown}
          onPointerMove={onBgPointerMove}
          onPointerUp={onBgPointerUp}
          onPointerCancel={onBgPointerUp}
        />
        {/* Grid overlay — non-interactive so viewport drag still works. */}
        <rect
          x={-1000}
          y={-1000}
          width={2000}
          height={2000}
          fill="url(#floor-grid)"
          pointerEvents="none"
        />
        {/* Origin axes — a touch darker than the grid so the centre is
            visible against the otherwise-uniform pattern. */}
        <line
          x1={0}
          y1={-1000}
          x2={0}
          y2={1000}
          stroke="#c8c8c8"
          strokeWidth={1}
          vectorEffect="non-scaling-stroke"
          pointerEvents="none"
        />
        <line
          x1={-1000}
          y1={0}
          x2={1000}
          y2={0}
          stroke="#c8c8c8"
          strokeWidth={1}
          vectorEffect="non-scaling-stroke"
          pointerEvents="none"
        />

        {/* Multi-table connectors — skip pairs that span the active
            area filter, otherwise the line dangles into hidden space. */}
        {connectors.map((c, i) => {
          const a = tableById.get(c.aId);
          const b = tableById.get(c.bId);
          if (!a || !b) return null;
          if (activeAreaId && (a.areaId !== activeAreaId || b.areaId !== activeAreaId)) {
            return null;
          }
          const ax = a.position.x + a.position.w / 2;
          const ay = a.position.y + a.position.h / 2;
          const bx = b.position.x + b.position.w / 2;
          const by = b.position.y + b.position.h / 2;
          return (
            <line
              key={i}
              x1={ax}
              y1={ay}
              x2={bx}
              y2={by}
              className="stroke-ash"
              strokeWidth={0.06}
              strokeDasharray="0.3 0.2"
              pointerEvents="none"
            />
          );
        })}

        {/* Tables */}
        {visibleTables.map((t) => {
          const state: FloorTableState = floorStateByTableId[t.id] ?? "empty";
          return (
            <TableShape
              key={t.id}
              table={t}
              state={state}
              selected={t.id === selectedTableId}
              editMode={editMode}
              svgRef={svgRef}
              onSelect={setSelectedTableId}
              onDragEnd={editMode ? handleDragEnd : undefined}
            />
          );
        })}
      </svg>

      <SidePanel
        venueId={venueId}
        date={date}
        table={selectedTable}
        booking={selectedTableId ? (activeByTableId[selectedTableId] ?? null) : null}
        upcoming={selectedTableId ? (upcomingByTableId[selectedTableId] ?? null) : null}
        editMode={editMode}
        onClose={() => setSelectedTableId(null)}
      />
    </div>
  );
}

function AreaPill({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={`rounded-sm px-2 py-1 text-xs font-medium transition ${
        active ? "bg-ink text-white" : "text-ash hover:bg-cloud"
      }`}
    >
      {label}
    </button>
  );
}

const LEGEND_STATES: FloorTableState[] = ["empty", "soon", "confirmed", "seated", "overdue"];

function Legend() {
  return (
    <div
      className="border-hairline absolute top-3 right-3 z-10 hidden items-center gap-2 rounded-md border bg-white px-2 py-1 text-[11px] md:flex"
      aria-label="Table colour legend"
    >
      {LEGEND_STATES.map((s) => (
        <span key={s} className="text-ash flex items-center gap-1">
          <span className={`inline-block h-2.5 w-2.5 rounded-sm ${FLOOR_STATE_DOT[s]}`} />
          {FLOOR_STATE_LABEL[s]}
        </span>
      ))}
    </div>
  );
}
