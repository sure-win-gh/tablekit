// PCI SAQ-A guard: no literal card numbers anywhere in application source
// (docs/playbooks/payments.md rule 1; special-events plan "no-raw-card CI
// grep"). Card data must only ever touch Stripe Elements in the browser —
// a pasted test PAN in a fixture, default, or debug snippet is exactly the
// accident this scan exists to catch, and it automatically covers every
// new payment surface (deposits, event tickets, whatever comes next).
//
// Source scan in the style of no-cors-wildcard.test.ts. A candidate is a
// bare 15–16 digit run or a 4-4-4-4 separated group; it only fails the
// build if it Luhn-validates (via the shared POS card-guard), so ids,
// epoch timestamps, and phone numbers don't false-positive.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { describe, expect, it } from "vitest";

import { looksLikeCardNumber } from "@/lib/pos/card-guard";

const ROOT = join(__dirname, "..", "..");
const SCAN_DIRS = ["app", "lib", "components"];

// Bare 15–16 digit runs (Amex/Visa/MC lengths — 13-digit epoch-ms literals
// stay out of range) + classic 4-4-4-4 formatting with space or dash.
const CANDIDATE = /(?<!\d)(?:\d{15,16}|\d{4}[ -]\d{4}[ -]\d{4}[ -]\d{4})(?!\d)/g;

function tsFilesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry.startsWith(".")) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...tsFilesUnder(full));
    } else if (full.endsWith(".ts") || full.endsWith(".tsx")) {
      out.push(full);
    }
  }
  return out;
}

describe("no raw card numbers in source", () => {
  it("app/, lib/ and components/ contain no Luhn-valid card-number literals", () => {
    const offenders: string[] = [];
    for (const dir of SCAN_DIRS) {
      for (const file of tsFilesUnder(join(ROOT, dir))) {
        const content = readFileSync(file, "utf8");
        for (const match of content.match(CANDIDATE) ?? []) {
          if (looksLikeCardNumber(match)) {
            offenders.push(`${relative(ROOT, file)}: ${match}`);
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
