// The single internal shape every POS provider normalises into. Square,
// Lightspeed, the generic webhook, and the CSV importer all produce a
// NormalisedOrder; everything downstream (card guard, match, upsert,
// rollup) operates on this and is provider-agnostic.

import type { PosProvider } from "./connection";

export type NormalisedLineItem = {
  name: string;
  quantity: number;
  // Gross line total in minor units (pence). No card data ever.
  totalMinor: number;
};

export type NormalisedOrder = {
  provider: PosProvider;
  // The till's own order/check id — the dedupe key within a connection.
  externalOrderId: string;
  // Settled total / tip / tax in minor units (pence), gross.
  totalMinor: number;
  tipMinor: number;
  taxMinor: number | null;
  currency: string; // ISO 4217, e.g. "GBP"
  coverCount: number | null;
  // Display label only — e.g. "Visa ••4242", "Cash". Never a card number;
  // the card guard strips anything card-number-shaped before persistence.
  paymentMethodLabel: string | null;
  // When the check was settled.
  closedAt: Date;
  // Optional customer contact for hash matching (plaintext from the POS,
  // hashed via hashForLookup — never stored in plaintext by us).
  customerEmail: string | null;
  customerPhone: string | null;
  // Optional booking-link hints — a table/check reference the provider
  // carries that can map to one of our bookings at the same venue.
  bookingRef: string | null;
  // Optional itemisation. Only persisted when the connection has opted in
  // to line-item ingest (Art. 9 gate); encrypted at rest.
  lineItems: NormalisedLineItem[] | null;
  // Opaque provider pointer for support/debug — must contain no PII.
  rawProviderRef: string | null;
};
