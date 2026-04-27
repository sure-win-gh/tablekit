// Pure shape tests for the guests-export writer. The DB-bound
// loadGuestsForExport is covered separately in the integration suite;
// here we lock the CSV/JSON output for a known input.

import { describe, expect, it } from "vitest";

import {
  type ExportedGuest,
  guestsToCsv,
  guestsToJson,
} from "@/lib/export/guests";

const BOM = "﻿";

const sample: ExportedGuest[] = [
  {
    guestId: "11111111-1111-1111-1111-111111111111",
    firstName: "Jane",
    lastName: "Doe",
    email: "jane@example.com",
    phone: "+447700900123",
    marketingConsentAt: new Date("2026-01-15T10:00:00.000Z"),
    emailInvalid: false,
    phoneInvalid: false,
    createdAt: new Date("2025-12-01T09:00:00.000Z"),
    updatedAt: new Date("2026-01-15T10:00:00.000Z"),
  },
  {
    guestId: "22222222-2222-2222-2222-222222222222",
    firstName: "Bobby",
    lastName: "Tables",
    email: "bobby@example.com",
    phone: null,
    marketingConsentAt: null,
    emailInvalid: false,
    phoneInvalid: false,
    createdAt: new Date("2026-02-10T12:00:00.000Z"),
    updatedAt: new Date("2026-02-10T12:00:00.000Z"),
  },
];

describe("guestsToCsv", () => {
  it("emits the expected column order with BOM and CRLF", () => {
    const out = guestsToCsv(sample);
    const lines = out.slice(BOM.length).split("\r\n");
    expect(lines[0]).toBe(
      "guest_id,first_name,last_name,email,phone,marketing_consent_at,email_invalid,phone_invalid,created_at,updated_at",
    );
    expect(lines[1]).toBe(
      [
        "11111111-1111-1111-1111-111111111111",
        "Jane",
        "Doe",
        "jane@example.com",
        // Leading "+" is in the formula-injection alphabet; the guard
        // adds an apostrophe so Excel treats the cell as literal text
        // (strips the apostrophe on display, "+447700900123" shown).
        "'+447700900123",
        "2026-01-15T10:00:00.000Z",
        "false",
        "false",
        "2025-12-01T09:00:00.000Z",
        "2026-01-15T10:00:00.000Z",
      ].join(","),
    );
    // Null phone and null marketing_consent_at render as empty cells.
    expect(lines[2]).toBe(
      [
        "22222222-2222-2222-2222-222222222222",
        "Bobby",
        "Tables",
        "bobby@example.com",
        "",
        "",
        "false",
        "false",
        "2026-02-10T12:00:00.000Z",
        "2026-02-10T12:00:00.000Z",
      ].join(","),
    );
  });

  it("guards a hostile name field against spreadsheet formula execution", () => {
    const hostile: ExportedGuest = {
      ...sample[0]!,
      firstName: "=HYPERLINK(0)",
    };
    const out = guestsToCsv([hostile]);
    // Cell prefixed with apostrophe; no surrounding quotes because
    // there's no comma, quote, or newline in the value.
    expect(out).toContain(",'=HYPERLINK(0),");
  });
});

describe("guestsToJson", () => {
  it("emits a parseable array preserving fields and types", () => {
    const out = guestsToJson(sample);
    const parsed: unknown = JSON.parse(out);
    expect(Array.isArray(parsed)).toBe(true);
    const arr = parsed as ExportedGuest[];
    expect(arr).toHaveLength(2);
    expect(arr[0]?.email).toBe("jane@example.com");
    expect(arr[1]?.phone).toBeNull();
  });
});
