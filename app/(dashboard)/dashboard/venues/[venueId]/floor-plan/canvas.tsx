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

import { saveTablePosition } from "./actions";
import { NewAreaForm, NewTableForm } from "./forms";
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
    return { x: 0, y: 0, width: 20, height: 14 };
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
}: Props) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [editMode, setEditMode] = useState(false);
  const [selectedTableId, setSelectedTableId] = useState<string | null>(null);

  // Optimistic positions — drag-end updates this immediately, then the
  // server action revalidates and the RSC re-renders with the persisted
  // values. The reducer key is `tableId` so multiple drags compose.
  const [optimisticTables, applyOptimistic] = useOptimistic(
    tables,
    (current: CanvasTable[], next: { id: string; position: TablePosition }) =>
      current.map((t) => (t.id === next.id ? { ...t, position: next.position } : t)),
  );

  const [, startTransition] = useTransition();
  const [, formAction] = useActionState(saveTablePosition, idle);

  const initialViewBox = useMemo(() => fitViewBox(tables), [tables]);
  const [viewBox, setViewBox] = useState(initialViewBox);

  const fitToViewport = useCallback(() => {
    setViewBox(fitViewBox(tables));
  }, [tables]);

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
      {/* Toolbar */}
      <div className="absolute top-3 left-3 z-10 flex items-center gap-2">
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
          <Button
            variant={editMode ? "primary" : "secondary"}
            size="sm"
            onClick={() => setEditMode((m) => !m)}
          >
            <Pencil className="h-3.5 w-3.5" aria-hidden />
            {editMode ? "Editing" : "Edit"}
          </Button>
        ) : null}
      </div>

      {editMode ? (
        <div className="absolute bottom-3 left-3 z-10 flex max-w-[60%] flex-col gap-2">
          <NewAreaForm venueId={venueId} />
          {areas.map((a) => (
            <details
              key={a.id}
              className="border-hairline rounded-md border bg-white px-3 py-2 text-xs"
            >
              <summary className="text-ink cursor-pointer font-medium">
                Add table to {a.name}
              </summary>
              <div className="mt-2">
                <NewTableForm areaId={a.id} />
              </div>
            </details>
          ))}
        </div>
      ) : null}

      <svg
        ref={svgRef}
        className={`h-full w-full ${editMode ? "bg-cloud" : "bg-white"}`}
        viewBox={`${viewBox.x} ${viewBox.y} ${viewBox.width} ${viewBox.height}`}
        onWheel={onWheel}
      >
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

        {/* Multi-table connectors */}
        {connectors.map((c, i) => {
          const a = tableById.get(c.aId);
          const b = tableById.get(c.bId);
          if (!a || !b) return null;
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
        {optimisticTables.map((t) => {
          const active = activeByTableId[t.id] ?? null;
          const upcoming = !active && upcomingByTableId[t.id] ? upcomingByTableId[t.id] : null;
          return (
            <TableShape
              key={t.id}
              table={t}
              status={active ? active.status : null}
              upcoming={Boolean(upcoming)}
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
