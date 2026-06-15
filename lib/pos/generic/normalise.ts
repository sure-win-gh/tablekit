// Generic POS payload → NormalisedOrder. One documented minimal shape, used
// by both the signed webhook (JSON body) and the CSV importer (one row).
//
// Required: external_order_id, total_minor (integer pence), closed_at (ISO).
// Optional: currency, tip_minor, tax_minor, cover_count, payment_method_label,
// email, phone, raw_provider_ref, line_items (JSON path only).
//
// Marketing consent is NEVER inferred from a POS upload (spec).

import type { NormalisedLineItem, NormalisedOrder } from "../types";

export type GenericOrderInput = {
  external_order_id?: unknown;
  total_minor?: unknown;
  currency?: unknown;
  closed_at?: unknown;
  tip_minor?: unknown;
  tax_minor?: unknown;
  cover_count?: unknown;
  payment_method_label?: unknown;
  email?: unknown;
  phone?: unknown;
  raw_provider_ref?: unknown;
  line_items?: unknown;
};

export type ParseOrderResult = { ok: true; order: NormalisedOrder } | { ok: false; error: string };

function toInt(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return Math.trunc(v);
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    if (Number.isFinite(n)) return Math.trunc(n);
  }
  return null;
}

function toStr(v: unknown): string | null {
  if (typeof v === "string" && v.trim() !== "") return v.trim();
  return null;
}

function toLineItems(v: unknown): NormalisedLineItem[] | null {
  if (!Array.isArray(v)) return null;
  const items: NormalisedLineItem[] = [];
  for (const raw of v) {
    if (raw && typeof raw === "object") {
      const o = raw as Record<string, unknown>;
      items.push({
        name: toStr(o["name"]) ?? "Item",
        quantity: toInt(o["quantity"]) ?? 1,
        totalMinor: toInt(o["total_minor"]) ?? 0,
      });
    }
  }
  return items.length > 0 ? items : null;
}

// Build from an already-parsed object (webhook JSON or a CSV row coerced to
// this shape). Returns a typed error rather than throwing.
export function buildGenericOrder(input: GenericOrderInput): ParseOrderResult {
  const externalOrderId = toStr(input.external_order_id);
  if (!externalOrderId) return { ok: false, error: "external_order_id is required" };

  const totalMinor = toInt(input.total_minor);
  if (totalMinor === null) return { ok: false, error: "total_minor must be an integer (pence)" };

  const closedRaw = toStr(input.closed_at);
  if (!closedRaw) return { ok: false, error: "closed_at is required" };
  const closedAt = new Date(closedRaw);
  if (Number.isNaN(closedAt.getTime()))
    return { ok: false, error: "closed_at is not a valid date" };

  return {
    ok: true,
    order: {
      provider: "generic",
      externalOrderId,
      totalMinor,
      tipMinor: toInt(input.tip_minor) ?? 0,
      taxMinor: toInt(input.tax_minor),
      currency: toStr(input.currency) ?? "GBP",
      coverCount: toInt(input.cover_count),
      paymentMethodLabel: toStr(input.payment_method_label),
      closedAt,
      customerEmail: toStr(input.email),
      customerPhone: toStr(input.phone),
      bookingRef: null,
      lineItems: toLineItems(input.line_items),
      rawProviderRef: toStr(input.raw_provider_ref),
    },
  };
}
