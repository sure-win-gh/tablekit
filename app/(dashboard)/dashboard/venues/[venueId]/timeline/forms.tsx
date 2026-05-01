"use client";

import { ChevronLeft, ChevronRight, X } from "lucide-react";
import { useRouter } from "next/navigation";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useOptimistic,
  useRef,
  useState,
  useTransition,
  type DragEvent,
  type MouseEvent,
  type ReactNode,
} from "react";

import { BookingDetailDialog } from "@/components/bookings/booking-detail-dialog";
import { Button, Field, IconButton, Input, Textarea, cn } from "@/components/ui";
import type { BookingDetailPayload, VenueTableForDetail } from "@/lib/bookings/detail";
import { type BookingStatus } from "@/lib/bookings/state";
import { STATUS_FILL } from "@/lib/bookings/status-style";

import {
  createFromTimeline,
  reassignFromTimeline,
  resizeFromTimeline,
  shiftFromTimeline,
} from "./actions";

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
// Horizontal scroller.
//
// Sizes the timeline so 4 hours fit in the visible area (16 × 15-min
// slots). Slot width = (container.inline - 120px label) / 16, via
// `cqw` so it adapts to any dashboard width without JS measurement.
// `max(50px, ...)` keeps slots readable on narrow screens at the cost
// of overflowing the 4-hour budget.
//
// On mount (and when the target changes) jumps scrollLeft so the
// current time sits ~30 min from the left edge — i.e. the first
// visible hour is "now − 30 min", the last is "now + 3h 30 min".
// ===========================================================================

export function TimelineScroller({
  scrollToMinutes,
  children,
}: {
  scrollToMinutes: number | null;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el || scrollToMinutes == null) return;
    // Read the actual rendered slot width from the DOM rather than
    // recomputing the cqw expression — keeps the scroll math in sync
    // if a future refactor changes the column template.
    const slotWidth = (el.clientWidth - 120) / 16;
    if (slotWidth <= 0) return;
    el.scrollLeft = Math.max(0, (scrollToMinutes / 15) * slotWidth);
  }, [scrollToMinutes]);

  return (
    <div
      ref={ref}
      className="rounded-card border-hairline overflow-x-auto border bg-white"
      style={{ containerType: "inline-size" }}
    >
      {children}
    </div>
  );
}

// ===========================================================================
// Timeline interaction state.
//
// Two interactions share one context:
//
//   1. Block drag-to-reassign (existing): pick up a booking block
//      and drop on another row in the same area.
//
//   2. Click-and-drag-to-create (new): mouse-down on an empty cell,
//      drag across slots, release to open the new-booking modal.
//
// Sharing one context lets each surface know about the other — e.g.
// the row dims if a different drag is active, the new-booking
// selection refuses to start if a block is being dragged.
// ===========================================================================

type DragSource = {
  bookingId: string;
  fromTableId: string;
  fromAreaId: string;
} | null;

export type NewBookingDraft = {
  tableId: string;
  tableLabel: string;
  areaId: string;
  // 0-indexed slot in the timeline window.
  startSlot: number;
  // Exclusive end slot. `null` = the operator clicked a single cell
  // (no drag) — the modal resolves the default duration from the
  // active service's turn time. Drag selections set this explicitly.
  endSlot: number | null;
};

// Selection uses anchor + current rather than start/end so the user
// can drag in either direction (forward or backward from where they
// clicked). The visual range is [min(anchor,current), max+1].
type Selection = {
  tableId: string;
  tableLabel: string;
  areaId: string;
  anchorSlot: number;
  currentSlot: number;
  active: boolean;
};

// Resize state — drag the right edge of a booking to extend or
// shorten its duration. anchorEndSlot is exclusive (the slot one
// past the booking's last occupied slot at resize-start);
// currentEndSlot tracks the cursor and is also exclusive.
export type Resize = {
  bookingId: string;
  tableId: string;
  startSlot: number; // booking's start slot, fixed
  anchorEndSlot: number; // exclusive
  currentEndSlot: number; // exclusive
};

type DragCtx = {
  source: DragSource;
  setSource: (s: DragSource) => void;

  selection: Selection | null;
  startSelection: (s: {
    tableId: string;
    tableLabel: string;
    areaId: string;
    anchorSlot: number;
  }) => void;
  extendSelection: (slot: number) => void;
  cancelSelection: () => void;
  commitSelection: () => void;

  resize: Resize | null;
  startResize: (s: {
    bookingId: string;
    tableId: string;
    startSlot: number;
    endSlot: number;
  }) => void;
  extendResize: (endSlot: number) => void;
  cancelResize: () => void;
  // Returns the final state for the action layer to act on.
  commitResize: () => Resize | null;

  modalDraft: NewBookingDraft | null;
  closeModal: () => void;

  detailBlock: TimelineDetailBlock | null;
  openDetail: (block: TimelineDetailBlock) => void;
  closeDetail: () => void;
};

