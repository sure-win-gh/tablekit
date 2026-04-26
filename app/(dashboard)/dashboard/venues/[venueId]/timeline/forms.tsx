"use client";

import { ChevronLeft, ChevronRight, X } from "lucide-react";
import { useRouter } from "next/navigation";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
  type DragEvent,
  type MouseEvent,
  type ReactNode,
} from "react";

import { Button, Field, IconButton, Input, Textarea, cn } from "@/components/ui";
import type { BookingStatus } from "@/lib/bookings/state";

import { createFromTimeline, reassignFromTimeline } from "./actions";

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
  endSlot: number; // exclusive
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

type DragCtx = {
  source: DragSource;
  setSource: (s: DragSource) => void;

  selection: Selection | null;
  startSelection: (s: { tableId: string; tableLabel: string; areaId: string; anchorSlot: number }) => void;
  extendSelection: (slot: number) => void;
  cancelSelection: () => void;
  commitSelection: () => void;

  modalDraft: NewBookingDraft | null;
  closeModal: () => void;

  detailBlock: BookingDetailPayload | null;
  openDetail: (block: BookingDetailPayload) => void;
  closeDetail: () => void;
};

const DragSourceContext = createContext<DragCtx | null>(null);

export function TimelineDragProvider({ children }: { children: ReactNode }) {
  const [source, setSource] = useState<DragSource>(null);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [modalDraft, setModalDraft] = useState<NewBookingDraft | null>(null);
  const [detailBlock, setDetailBlock] = useState<BookingDetailPayload | null>(null);

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
      // Single-slot click → snap to 30 min default; otherwise honour
      // the dragged span.
      const span = hi === lo ? 2 : hi - lo + 1;
      setModalDraft({
        tableId: prev.tableId,
        tableLabel: prev.tableLabel,
        areaId: prev.areaId,
        startSlot: lo,
        endSlot: lo + span,
      });
      return null;
    });
  }, []);

  const openDetail = useCallback((b: BookingDetailPayload) => setDetailBlock(b), []);
  const closeDetail = useCallback(() => setDetailBlock(null), []);

  const closeModal = useCallback(() => setModalDraft(null), []);

  const value = useMemo(
    () => ({
      source,
      setSource,
      selection,
      startSelection,
      extendSelection,
      cancelSelection,
      commitSelection,
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
  wallEnd: string;
  guestFirstName: string;
  partySize: number;
  notes: string | null;
  serviceName: string;
};

// Detail-modal payload — derived from a TimelineBookingBlock + the
// row's table label (the block doesn't carry it because it's owned by
// the row that renders it).
export type BookingDetailPayload = TimelineBookingBlock & {
  tableLabel: string;
  areaId: string;
};

export function TimelineRow({
  venueId,
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
  const ctx = useTimelineCtx();
  const {
    source,
    setSource,
    selection,
    startSelection,
    extendSelection,
    commitSelection,
    cancelSelection,
  } = ctx;
  const [pending, startTransition] = useTransition();
  const [isOver, setOver] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const rowRef = useRef<HTMLDivElement>(null);

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
          setTimeout(() => setError(null), 4000);
          return;
        }
        router.refresh();
      });
    },
    [canDrop, source, venueId, tableId, setSource, router],
  );

  // Slot indices blocked by existing bookings on this row. Used to:
  // (a) refuse selection-start over a block;
  // (b) clamp the selection to not run through an occupied slot in
  //     either direction (forward or backward from the anchor).
  const occupied = useMemo(() => {
    const set = new Set<number>();
    for (const b of bookings) {
      // block.startCol is 1-indexed grid col; subtract the +1 offset
      // for the label, and another +1 to re-zero into slot space.
      const slotStart = b.startCol - 2;
      for (let i = 0; i < b.span; i++) set.add(slotStart + i);
    }
    return set;
  }, [bookings]);

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
  }, [isMyDrag, selection, occupied, totalSlots, extendSelection, commitSelection, cancelSelection]);

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
        "grid border-b border-hairline transition-colors last:border-b-0",
        isOver && canDrop && "bg-coral/5",
        source && !canDrop && !sameTable && "opacity-60",
        // Crosshair on the row (not per-cell) so the cursor stays
        // steady when the ghost overlaps a cell — fixes the
        // flickering reported in wave 1.
        !source && "cursor-crosshair",
        userSelectClass,
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
            i % 4 === 3 ? "border-r border-hairline" : "border-r border-hairline/40",
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
          className="pointer-events-none m-0.5 rounded-input border border-coral/60 bg-coral/10"
        />
      ) : null}
      {bookings.map((b) => (
        <BookingBlock
          key={b.id}
          tableId={tableId}
          tableLabel={tableLabel}
          areaId={areaId}
          block={b}
        />
      ))}
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
  const { setSource, openDetail } = useTimelineCtx();
  // Cancelled / no_show / finished blocks aren't draggable — they're
  // already off the floor.
  const draggable =
    block.status !== "cancelled" && block.status !== "no_show" && block.status !== "finished";

  return (
    <button
      type="button"
      draggable={draggable}
      onClick={() => openDetail({ ...block, tableLabel, areaId })}
      onDragStart={(e) => {
        if (!draggable) {
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
        // mouses down on a block. Without this the row sees the
        // mousedown on its background (the click is on the block,
        // but bubbles up).
        e.stopPropagation();
      }}
      style={{
        gridColumn: `${block.startCol} / span ${block.span}`,
        gridRow: 1,
      }}
      className={cn(
        "m-0.5 flex flex-col justify-center overflow-hidden rounded-input border px-2 py-1 text-left text-[11px] leading-tight transition",
        "focus:outline-none focus-visible:ring-2 focus-visible:ring-ink focus-visible:ring-offset-1",
        draggable ? "cursor-grab active:cursor-grabbing hover:shadow-sm" : "cursor-pointer hover:shadow-sm",
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
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 p-4"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-md rounded-card border border-hairline bg-white shadow-panel"
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
  const endMin = windowStartHour * 60 + draft.endSlot * 15;
  const wallStart = formatHHMM(startMin);
  const wallEnd = formatHHMM(endMin);
  const service = pickService(services, startMin);

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
      <header className="flex items-start justify-between gap-2 border-b border-hairline px-5 py-4">
        <div>
          <h3 className="text-base font-bold tracking-tight text-ink">New booking</h3>
          <p className="mt-0.5 text-xs text-ash">
            {wallStart}–{wallEnd} · {draft.tableLabel}
            {service ? ` · ${service.name}` : ""}
          </p>
        </div>
        <button
          type="button"
          onClick={closeModal}
          aria-label="Close"
          className="-mr-1 -mt-1 inline-flex h-7 w-7 items-center justify-center rounded-full text-ash transition hover:bg-cloud hover:text-ink"
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

          {error ? <p className="text-xs text-rose">{error}</p> : null}

          <footer className="-mx-5 -mb-4 mt-2 flex items-center justify-end gap-2 border-t border-hairline px-5 py-3">
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

const STATUS_LABEL: Record<BookingStatus, string> = {
  requested: "Requested",
  confirmed: "Confirmed",
  seated: "Seated",
  finished: "Finished",
  cancelled: "Cancelled",
  no_show: "No-show",
};

export function BookingDetailModal({ venueId, date }: { venueId: string; date: string }) {
  const { detailBlock, closeDetail } = useTimelineCtx();

  useEffect(() => {
    if (!detailBlock) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeDetail();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [detailBlock, closeDetail]);

  if (!detailBlock) return null;

  const manageHref = `/dashboard/venues/${venueId}/bookings?date=${date}`;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Booking detail"
      onClick={closeDetail}
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 p-4"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-md rounded-card border border-hairline bg-white shadow-panel"
      >
        <header className="flex items-start justify-between gap-2 border-b border-hairline px-5 py-4">
          <div>
            <h3 className="text-base font-bold tracking-tight text-ink">
              {detailBlock.guestFirstName}
            </h3>
            <p className="mt-0.5 text-xs text-ash">
              {detailBlock.wallStart}–{detailBlock.wallEnd} · {detailBlock.tableLabel} ·{" "}
              {detailBlock.serviceName}
            </p>
          </div>
          <button
            type="button"
            onClick={closeDetail}
            aria-label="Close"
            className="-mr-1 -mt-1 inline-flex h-7 w-7 items-center justify-center rounded-full text-ash transition hover:bg-cloud hover:text-ink"
          >
            <X className="h-4 w-4" aria-hidden />
          </button>
        </header>

        <div className="flex flex-col gap-3 px-5 py-4 text-sm text-charcoal">
          <DetailRow label="Status">
            <span
              className={cn(
                "inline-flex items-center rounded-pill border px-2 py-0.5 text-[11px] font-semibold",
                STATUS_FILL[detailBlock.status],
              )}
            >
              {STATUS_LABEL[detailBlock.status]}
            </span>
          </DetailRow>
          <DetailRow label="Party size">
            <span className="font-mono tabular-nums">{detailBlock.partySize}</span>
          </DetailRow>
          {detailBlock.notes ? (
            <DetailRow label="Notes">
              <span className="whitespace-pre-line">{detailBlock.notes}</span>
            </DetailRow>
          ) : null}
        </div>

        <footer className="flex items-center justify-end gap-2 border-t border-hairline px-5 py-3">
          <Button variant="secondary" size="sm" onClick={closeDetail}>
            Close
          </Button>
          <a href={manageHref}>
            <Button size="sm">Manage</Button>
          </a>
        </footer>
      </div>
    </div>
  );
}

function DetailRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="text-[11px] font-semibold uppercase tracking-wider text-ash">{label}</span>
      <span className="text-sm text-ink">{children}</span>
    </div>
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
