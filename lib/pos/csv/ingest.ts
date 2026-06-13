// CSV order importer for the generic path. Reuses the import-export CSV
// parser (lib/import/parse.ts), maps each row to the generic order shape,
// and runs it through the shared ingest pipeline. Per-row failures are
// collected as rejected rows rather than aborting the whole file (mirrors
// the import runner's partial-success posture).
//
// Marketing consent is never inferred from a POS upload.

import "server-only";

import { parseCsv } from "@/lib/import/parse";
import { ingestOrder } from "@/lib/pos/ingest";
import { loadIngestContextByConnectionId } from "@/lib/pos/ingest-context";

import { buildGenericOrder } from "../generic/normalise";

export type CsvIngestResult = {
  ingested: number;
  rejected: Array<{ rowNumber: number; reason: string }>;
};

// Column → generic-order field. Header names are matched case-insensitively
// after the parser's trim. Unknown columns are ignored.
function rowToInput(row: Record<string, string>): Record<string, string> {
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(row)) lower[k.toLowerCase()] = v;
  return {
    external_order_id: lower["external_order_id"] ?? "",
    total_minor: lower["total_minor"] ?? "",
    currency: lower["currency"] ?? "",
    closed_at: lower["closed_at"] ?? "",
    tip_minor: lower["tip_minor"] ?? "",
    tax_minor: lower["tax_minor"] ?? "",
    cover_count: lower["cover_count"] ?? "",
    payment_method_label: lower["payment_method_label"] ?? "",
    email: lower["email"] ?? "",
    phone: lower["phone"] ?? "",
    raw_provider_ref: lower["raw_provider_ref"] ?? "",
  };
}

export async function ingestPosCsv(
  connectionId: string,
  csvText: string,
): Promise<CsvIngestResult> {
  const ctx = await loadIngestContextByConnectionId(connectionId);
  if (!ctx || ctx.status !== "active") {
    return {
      ingested: 0,
      rejected: [{ rowNumber: 0, reason: "connection not found or inactive" }],
    };
  }

  const { rows, parseErrors } = parseCsv(csvText);
  const rejected: CsvIngestResult["rejected"] = parseErrors.map((e) => ({
    rowNumber: e.rowNumber,
    reason: e.message,
  }));
  let ingested = 0;

  for (let i = 0; i < rows.length; i++) {
    const built = buildGenericOrder(rowToInput(rows[i] as Record<string, string>));
    if (!built.ok) {
      rejected.push({ rowNumber: i + 1, reason: built.error });
      continue;
    }
    await ingestOrder({
      connectionId: ctx.connectionId,
      organisationId: ctx.organisationId,
      venueId: ctx.venueId,
      lineItemsEnabled: ctx.lineItemsEnabled,
      groupCrmEnabled: ctx.groupCrmEnabled,
      order: built.order,
    });
    ingested++;
  }

  return { ingested, rejected };
}