const DragSourceContext = createContext<DragCtx | null>(null);

export function TimelineDragProvider({ children }: { children: ReactNode }) {
  const [source, setSource] = useState<DragSource>(null);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [modalDraft, setModalDraft] = useState<NewBookingDraft | null>(null);
  const [detailBlock, setDetailBlock] = useState<TimelineDetailBlock | null>(null);

  const startSelection = useCallback(
    (s: { tableId: string; tableLabel: string; areaId: string; anchorSlot: number }) => {
      setSelection({
        ...s,
        currentSlot: s.anchorSlot,
        active: true,
      });
    },
    [],
  );

  const extendSelection = useCallback((slot: number) => {
    setSelection((prev) => {
      if (!prev) return prev;
      // Skip the state update if nothing changed — avoids a ghost
      // re-render on every mousemove pixel within a single cell.
      if (prev.currentSlot === slot) return prev;
      return { ...prev, currentSlot: slot };
    });
  }, []);

  const cancelSelection = useCallback(() => setSelection(null), []);

  const commitSelection = useCallback(() => {
    setSelection((prev) => {
      if (!prev) return null;
      const lo = Math.min(prev.anchorSlot, prev.currentSlot);
      const hi = Math.max(prev.anchorSlot, prev.currentSlot);
      // Single-slot click → defer span to the modal so it can use the
      // active service's turn time. Drag honours the dragged range.
      const isClick = lo === hi;
      setModalDraft({
        tableId: prev.tableId,
        tableLabel: prev.tableLabel,
        areaId: prev.areaId,
        startSlot: lo,
        endSlot: isClick ? null : hi + 1,
      });
      return null;
    });
  }, []);

  const openDetail = useCallback((b: TimelineDetailBlock) => setDetailBlock(b), []);
  const closeDetail = useCallback(() => setDetailBlock(null), []);

  const closeModal = useCallback(() => setModalDraft(null), []);

  // Resize state.
  const [resize, setResize] = useState<Resize | null>(null);
  const startResize = useCallback(
    (s: { bookingId: string; tableId: string; startSlot: number; endSlot: number }) => {
      setResize({
        bookingId: s.bookingId,
        tableId: s.tableId,
        startSlot: s.startSlot,
        anchorEndSlot: s.endSlot,
        currentEndSlot: s.endSlot,
      });
    },
    [],
  );
  const extendResize = useCallback((endSlot: number) => {
    setResize((prev) => {
      if (!prev) return prev;
      if (prev.currentEndSlot === endSlot) return prev;
      return { ...prev, currentEndSlot: endSlot };
    });
  }, []);
  const cancelResize = useCallback(() => setResize(null), []);
  const commitResize = useCallback((): Resize | null => {
    let final: Resize | null = null;
    setResize((prev) => {
      final = prev;
      return null;
    });
    return final;
  }, []);

  const value = useMemo(
    () => ({
      source,
      setSource,
      selection,
      startSelection,
      extendSelection,
      cancelSelection,
      commitSelection,
      resize,
      startResize,
      extendResize,
      cancelResize,
      commitResize,
      modalDraft,
      closeModal,
      detailBlock,
      openDetail,
      closeDetail,
    }),
    [
      source,
      selection,
      startSelection,
      extendSelection,
      cancelSelection,
      commitSelection,
      resize,
      startResize,
      extendResize,
      cancelResize,
      commitResize,
      modalDraft,
      closeModal,
      detailBlock,
      openDetail,
      closeDetail,
    ],
  );

  return <DragSourceContext.Provider value={value}>{children}</DragSourceContext.Provider>;
}

function useTimelineCtx(): DragCtx {
  const ctx = useContext(DragSourceContext);
  if (!ctx) throw new Error("useTimelineCtx: missing TimelineDragProvider");
  return ctx;
}

export type TimelineBookingBlock = {
  id: string;
  startCol: number; // 1-indexed grid column (already offset for the table-label col)
  span: number;
  status: BookingStatus;
  wallStart: string;
  wallEnd: string;
  guestId: string;
  guestFirstName: string;
  partySize: number;
  notes: string | null;
  serviceName: string;
  // Payment-shape signals from the page query. Used by the detail
  // modal to render the refund button + no-show / card-on-file
  // badges. Mirrors the bookings list.
  refundable: boolean;
  cardHold: boolean;
  noShowOutcome: "captured" | "failed" | null;
};

// Detail-modal payload — a TimelineBookingBlock plus the row's
// identifying bits (the block doesn't carry table_id / label /
// area_id because the row that renders it owns those).
export type TimelineDetailBlock = TimelineBookingBlock & {
  tableId: string;
  tableLabel: string;
  areaId: string;
};

