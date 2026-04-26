"use client";

import { ChevronLeft, ChevronRight, X } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
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

type Selection = NewBookingDraft & { active: boolean };

type DragCtx = {
  source: DragSource;
  setSource: (s: DragSource) => void;

  selection: Selection | null;
  startSelection: (s: Omit<NewBookingDraft, "endSlot">) => void;
  extendSelection: (endSlot: number) => void;
  cancelSelection: () => void;
  commitSelection: () => void;

  modalDraft: NewBookingDraft | null;
  closeModal: () => void;
};

const DragSourceContext = createContext<DragCtx | null>(null);

export function TimelineDragProvider({ children }: { children: ReactNode }) {
  const [source, setSource] = useState<DragSource>(null);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [modalDraft, setModalDraft] = useState<NewBookingDraft | null>(null);

  const startSelection = useCallback((s: Omit<NewBookingDraft, "endSlot">) => {
    setSelection({ ...s, endSlot: s.startSlot + 1, active: true });
  }, []);

  const extendSelection = useCallback((endSlot: number) => {
    setSelection((prev) => (prev ? { ...prev, endSlot } : prev));
  }, []);

  const cancelSelection = useCallback(() => setSelection(null), []);

  const commitSelection = useCallback(() => {
    setSelection((prev) => {
      if (!prev) return null;
      const lo = Math.min(prev.startSlot, prev.endSlot - 1);
      const hi = Math.max(prev.startSlot + 1, prev.endSlot);
      // Click-without-drag (single slot) → snap to 30 min default.
      const span = hi - lo === 1 ? 2 : hi - lo;
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
  const ctx = useTimelineCtx();
  const { source, setSource, selection, startSelection, extendSelection, commitSelection } = ctx;
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
          setTimeout(() => setError(null), 4000);
          return;
        }
        router.refresh();
      });
    },
    [canDrop, source, venueId, tableId, setSource, router],
  );

  // Slot indices that are blocked by an existing booking on this
  // row. Used to (a) refuse selection-start over a block, (b) clamp
  // the selection's end so it doesn't run through one.
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

  const onCellMouseDown = useCallback(
    (e: MouseEvent<HTMLDivElement>, slot: number) => {
      // Left button only; ignore if a block drag is active.
      if (e.button !== 0 || source) return;
      if (occupied.has(slot)) return;
      e.preventDefault();
      startSelection({ tableId, tableLabel, areaId, startSlot: slot });
    },
    [source, occupied, startSelection, tableId, tableLabel, areaId],
  );

  const onCellMouseEnter = useCallback(
    (slot: number) => {
      if (!selection || !selection.active) return;
      if (selection.tableId !== tableId) return;
      // Clamp the selection end so it doesn't extend through an
      // occupied slot. Find the nearest occupied slot at or after
      // the start; cap there.
      let cap = totalSlots;
      for (let i = selection.startSlot + 1; i < totalSlots; i++) {
        if (occupied.has(i)) {
          cap = i;
          break;
        }
      }
      const target = Math.min(slot + 1, cap);
      extendSelection(target);
    },
    [selection, tableId, totalSlots, occupied, extendSelection],
  );

  // Render the selection ghost on this row only when the active
  // selection belongs to this table.
  const ghost =
    selection && selection.active && selection.tableId === tableId
      ? {
          startCol: Math.min(selection.startSlot, selection.endSlot - 1) + 2,
          span: Math.max(1, Math.abs(selection.endSlot - selection.startSlot)),
        }
      : null;

  return (
    <div
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      onMouseUp={() => {
        if (selection?.active) commitSelection();
      }}
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
          onMouseDown={(e) => onCellMouseDown(e, i)}
          onMouseEnter={() => onCellMouseEnter(i)}
          className={cn(
            i % 4 === 3 ? "border-r border-hairline" : "border-r border-hairline/40",
            !occupied.has(i) && !source && "cursor-crosshair",
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
  const { setSource } = useTimelineCtx();
  // Cancelled / no_show / finished blocks aren't draggable — they're
  // already off the floor.
  const draggable =
    block.status !== "cancelled" && block.status !== "no_show" && block.status !== "finished";

  return (
    <Link
      href={`/dashboard/venues/${venueId}/bookings?date=${date}`}
      draggable={draggable}
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
