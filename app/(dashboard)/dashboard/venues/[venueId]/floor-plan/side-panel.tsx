"use client";

import { X } from "lucide-react";
import Link from "next/link";

import { IconButton } from "@/components/ui";
import type { BookingStatus } from "@/lib/bookings/state";
import { STATUS_FILL } from "@/lib/bookings/status-style";

import { TableRow } from "./forms";
import type { TableShapeData } from "./table-shape";

export type ActiveBookingDetail = {
  id: string;
  status: BookingStatus;
  partySize: number;
  guestFirstName: string;
  serviceName: string;
  startWall: string; // pre-formatted in venue tz
  endWall: string;
  notes: string | null;
  otherTableLabels: string[]; // multi-table bookings
};

type Props = {
  venueId: string;
  date: string;
  table: TableShapeData | null;
  booking: ActiveBookingDetail | null;
  upcoming: ActiveBookingDetail | null;
  editMode: boolean;
  onClose: () => void;
};

export function SidePanel({
  venueId,
  date,
  table,
  booking,
  upcoming,
  editMode,
  onClose,
}: Props) {
  if (!table) return null;

  return (
    <aside className="absolute right-0 top-0 z-10 flex h-full w-80 flex-col border-l border-hairline bg-white shadow-panel">
      <header className="flex items-center justify-between border-b border-hairline px-4 py-3">
        <div>
          <h3 className="text-sm font-semibold text-ink">Table {table.label}</h3>
          <p className="text-xs text-ash">
            {table.minCover}–{table.maxCover} covers · {table.shape}
          </p>
        </div>
        <IconButton size="sm" aria-label="Close panel" onClick={onClose}>
          <X className="h-4 w-4" aria-hidden />
        </IconButton>
      </header>

      <div className="flex-1 overflow-y-auto px-4 py-3">
        {editMode ? (
          <div className="text-sm">
            <p className="mb-2 text-xs uppercase tracking-wide text-ash">Edit table</p>
            <TableRow
              tableId={table.id}
              label={table.label}
              minCover={table.minCover}
              maxCover={table.maxCover}
              shape={table.shape}
              position={table.position}
            />
            <p className="mt-3 text-xs text-ash">
              Drag the table on the canvas to reposition it. Save here to change label, covers, or
              shape.
            </p>
          </div>
        ) : booking ? (
          <BookingCard
            venueId={venueId}
            date={date}
            booking={booking}
            heading="Currently on table"
          />
        ) : upcoming ? (
          <BookingCard
            venueId={venueId}
            date={date}
            booking={upcoming}
            heading="Next on table (within 30 min)"
          />
        ) : (
          <p className="text-sm text-ash">Empty for the rest of service.</p>
        )}
      </div>
    </aside>
  );
}

function BookingCard({
  venueId,
  date,
  booking,
  heading,
}: {
  venueId: string;
  date: string;
  booking: ActiveBookingDetail;
  heading: string;
}) {
  return (
    <div className="text-sm text-ink">
      <p className="mb-2 text-xs uppercase tracking-wide text-ash">{heading}</p>
      <p className="text-base font-semibold text-ink">{booking.guestFirstName}</p>
      <p className="text-xs text-ash">
        Party of {booking.partySize} · {booking.serviceName}
      </p>
      <p className="mt-2 text-xs text-ash">
        {booking.startWall} – {booking.endWall}
      </p>
      <p className="mt-3">
        <span
          className={`inline-flex items-center rounded-input border px-2 py-0.5 text-xs ${STATUS_FILL[booking.status]}`}
        >
          {booking.status.replace("_", " ")}
        </span>
      </p>
      {booking.otherTableLabels.length > 0 ? (
        <p className="mt-3 text-xs text-ash">
          Combined with {booking.otherTableLabels.map((l) => `T${l}`).join(", ")}
        </p>
      ) : null}
      {booking.notes ? (
        <p className="mt-3 whitespace-pre-wrap text-xs text-charcoal">{booking.notes}</p>
      ) : null}
      <Link
        href={`/dashboard/venues/${venueId}/bookings?date=${date}`}
        className="mt-4 inline-block text-xs text-coral hover:underline"
      >
        Open in bookings list →
      </Link>
    </div>
  );
}