export function TimelineRow({
  venueId,
  date,
  tableId,
  tableLabel,
  areaId,
  areaName,
  totalSlots,
  windowStartHour,
  bookings,
}: {
  venueId: string;
  date: string;
  tableId: string;
  tableLabel: string;
  areaId: string;
  areaName: string;
  totalSlots: number;
  windowStartHour: number;
  bookings: TimelineBookingBlock[];
}) {
  const router = useRouter();
  const ctx = useTimelineCtx();
  const {
    source,
    setSource,
    selection,
    startSelection,
    extendSelection,
    commitSelection,
    cancelSelection,
    resize,
    extendResize,
    commitResize,
    cancelResize,
  } = ctx;
  const [pending, startTransition] = useTransition();
  const [isOver, setOver] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const rowRef = useRef<HTMLDivElement>(null);

  // Optimistic updates — when the operator drops a booking on a new
  // slot or releases a resize, paint the new position immediately
  // instead of waiting for the server round-trip + revalidatePath.
  // The transition awaits the server action + router.refresh; once
  // they settle, useOptimistic clears and the new server props take
  // over. On failure it auto-reverts.
  type OptimisticAction =
    | {
        type: "shift";
        bookingId: string;
        newStartCol: number;
        newWallStart: string;
        newWallEnd: string;
      }
    | {
        type: "resize";
        bookingId: string;
        newSpan: number;
        newWallEnd: string;
      };
  const [optimisticBookings, mutateOptimistic] = useOptimistic<
    TimelineBookingBlock[],
    OptimisticAction
  >(bookings, (state, action) =>
    state.map((b) => {
      if (b.id !== action.bookingId) return b;
      if (action.type === "shift") {
        return {
          ...b,
          startCol: action.newStartCol,
          wallStart: action.newWallStart,
          wallEnd: action.newWallEnd,
        };
      }
      // resize
      return { ...b, span: action.newSpan, wallEnd: action.newWallEnd };
    }),
  );

  const sameArea = source && source.fromAreaId === areaId;
  const sameTable = source?.fromTableId === tableId;
  // Drops accepted when:
  //   * same area + different table → reassignFromTimeline (existing)
  //   * same table → shiftFromTimeline (new — drag horizontally to
  //     change the booking's start time, preserving duration)
  const canDrop = Boolean(source) && (sameArea || sameTable === true);

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

  // Compute the slot under the cursor at drop time. Same math as the
  // selection useEffect — bounding-rect of the row minus the 120px
  // table-label column, divided by per-slot width.
  const slotFromClientX = useCallback(
    (clientX: number): number | null => {
      const node = rowRef.current;
      if (!node) return null;
      const rect = node.getBoundingClientRect();
      const xInGrid = clientX - rect.left - 120;
      const cellWidth = (rect.width - 120) / totalSlots;
      if (cellWidth <= 0) return null;
      const raw = Math.floor(xInGrid / cellWidth);
      return Math.max(0, Math.min(totalSlots - 1, raw));
    },
    [totalSlots],
  );

  const onDrop = useCallback(
    (e: DragEvent<HTMLDivElement>) => {
      setOver(false);
      if (!canDrop || !source) return;
      e.preventDefault();
      const isShift = source.fromTableId === tableId;
      const targetTableId = tableId;
      const dropClientX = e.clientX;
      setSource(null);
      setError(null);

      startTransition(async () => {
        if (isShift) {
          const slot = slotFromClientX(dropClientX);
          if (slot === null) return;
          const totalMin = windowStartHour * 60 + slot * 15;
          const wallStart = `${String(Math.floor(totalMin / 60)).padStart(2, "0")}:${String(
            totalMin % 60,
          ).padStart(2, "0")}`;

          // Paint the new position instantly. useOptimistic auto-
          // reverts when this transition settles unless router.refresh
          // brings back a server state that already reflects the move
          // — which it will on success.
          const dragged = optimisticBookings.find((b) => b.id === source.bookingId);
          if (dragged) {
            const newEndMin = totalMin + dragged.span * 15;
            const wallEnd = `${String(Math.floor(newEndMin / 60)).padStart(2, "0")}:${String(
              newEndMin % 60,
            ).padStart(2, "0")}`;
            mutateOptimistic({
              type: "shift",
              bookingId: source.bookingId,
              newStartCol: slot + 2,
              newWallStart: wallStart,
              newWallEnd: wallEnd,
            });
          }

          const r = await shiftFromTimeline({
            venueId,
            bookingId: source.bookingId,
            date,
            wallStart,
          });
          if (!r.ok) {
            setError(shiftErrorMessage(r.reason));
            setTimeout(() => setError(null), 4000);
            return;
          }
          router.refresh();
          return;
        }
        const r = await reassignFromTimeline({
          venueId,
          bookingId: source.bookingId,
          fromTableId: source.fromTableId,
          toTableId: targetTableId,
        });
        if (!r.ok) {
          setError(reassignErrorMessage(r.reason));
          setTimeout(() => setError(null), 4000);
          return;
        }
        router.refresh();
      });
    },
    [
      canDrop,
      source,
      venueId,
      tableId,
      date,
      windowStartHour,
      setSource,
      slotFromClientX,
      router,
      optimisticBookings,
      mutateOptimistic,
    ],
  );

  // Slot indices blocked by existing bookings on this row. Used to:
  // (a) refuse selection-start over a block;
  // (b) clamp the selection to not run through an occupied slot in
  //     either direction (forward or backward from the anchor).
  // Driven by optimisticBookings so a freshly-shifted block updates
  // the occupancy mask without waiting for the server.
  const occupied = useMemo(() => {
    const set = new Set<number>();
    for (const b of optimisticBookings) {
      const slotStart = b.startCol - 2;
      for (let i = 0; i < b.span; i++) set.add(slotStart + i);
    }
    return set;
  }, [optimisticBookings]);

  // Mousedown on a cell starts a selection anchored to that slot.
  // Block-drag-active short-circuits.
  const onCellMouseDown = useCallback(
    (e: MouseEvent<HTMLDivElement>, slot: number) => {
      if (e.button !== 0 || source) return;
      if (occupied.has(slot)) return;
      e.preventDefault();
      startSelection({ tableId, tableLabel, areaId, anchorSlot: slot });
    },
    [source, occupied, startSelection, tableId, tableLabel, areaId],
  );

  // Window-level mousemove + mouseup while a selection is active on
  // this row — gives smooth dragging in both directions and survives
  // the cursor leaving the row's own area. We compute the slot from
  // the mouse's clientX vs the row's bounding rect so there's no
  // dependency on per-cell mouseenter (which flickered when the
  // ghost overlapped the cells).
  const isMyDrag = selection?.active && selection.tableId === tableId;
  useEffect(() => {
    if (!isMyDrag) return;
    const node = rowRef.current;
    if (!node) return;

    // Walk outwards from the anchor to find the bounds the selection
    // can't cross — the next occupied slot in each direction.
    const anchor = selection!.anchorSlot;
    let leftCap = 0;
    for (let i = anchor - 1; i >= 0; i--) {
      if (occupied.has(i)) {
        leftCap = i + 1;
        break;
      }
    }
    let rightCap = totalSlots - 1;
    for (let i = anchor + 1; i < totalSlots; i++) {
      if (occupied.has(i)) {
        rightCap = i - 1;
        break;
      }
    }

    function slotAt(clientX: number): number {
      const rect = node!.getBoundingClientRect();
      const xInGrid = clientX - rect.left - 120; // 120px = label col
      const cellWidth = (rect.width - 120) / totalSlots;
      if (cellWidth <= 0) return anchor;
      const raw = Math.floor(xInGrid / cellWidth);
      return Math.max(leftCap, Math.min(rightCap, raw));
    }

    function onMove(e: globalThis.MouseEvent) {
      extendSelection(slotAt(e.clientX));
    }
    function onUp() {
      commitSelection();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") cancelSelection();
    }
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      window.removeEventListener("keydown", onKey);
    };
  }, [
    isMyDrag,
    selection,
    occupied,
    totalSlots,
    extendSelection,
    commitSelection,
    cancelSelection,
  ]);

  // Window-level mousemove + mouseup while a resize is active on
  // this row — extends/shortens the booking by tracking the cursor's
  // slot position. On mouseup, fires resizeFromTimeline + the
  // optimistic update.
  const isMyResize = resize?.tableId === tableId;
  useEffect(() => {
    if (!isMyResize || !resize) return;
    const node = rowRef.current;
    if (!node) return;

    // Cap the right edge: the next occupied slot belonging to a
    // different booking. The booking's own occupied slots are
    // allowed (we want to shrink into them) but the next neighbour's
    // start blocks further extension.
    const r = resize;
    let rightCap = totalSlots; // exclusive end
    for (let i = r.startSlot + 1; i < totalSlots; i++) {
      // skip the slots owned by this very booking
      const isOwnSlot = optimisticBookings.some(
        (b) => b.id === r.bookingId && i >= b.startCol - 2 && i < b.startCol - 2 + b.span,
      );
      if (!isOwnSlot && occupied.has(i)) {
        rightCap = i;
        break;
      }
    }
    // Minimum duration = 1 slot (15 min).
    const leftCap = r.startSlot + 1;

    function endSlotAt(clientX: number): number {
      const rect = node!.getBoundingClientRect();
      const xInGrid = clientX - rect.left - 120;
      const cellWidth = (rect.width - 120) / totalSlots;
      if (cellWidth <= 0) return r.currentEndSlot;
      // The exclusive end is the slot the cursor has just crossed
      // over the right edge of: ceil((x + cellWidth*0.5) / cellWidth)
      // gives a friendlier snap than floor + 1.
      const raw = Math.round(xInGrid / cellWidth);
      return Math.max(leftCap, Math.min(rightCap, raw));
    }

    function onMove(ev: globalThis.MouseEvent) {
      extendResize(endSlotAt(ev.clientX));
    }
    function onUp() {
      const final = commitResize();
      if (!final) return;
      const newSpan = final.currentEndSlot - final.startSlot;
      if (newSpan < 1) return;
      // No change → skip the round-trip.
      if (final.currentEndSlot === final.anchorEndSlot) return;
      const totalMin = windowStartHour * 60 + final.currentEndSlot * 15;
      const wallEnd = `${String(Math.floor(totalMin / 60)).padStart(2, "0")}:${String(
        totalMin % 60,
      ).padStart(2, "0")}`;
      setError(null);
      startTransition(async () => {
        mutateOptimistic({
          type: "resize",
          bookingId: final.bookingId,
          newSpan,
          newWallEnd: wallEnd,
        });
        const result = await resizeFromTimeline({
          venueId,
          bookingId: final.bookingId,
          date,
          wallEnd,
        });
        if (!result.ok) {
          setError(resizeErrorMessage(result.reason));
          setTimeout(() => setError(null), 4000);
          return;
        }
        router.refresh();
      });
    }
    function onKey(ev: KeyboardEvent) {
      if (ev.key === "Escape") cancelResize();
    }
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      window.removeEventListener("keydown", onKey);
    };
  }, [
    isMyResize,
    resize,
    occupied,
    totalSlots,
    optimisticBookings,
    extendResize,
    commitResize,
    cancelResize,
    mutateOptimistic,
    venueId,
    date,
    windowStartHour,
    router,
  ]);

  // Selection ghost — visible on this row only when the active
  // selection started here.
  const ghost =
    selection && selection.active && selection.tableId === tableId
      ? (() => {
          const lo = Math.min(selection.anchorSlot, selection.currentSlot);
          const hi = Math.max(selection.anchorSlot, selection.currentSlot);
          return {
            startCol: lo + 2,
            span: hi - lo + 1,
          };
        })()
      : null;

  // While our drag is active, suppress text-selection so the browser
  // doesn't paint a blue highlight under the ghost.
  const userSelectClass = isMyDrag ? "select-none" : "";

  return (
    <div
      ref={rowRef}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      className={cn(
        "border-hairline grid border-b transition-colors last:border-b-0",
        isOver && canDrop && "bg-coral/5",
        source && !canDrop && !sameTable && "opacity-60",
        // Crosshair on the row (not per-cell) so the cursor stays
        // steady when the ghost overlaps a cell — fixes the
        // flickering reported in wave 1.
        !source && "cursor-crosshair",
        userSelectClass,
      )}
      style={{
        gridTemplateColumns: `120px repeat(${totalSlots}, max(50px, calc((100cqw - 120px) / 16)))`,
      }}
    >
      <div className="border-hairline text-ink sticky left-0 z-30 flex flex-col justify-center border-r bg-white px-3 py-1.5">
        <span className="text-ash truncate text-[10px] font-semibold tracking-wider uppercase">
          {areaName}
        </span>
        <span className="flex items-center gap-1.5 text-sm leading-tight font-semibold">
          <span className="truncate">{tableLabel}</span>
          {pending ? <span className="text-ash text-[10px] font-normal">Saving…</span> : null}
          {error ? <span className="text-rose text-[10px] font-normal">{error}</span> : null}
        </span>
      </div>
      {Array.from({ length: totalSlots }, (_, i) => (
        <div
          key={i}
          // Pin every cell to its own grid column. Without this,
          // auto-placement shoves cells past explicitly-positioned
          // booking blocks — so on a row with a booking at cols 3–5,
          // cells 3/4/5 quietly relocate to cols 6/7/8 and clicks
          // on what looked like slot 7 actually fire onMouseDown on
          // cell-4, anchoring the selection in the wrong place.
          // +2 because col 1 is the table-label.
          style={{ gridColumn: i + 2, gridRow: 1 }}
          onMouseDown={(e) => onCellMouseDown(e, i)}
          className={cn(
            i % 4 === 3 ? "border-hairline border-r" : "border-hairline/40 border-r",
            occupied.has(i) && "cursor-default",
          )}
        />
      ))}
      {ghost ? (
        <div
          aria-hidden
          style={{
            gridColumn: `${ghost.startCol} / span ${ghost.span}`,
            gridRow: 1,
          }}
          className="rounded-input border-coral/60 bg-coral/10 pointer-events-none m-0.5 border"
        />
      ) : null}
      {optimisticBookings.map((b) => {
        // Override the rendered span if this booking is being
        // resized — purely visual while the cursor moves;
        // useOptimistic takes the final value on commit.
        const isResizing = resize?.bookingId === b.id;
        const renderedBlock = isResizing
          ? { ...b, span: Math.max(1, resize!.currentEndSlot - (b.startCol - 2)) }
          : b;
        return (
          <BookingBlock
            key={b.id}
            tableId={tableId}
            tableLabel={tableLabel}
            areaId={areaId}
            block={renderedBlock}
          />
        );
      })}
    </div>
  );
}

