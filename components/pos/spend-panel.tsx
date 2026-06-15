// Guest spend panel — lifetime spend / visits / average, updating live via
// Realtime (useGuestSpend) with a 30s poll fallback. Drop into the guest
// profile, the floor-plan side panel, or the booking detail dialog; seed it
// from a server-rendered initial value (loadGuestSpend).

"use client";

import { useGuestSpend, type GuestSpend } from "./use-guest-spend";

function money(minor: number): string {
  return new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP" }).format(minor / 100);
}

export function SpendPanel({
  guestId,
  organisationId,
  initial,
}: {
  guestId: string;
  organisationId: string;
  initial: GuestSpend;
}) {
  const spend = useGuestSpend({ guestId, organisationId, initial });

  if (!spend || spend.orderCount === 0) {
    return <p className="text-ash text-sm">No spend recorded yet.</p>;
  }

  return (
    <dl className="grid grid-cols-3 gap-3 text-sm">
      <div>
        <dt className="text-ash text-xs">Lifetime spend</dt>
        <dd className="text-ink font-semibold">{money(spend.totalSpendMinor)}</dd>
      </div>
      <div>
        <dt className="text-ash text-xs">Orders</dt>
        <dd className="text-ink font-semibold">{spend.orderCount}</dd>
      </div>
      <div>
        <dt className="text-ash text-xs">Avg spend</dt>
        <dd className="text-ink font-semibold">{money(spend.avgSpendMinor)}</dd>
      </div>
    </dl>
  );
}
