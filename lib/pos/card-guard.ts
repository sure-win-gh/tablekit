// Card-data guard — the PCI SAQ-A backstop for POS ingest.
//
// We only ever want order totals, tips, a payment-method *label*, and
// optional itemisation. A POS payload should never carry a full card
// number, but a misconfigured till or a custom field could leak one. This
// module strips any value that looks like a card number from a normalised
// order BEFORE it is persisted or logged, so we never store or echo one.
//
// "Card-number-shaped" = a 13–19 digit run (ignoring spaces/dashes) that
// passes the Luhn checksum. The raw candidate is NEVER logged — only the
// fact that a field was scrubbed, and where.
//
// See docs/playbooks/payments.md (SAQ-A) and the guard-pii hook.

import type { NormalisedOrder } from "./types";

// Strip separators and test whether the remaining run is a plausible card
// number: 13–19 digits passing Luhn. Deliberately conservative — a short
// numeric token (table number, cover count) won't match.
export function looksLikeCardNumber(value: string): boolean {
  const digits = value.replace(/[\s-]/g, "");
  if (!/^\d{13,19}$/.test(digits)) return false;
  return luhnValid(digits);
}

function luhnValid(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48; // '0' = 48
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

export type CardGuardResult = {
  order: NormalisedOrder;
  // Field paths that were scrubbed (no raw values) — for a non-PII audit note.
  scrubbed: string[];
};

// Return a copy of the order with any card-number-shaped string blanked.
// The label and line-item names are the realistic leak sites; we also
// re-check the rawProviderRef. Numbers (totals etc.) are typed `number`
// and can't carry a card number, so they're left alone.
export function stripCardData(order: NormalisedOrder): CardGuardResult {
  const scrubbed: string[] = [];

  let paymentMethodLabel = order.paymentMethodLabel;
  if (paymentMethodLabel != null && looksLikeCardNumber(paymentMethodLabel)) {
    paymentMethodLabel = null;
    scrubbed.push("paymentMethodLabel");
  }

  let rawProviderRef = order.rawProviderRef;
  if (rawProviderRef != null && looksLikeCardNumber(rawProviderRef)) {
    rawProviderRef = null;
    scrubbed.push("rawProviderRef");
  }

  let lineItems = order.lineItems;
  if (lineItems != null) {
    lineItems = lineItems.map((li, idx) => {
      if (looksLikeCardNumber(li.name)) {
        scrubbed.push(`lineItems[${idx}].name`);
        return { ...li, name: "[redacted]" };
      }
      return li;
    });
  }

  return {
    order: { ...order, paymentMethodLabel, rawProviderRef, lineItems },
    scrubbed,
  };
}
