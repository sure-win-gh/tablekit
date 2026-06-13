"use client";

import { useActionState } from "react";

import { attachOrderToGuest, type PosActionState } from "./pos-actions";

const initial: PosActionState = { status: "idle" };

export type UnmatchedOrderRow = {
  id: string;
  provider: string;
  totalMinor: number;
  currency: string;
  paymentMethodLabel: string | null;
  closedAt: Date;
};

function formatMoney(minor: number, currency: string): string {
  return new Intl.NumberFormat("en-GB", { style: "currency", currency }).format(minor / 100);
}

export function UnmatchedOrders({
  venueId,
  orders,
}: {
  venueId: string;
  orders: UnmatchedOrderRow[];
}) {
  const [state, formAction, pending] = useActionState(attachOrderToGuest, initial);

  if (orders.length === 0) {
    return (
      <section className="flex max-w-xl flex-col gap-2">
        <h2 className="text-ink text-base font-semibold">Unmatched orders</h2>
        <p className="text-ash text-sm">Every order is attached to a guest. Nothing to review.</p>
      </section>
    );
  }

  return (
    <section className="flex max-w-2xl flex-col gap-3">
      <header>
        <h2 className="text-ink text-base font-semibold">Unmatched orders</h2>
        <p className="text-ash text-sm">
          Orders we couldn&apos;t tie to a guest. Paste a guest id to attach one by hand.
        </p>
      </header>

      {state.status === "error" ? <p className="text-coral text-sm">{state.message}</p> : null}
      {state.status === "saved" ? <p className="text-ash text-sm">Attached.</p> : null}

      <ul className="flex flex-col gap-2">
        {orders.map((o) => (
          <li key={o.id} className="border-cloud rounded-lg border p-3">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-ink text-sm font-medium">
                  {formatMoney(o.totalMinor, o.currency)}
                  {o.paymentMethodLabel ? ` · ${o.paymentMethodLabel}` : ""}
                </p>
                <p className="text-ash text-xs">
                  {o.provider} · {o.closedAt.toLocaleString()}
                </p>
              </div>
            </div>
            <form action={formAction} className="mt-2 flex items-center gap-2">
              <input type="hidden" name="venue_id" value={venueId} />
              <input type="hidden" name="order_id" value={o.id} />
              <input
                name="guest_id"
                placeholder="Guest id"
                required
                className="border-cloud min-w-0 flex-1 rounded-md border px-2 py-1 text-sm"
              />
              <button
                type="submit"
                disabled={pending}
                className="bg-ink text-cloud rounded-md px-3 py-1 text-sm font-medium disabled:opacity-50"
              >
                Attach
              </button>
            </form>
          </li>
        ))}
      </ul>
    </section>
  );
}
