"use client";

import { ChevronLeft, ChevronRight } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  useTransition,
  type DragEvent,
  type ReactNode,
} from "react";

import { Button, IconButton, Input, cn } from "@/components/ui";
import type { BookingStatus } from "@/lib/bookings/state";

import { reassignFromTimeline } from "./actions";

// ===========================================================================
// Date navigator (unchanged from wave 1).
// ===========================================================================

export function TimelineDateNav({ venueId, date }: { venueId: string; date: string }) {
  const router = useRouter();
  const today = new Date().toISOString().slice(0, 10);
  const setDate = (d: string) => router.push(`/dashboard/venues/${venueId}/timeline?date=${d}`);
  const shift = (days: number) => {
    const d = new Date(`${date}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + days);
    setDate(d.toISOString().slice(0, 10));
  };
  return (
    <div className="flex items-center gap-1.5">
      <IconButton aria-label="Previous day" size="sm" onClick={() => shift(-1)}>
        <ChevronLeft className="h-3.5 w-3.5" aria-hidden />
      </IconButton>
      <Button
        variant="secondary"
        size="sm"
        onClick={() => setDate(today)}
        disabled={date === today}
      >
        Today
      </Button>
      <Input
        type="date"
        value={date}
        onChange={(e) => setDate(e.target.value)}
        size="sm"
        className="w-auto"
      />
      <IconButton aria-label="Next day" size="sm" onClick={() => shift(1)}>
        <ChevronRight className="h-3.5 w-3.5" aria-hidden />
      </IconButton>
    </div>
  );
}

// ===========================================================================
// Drag-to-reassign — per-row interactivity.
//
// HTML5 native drag (no @dnd-kit dep). The DragSourceContext lets each
// row know what area the active drag started in, so cross-area rows
// can grey-out instead of accepting an invalid drop.
//
// The block is the drag source; the row is the drop target. Dropping
// fires the reassignFromTimeline server action and router.refresh()
// to repaint with the new placement.
// ===========================================================================

type DragSource = {
  bookingId: string;
  fromTableId: string;
  fromAreaId: string;
} | null;

type DragCtx = {
  source: DragSource;
  setSource: (s: DragSource) => void;
};

const DragSourceContext = createContext<DragCtx | null>(null);

export function TimelineDragProvider({ children }: { children: ReactNode }) {
  const [source, setSource] = useState<DragSource>(null);
  const value = useMemo(() => ({ source, setSource }), [source]);
  return <DragSourceContext.Provider value={value}>{children}</DragSourceContext.Provider>;
}

function useDragSource(): DragCtx {
  const ctx = useContext(DragSourceContext);
  if (!ctx) throw new Error("useDragSource: missing TimelineDragProvider");
  return ctx;
}

// Status → block fill (mirror of the constants in page.tsx so the
// client component is self-contained).
const STATUS_FILL: Record<BookingStatus, string> = {
  requested: "bg-amber-100 border-amber-300 text-amber-900",
  confirmed: "bg-blue-100 border-blue-300 text-blue-900",
  seated: "bg-emerald-100 border-emerald-300 text-emerald-900",
  finished: "bg-neutral-100 border-neutral-300 text-neutral-700",
  cancelled: "bg-stone-100 border-stone-200 text-ash line-through",
  no_show: "bg-rose-100 border-rose-300 text-rose-900",
};

export type TimelineBookingBlock = {
  id: string;
  startCol: number; // 1-indexed grid column (already offset for the table-label col)
  span: number;
  status: BookingStatus;
  wallStart: string;
  guestFirstName: string;
  partySize: number;
  notes: string | null;
};

export function TimelineRow({
  venueId,
  date,
  tableId,
  tableLabel,
  areaId,
  totalSlots,
  bookings,
}: {
  venueId: string;
  date: string;
  tableId: string;
  tableLabel: string;
  areaId: string;
  totalSlots: number;
  bookings: TimelineBookingBlock[];
}) {
  const router = useRouter();
  const { source, setSource } = useDragSource();
  const [pending, startTransition] = useTransition();
  const [isOver, setOver] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const sameArea = source && source.fromAreaId === areaId;
  const sameTable = source?.fromTableId === tableId;
  const canDrop = Boolean(source) && sameArea && !sameTable;

  const onDragOver = useCallback(
    (e: DragEvent<HTMLDivElement>) => {
      if (!canDrop) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      setOver(true);
    },
    [canDrop],
  );

  const onDragLeave = useCallback(() => setOver(false), []);

  const onDrop = useCallback(
    (e: DragEvent<HTMLDivElement>) => {
      setOver(false);
      if (!canDrop || !source) return;
      e.preventDefault();
      const target = {
        venueId,
        bookingId: source.bookingId,
        fromTableId: source.fromTableId,
        toTableId: tableId,
      };
      setSource(null);
      setError(null);
      startTransition(async () => {
        const r = await reassignFromTimeline(target);
        if (!r.ok) {
          setError(reassignErrorMessage(r.reason));
          // Auto-clear the error after a few seconds — matches the
          // booking-list refund UX.
          setTimeout(() => setError(null), 4000);
          return;
        }
        router.refresh();
      });
    },
    [canDrop, source, venueId, tableId, setSource, router],
  );

  return (
    <div
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      className={cn(
        "grid border-b border-hairline transition-colors last:border-b-0",
        isOver && canDrop && "bg-coral/5",
        source && !canDrop && !sameTable && "opacity-60",
      )}
      style={{
        gridTemplateColumns: `120px repeat(${totalSlots}, minmax(0,1fr))`,
      }}
    >
      <div className="flex items-center gap-1.5 border-r border-hairline px-3 py-2 text-sm font-semibold text-ink">
        {tableLabel}
        {pending ? <span className="text-[10px] text-ash">Saving…</span> : null}
        {error ? <span className="text-[10px] text-rose">{error}</span> : null}
      </div>
      {Array.from({ length: totalSlots }, (_, i) => (
        <div
          key={i}
          className={
            i % 4 === 3 ? "border-r border-hairline" : "border-r border-hairline/40"
          }
        />
      ))}
      {bookings.map((b) => (
        <BookingBlock
          key={b.id}
          venueId={venueId}
          date={date}
          tableId={tableId}
          areaId={areaId}
          block={b}
        />
      ))}
    </div>
  );
}

function BookingBlock({
  venueId,
  date,
  tableId,
  areaId,
  block,
}: {
  venueId: string;
  date: string;
  tableId: string;
  areaId: string;
  block: TimelineBookingBlock;
}) {
  const { setSource } = useDragSource();
  // Cancelled bookings aren't draggable — they're already off the floor.
  const draggable = block.status !== "cancelled" && block.status !== "no_show" && block.status !== "finished";

  return (
    <Link
      href={`/dashboard/venues/${venueId}/bookings?date=${date}`}
      draggable={draggable}
      onDragStart={(e) => {
        if (!draggable) {
          e.preventDefault();
          return;
        }
        // dataTransfer payload is unused (we read everything from the
        // context) but setting *some* data is required for Firefox to
        // start a drag at all.
        e.dataTransfer.setData("text/plain", block.id);
        e.dataTransfer.effectAllowed = "move";
        setSource({
          bookingId: block.id,
          fromTableId: tableId,
          fromAreaId: areaId,
        });
      }}
      onDragEnd={() => setSource(null)}
      style={{
        gridColumn: `${block.startCol} / span ${block.span}`,
        gridRow: 1,
      }}
      className={cn(
        "m-0.5 flex flex-col justify-center overflow-hidden rounded-input border px-2 py-1 text-[11px] leading-tight transition",
        draggable && "cursor-grab active:cursor-grabbing hover:shadow-sm",
        STATUS_FILL[block.status],
      )}
    >
      <span className="truncate font-semibold">
        {block.wallStart} {block.guestFirstName}
      </span>
      <span className="truncate">
        party {block.partySize}
        {block.notes ? ` · ${block.notes}` : ""}
      </span>
    </Link>
  );
}

function reassignErrorMessage(reason: string): string {
  switch (reason) {
    case "wrong-area":
      return "Different area";
    case "slot-taken":
      return "Slot taken";
    case "not-found":
      return "Not found";
    default:
      return "Failed";
  }
}
