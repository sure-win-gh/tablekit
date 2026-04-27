import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

// Asserts no admin-dashboard module reaches into lib/security/crypto.
// The /admin surface is cross-org by design and must NEVER decrypt
// guest PII — every metric is an aggregate over indexed columns.
//
// This is a structural test: a static scan of every TS file under
// lib/server/admin/dashboard for the import path. Cheap to run, hard
// to fool. If we ever genuinely need decrypt under /admin we should
// re-think the design first; if you're here to add it, this test
// should fail loudly.

const ROOT = resolve(__dirname, "../../lib/server/admin/dashboard");

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (full.endsWith(".ts")) out.push(full);
  }
  return out;
}

describe("admin dashboard — no-decrypt invariant", () => {
  it("no module under lib/server/admin/dashboard imports lib/security/crypto", () => {
    const files = walk(ROOT);
    expect(files.length).toBeGreaterThan(0);
    const offenders: string[] = [];
    for (const file of files) {
      const src = readFileSync(file, "utf8");
      if (
        /from\s+["']@\/lib\/security\/crypto/.test(src) ||
        /from\s+["']\.\.\/.*security\/crypto/.test(src)
      ) {
        offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });
});