function BookingBlock({
  tableId,
  tableLabel,
  areaId,
  block,
}: {
  tableId: string;
  tableLabel: string;
  areaId: string;
  block: TimelineBookingBlock;
}) {
  const { setSource, openDetail, startResize, resize } = useTimelineCtx();
  // Cancelled / no_show / finished blocks aren't draggable — they're
  // already off the floor. Same gating for resize.
  const interactive =
    block.status !== "cancelled" && block.status !== "no_show" && block.status !== "finished";

  // Suppress the click that would otherwise open the detail modal
  // immediately after a resize ends (mousedown-on-handle ... mouseup
  // ... bubbles a click on the parent button if mouseup landed back
  // on it). We snapshot the booking id when the user starts resizing
  // and ignore the next click for that block.
  const blockerRef = useRef<{ id: string; until: number } | null>(null);

  return (
    <button
      type="button"
      draggable={interactive}
      onClick={() => {
        const blocker = blockerRef.current;
        if (blocker && blocker.id === block.id && Date.now() < blocker.until) {
          return;
        }
        openDetail({ ...block, tableId, tableLabel, areaId });
      }}
      onDragStart={(e) => {
        if (!interactive || resize) {
          e.preventDefault();
          return;
        }
        e.dataTransfer.setData("text/plain", block.id);
        e.dataTransfer.effectAllowed = "move";
        setSource({
          bookingId: block.id,
          fromTableId: tableId,
          fromAreaId: areaId,
        });
      }}
      onDragEnd={() => setSource(null)}
      onMouseDown={(e) => {
        // Stop the row's selection-start from firing when the user
        // mouses down on a block.
        e.stopPropagation();
      }}
      style={{
        gridColumn: `${block.startCol} / span ${block.span}`,
        gridRow: 1,
      }}
      className={cn(
        "rounded-input relative m-0.5 flex flex-col justify-center overflow-hidden border px-2 py-1 text-left text-[11px] leading-tight transition",
        "focus-visible:ring-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-1",
        interactive
          ? "cursor-grab hover:shadow-sm active:cursor-grabbing"
          : "cursor-pointer hover:shadow-sm",
        STATUS_FILL[block.status],
      )}
    >
      <span className="truncate font-semibold">
        {block.wallStart}–{block.wallEnd} {block.guestFirstName}
      </span>
      <span className="truncate">
        party {block.partySize}
        {block.notes ? ` · ${block.notes}` : ""}
      </span>
      {interactive ? (
        <span
          aria-label="Resize booking"
          role="separator"
          draggable={false}
          onMouseDown={(e) => {
            // Start a resize, not a drag-to-shift. stopPropagation
            // keeps the row from starting a selection; preventDefault
            // suppresses any incidental text selection.
            e.stopPropagation();
            e.preventDefault();
            blockerRef.current = { id: block.id, until: Date.now() + 500 };
            const startSlot = block.startCol - 2;
            const endSlot = startSlot + block.span; // exclusive
            startResize({ bookingId: block.id, tableId, startSlot, endSlot });
          }}
          onDragStart={(e) => {
            // Belt-and-braces: if the browser tries to start an HTML5
            // drag on the handle anyway, kill it.
            e.preventDefault();
            e.stopPropagation();
          }}
          className="hover:bg-ink/10 absolute inset-y-0 right-0 w-1.5 cursor-ew-resize bg-transparent"
        />
      ) : null}
    </button>
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

function resizeErrorMessage(reason: string): string {
  switch (reason) {
    case "slot-taken":
      return "Slot taken";
    case "terminal-status":
      return "Already closed";
    case "non-positive-duration":
      return "End must be after start";
    case "not-found":
    case "venue-not-found":
      return "Not found";
    default:
      return "Failed";
  }
}

function shiftErrorMessage(reason: string): string {
  switch (reason) {
    case "slot-taken":
      return "Time taken";
    case "terminal-status":
      return "Already closed";
    case "not-found":
    case "venue-not-found":
      return "Not found";
    default:
      return "Failed";
  }
}

// ===========================================================================
// New-booking modal — opens after a click-and-drag selection commits.
//
// Wave 1: scaffold only — shows the resolved time + table + service,
// has a "Continue to /bookings/new" link as the fallback, plus
// Close. Wave 2 wires an inline form + submit.
// ===========================================================================

export type TimelineService = {
  id: string;
  name: string;
  // jsonb: { days: string[], start: "HH:MM", end: "HH:MM" }. Trusted
  // shape — already validated at the server-action boundary.
  schedule: unknown;
  turnMinutes: number;
};

export function NewBookingModal({
  venueId,
  date,
  windowStartHour,
  services,
}: {
  venueId: string;
  date: string;
  windowStartHour: number;
  services: TimelineService[];
}) {
  const { modalDraft, closeModal } = useTimelineCtx();

  // Esc to close.
  useEffect(() => {
    if (!modalDraft) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeModal();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [modalDraft, closeModal]);

  if (!modalDraft) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="New booking"
      onClick={closeModal}
      className="bg-ink/40 fixed inset-0 z-50 flex items-center justify-center p-4"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="rounded-card border-hairline shadow-panel w-full max-w-md border bg-white"
      >
        {/* Keyed by the draft so transient form state (party size,
            error message) resets cleanly when a new selection opens
            the modal. Avoids the react-hooks/set-state-in-effect
            rule that fires when we'd otherwise reset state in a
            useEffect on draft change. */}
        <ModalBody
          key={`${modalDraft.tableId}:${modalDraft.startSlot}:${modalDraft.endSlot}`}
          venueId={venueId}
          date={date}
          windowStartHour={windowStartHour}
          services={services}
          draft={modalDraft}
        />
      </div>
    </div>
  );
}

function ModalBody({
  venueId,
  date,
  windowStartHour,
  services,
  draft,
}: {
  venueId: string;
  date: string;
  windowStartHour: number;
  services: TimelineService[];
  draft: NewBookingDraft;
}) {
  const router = useRouter();
  const { closeModal } = useTimelineCtx();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [partySize, setPartySize] = useState(2);

  const startMin = windowStartHour * 60 + draft.startSlot * 15;
  const service = pickService(services, startMin);
  // Click without a drag → use the active service's turn time so the
  // host doesn't have to pick a duration. Falls back to 30 min only
  // when no service is open (the modal warns about that case below).
  const fallbackSpan = service ? Math.max(1, Math.round(service.turnMinutes / 15)) : 2;
  const endSlot = draft.endSlot ?? draft.startSlot + fallbackSpan;
  const endMin = windowStartHour * 60 + endSlot * 15;
  const wallStart = formatHHMM(startMin);
  const wallEnd = formatHHMM(endMin);

  function onSubmit(e: ReactFormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!service) return;
    const form = new FormData(e.currentTarget);
    const payload = {
      venueId,
      serviceId: service.id,
      date,
      wallStart,
      partySize,
      preferredTableId: draft.tableId,
      notes: (form.get("notes") as string) || undefined,
      guest: {
        firstName: form.get("firstName"),
        lastName: form.get("lastName") ?? "",
        email: form.get("email"),
        phone: (form.get("phone") as string) || undefined,
      },
    };
    setError(null);
    startTransition(async () => {
      const r = await createFromTimeline(payload);
      if (!r.ok) {
        setError(createErrorMessage(r));
        return;
      }
      if (r.landedOn === "elsewhere") {
        setError(
          "Booked, but availability put it on a different table. Drag-reassign on the timeline to move it.",
        );
        setTimeout(() => {
          closeModal();
          router.refresh();
        }, 3000);
        return;
      }
      closeModal();
      router.refresh();
    });
  }

  return (
    <>
      <header className="border-hairline flex items-start justify-between gap-2 border-b px-5 py-4">
        <div>
          <h3 className="text-ink text-base font-bold tracking-tight">New booking</h3>
          <p className="text-ash mt-0.5 text-xs">
            {wallStart}–{wallEnd} · {draft.tableLabel}
            {service ? ` · ${service.name}` : ""}
          </p>
        </div>
        <button
          type="button"
          onClick={closeModal}
          aria-label="Close"
          className="text-ash hover:bg-cloud hover:text-ink -mt-1 -mr-1 inline-flex h-7 w-7 items-center justify-center rounded-full transition"
        >
          <X className="h-4 w-4" aria-hidden />
        </button>
      </header>

      {!service ? (
        <div className="px-5 py-4">
          <p className="rounded-card border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
            No service is open at {wallStart}. Pick a different time, or set up a service that
            covers it.
          </p>
        </div>
      ) : (
        <form onSubmit={onSubmit} className="flex flex-col gap-4 px-5 py-4">
          <Field label="Party size" htmlFor="nbm-party">
            <Input
              id="nbm-party"
              type="number"
              min={1}
              max={20}
              value={partySize}
              onChange={(e) => setPartySize(Math.max(1, Math.min(20, Number(e.target.value))))}
              size="sm"
              className="w-24"
            />
          </Field>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="First name" htmlFor="nbm-fn">
              <Input id="nbm-fn" name="firstName" required autoComplete="given-name" />
            </Field>
            <Field label="Last name" htmlFor="nbm-ln" optional>
              <Input id="nbm-ln" name="lastName" autoComplete="family-name" />
            </Field>
            <Field label="Email" htmlFor="nbm-email">
              <Input id="nbm-email" name="email" type="email" required autoComplete="email" />
            </Field>
            <Field label="Phone" htmlFor="nbm-phone" optional>
              <Input id="nbm-phone" name="phone" type="tel" autoComplete="tel" />
            </Field>
          </div>

          <Field label="Notes" htmlFor="nbm-notes" optional>
            <Textarea id="nbm-notes" name="notes" rows={2} maxLength={500} />
          </Field>

          {error ? <p className="text-rose text-xs">{error}</p> : null}

          <footer className="border-hairline -mx-5 mt-2 -mb-4 flex items-center justify-end gap-2 border-t px-5 py-3">
            <Button type="button" variant="secondary" size="sm" onClick={closeModal}>
              Cancel
            </Button>
            <Button type="submit" size="sm" disabled={pending}>
              {pending ? "Creating…" : "Create booking"}
            </Button>
          </footer>
        </form>
      )}
    </>
  );
}

// ===========================================================================
// Booking detail modal — opened by clicking a booking block.
//
// Read-only summary today (time, table, party, status, notes,
// service). Action buttons (status transitions, refund) defer to the
// /bookings list page via a "Manage" deep link — embedding them here
// would require fetching payment + assignment shape which the timeline
// query intentionally skips.
// ===========================================================================

// Re-exported for the timeline page so it can keep importing this
// type by name. The dialog itself lives in components/bookings/.
export type TimelineVenueTable = VenueTableForDetail;

// Thin wrapper that bridges the timeline's drag-context (which owns
// `detailBlock`) to the shared <BookingDetailDialog>. The dialog is
// view-agnostic — it only needs the booking payload + a way to close.
export function BookingDetailModal({
  venueId,
  date,
  allVenueTables,
}: {
  venueId: string;
  date: string;
  allVenueTables: VenueTableForDetail[];
}) {
  const { detailBlock, closeDetail } = useTimelineCtx();
  if (!detailBlock) return null;
  const booking: BookingDetailPayload = {
    id: detailBlock.id,
    status: detailBlock.status,
    wallStart: detailBlock.wallStart,
    wallEnd: detailBlock.wallEnd,
    durationMinutes: detailBlock.span * 15, // 15-min grid → minutes
    guestId: detailBlock.guestId,
    guestFirstName: detailBlock.guestFirstName,
    partySize: detailBlock.partySize,
    notes: detailBlock.notes,
    serviceName: detailBlock.serviceName,
    tableId: detailBlock.tableId,
    tableLabel: detailBlock.tableLabel,
    areaId: detailBlock.areaId,
    refundable: detailBlock.refundable,
    cardHold: detailBlock.cardHold,
    noShowOutcome: detailBlock.noShowOutcome,
  };
  return (
    <BookingDetailDialog
      venueId={venueId}
      date={date}
      booking={booking}
      allVenueTables={allVenueTables}
      onClose={closeDetail}
    />
  );
}

function createErrorMessage(r: { reason: string; message?: string | undefined }): string {
  switch (r.reason) {
    case "slot-taken":
      return "Someone else just took that slot — try another time or table.";
    case "no-availability":
      return "That slot is no longer available.";
    case "venue-not-found":
      return "Venue not found.";
    case "guest-invalid":
      return r.message ? `Guest details: ${r.message}` : "Check the guest details.";
    case "invalid-input":
      return r.message ? `Check: ${r.message}` : "Check the form.";
    case "deposit-failed":
      return "Unexpected payment error — try again.";
    default:
      return "Couldn't create the booking. Try again.";
  }
}

// React's FormEvent type without importing React.FormEvent into the
// existing `react` import set above.
type ReactFormEvent<T> = import("react").FormEvent<T>;

function formatHHMM(totalMinutes: number): string {
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function pickService(services: TimelineService[], startMin: number): TimelineService | null {
  for (const s of services) {
    const sched = s.schedule as { start?: string; end?: string } | null;
    if (!sched?.start || !sched?.end) continue;
    const sMin = parseHHMM(sched.start);
    const eMin = parseHHMM(sched.end);
    if (startMin >= sMin && startMin < eMin) return s;
  }
  return null;
}

function parseHHMM(s: string): number {
  const [hh = "0", mm = "0"] = s.split(":");
  return Number(hh) * 60 + Number(mm);
}
