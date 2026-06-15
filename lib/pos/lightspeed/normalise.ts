// Normalise a Lightspeed K-Series webhook into a NormalisedOrder.
//
// We act on the settled-account signals — Account: CLOSED and
// CHECK_WAS_UPDATED (+ Payment: SUCCESS) — which carry the final total. The
// payload shape below is provisional (confirmed at partner onboarding); the
// mapping to NormalisedOrder is the stable contract. No card data is read.

import type { NormalisedOrder } from "../types";

export type LightspeedAccount = {
  id: string;
  total_amount?: number; // minor units (pence)
  tip_amount?: number;
  tax_amount?: number;
  currency?: string;
  cover_count?: number;
  closed_at?: string;
  payment_method_label?: string;
  customer?: { email?: string; phone?: string };
  items?: Array<{ name?: string; quantity?: number; total_amount?: number }>;
};

export type LightspeedEvent = {
  business_id?: string;
  event_id?: string;
  type?: string; // "ACCOUNT_CLOSED" | "CHECK_WAS_UPDATED" | "PAYMENT_SUCCESS"
  account?: LightspeedAccount;
};

const SETTLED_TYPES = new Set(["ACCOUNT_CLOSED", "CHECK_WAS_UPDATED", "PAYMENT_SUCCESS"]);

export function isSettledAccountEvent(event: LightspeedEvent): boolean {
  return Boolean(event.type && SETTLED_TYPES.has(event.type) && event.account?.id);
}

export function normaliseLightspeedAccount(
  account: LightspeedAccount,
  lineItemsEnabled: boolean,
): NormalisedOrder {
  const lineItems =
    lineItemsEnabled && account.items
      ? account.items.map((li) => ({
          name: li.name ?? "Item",
          quantity: li.quantity ?? 1,
          totalMinor: li.total_amount ?? 0,
        }))
      : null;

  return {
    provider: "lightspeed_k",
    externalOrderId: account.id,
    totalMinor: account.total_amount ?? 0,
    tipMinor: account.tip_amount ?? 0,
    taxMinor: account.tax_amount ?? null,
    currency: account.currency ?? "GBP",
    coverCount: account.cover_count ?? null,
    paymentMethodLabel: account.payment_method_label ?? null,
    closedAt: account.closed_at ? new Date(account.closed_at) : new Date(0),
    customerEmail: account.customer?.email ?? null,
    customerPhone: account.customer?.phone ?? null,
    bookingRef: null,
    lineItems,
    rawProviderRef: account.id,
  };
}
