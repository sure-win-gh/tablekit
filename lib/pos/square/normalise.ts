// Normalise a Square `payment.updated` event into a NormalisedOrder.
//
// We key off payments (not order.created) because orders rung up on the
// Square POS app don't emit order.created — only payment events fire. The
// payment carries the settled totals; the parent order (fetched separately,
// only when line-item ingest is enabled) carries itemisation + tax.
//
// We only ever read amounts, a masked card label (brand + last 4 — never a
// card number), and the buyer email. No card data is taken.

import type { NormalisedOrder } from "../types";

type Money = { amount?: number; currency?: string } | null | undefined;

export type SquarePayment = {
  id: string;
  status?: string;
  order_id?: string;
  location_id?: string;
  amount_money?: Money;
  tip_money?: Money;
  total_money?: Money;
  buyer_email_address?: string;
  updated_at?: string;
  created_at?: string;
  card_details?: {
    card?: { card_brand?: string; last_4?: string };
  };
};

// Minimal shape of the parent order we read when line items are enabled.
export type SquareOrder = {
  id: string;
  total_tax_money?: Money;
  line_items?: Array<{ name?: string; quantity?: string; total_money?: Money }>;
};

export type SquareWebhookEvent = {
  merchant_id?: string;
  type?: string;
  event_id?: string;
  data?: { object?: { payment?: SquarePayment } };
};

function amount(m: Money): number {
  return typeof m?.amount === "number" ? m.amount : 0;
}

export function isCompletedPaymentEvent(event: SquareWebhookEvent): boolean {
  const payment = event.data?.object?.payment;
  return event.type === "payment.updated" && payment?.status === "COMPLETED";
}

function maskedLabel(payment: SquarePayment): string | null {
  const card = payment.card_details?.card;
  if (card?.last_4) {
    const brand = card.card_brand ?? "Card";
    // brand + last 4 only — e.g. "VISA ••4242". Never a full card number.
    return `${brand} ••${card.last_4}`;
  }
  return null;
}

export function normaliseSquarePayment(
  payment: SquarePayment,
  order: SquareOrder | null,
): NormalisedOrder {
  // Prefer total_money (gross incl. tip) when present; else amount + tip.
  const total =
    payment.total_money?.amount != null
      ? amount(payment.total_money)
      : amount(payment.amount_money) + amount(payment.tip_money);

  const currency = payment.total_money?.currency ?? payment.amount_money?.currency ?? "GBP";

  const closedAt = payment.updated_at
    ? new Date(payment.updated_at)
    : payment.created_at
      ? new Date(payment.created_at)
      : new Date(0);

  const lineItems =
    order?.line_items?.map((li) => ({
      name: li.name ?? "Item",
      quantity: Number(li.quantity ?? "1") || 1,
      totalMinor: amount(li.total_money),
    })) ?? null;

  return {
    provider: "square",
    // Key on the PAYMENT id, not order_id: a split-bill check emits one
    // payment.updated per payment that all share order_id, so keying on
    // order_id would collapse them onto one row and the last payment would
    // overwrite the total (under-counting spend). One row per settled payment
    // keeps gross spend correct; order_id is kept on raw_provider_ref for
    // grouping. Re-delivery of the same payment.id upserts idempotently.
    externalOrderId: payment.id,
    totalMinor: total,
    tipMinor: amount(payment.tip_money),
    taxMinor: order?.total_tax_money?.amount != null ? amount(order.total_tax_money) : null,
    currency,
    coverCount: null,
    paymentMethodLabel: maskedLabel(payment),
    closedAt,
    customerEmail: payment.buyer_email_address ?? null,
    customerPhone: null,
    bookingRef: payment.order_id ?? null,
    lineItems,
    rawProviderRef: payment.order_id ?? payment.id,
  };
}
