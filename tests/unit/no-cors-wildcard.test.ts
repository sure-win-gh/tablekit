// Guard: the app is same-origin by design (widget iframe + bearer-token REST
// API), so it must emit NO CORS headers — and never a wildcard
// `Access-Control-Allow-Origin: *`. See docs/playbooks/security.md "CORS".
//
// A source scan rather than a runtime check: CORS headers could be introduced
// either in next.config.ts `headers()` or directly in a route handler, so we
// assert neither place mentions Access-Control-Allow-Origin at all.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..", "..");
const ACAO = /access-control-allow-origin/i;

function tsFilesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...tsFilesUnder(full));
    } else if (full.endsWith(".ts") || full.endsWith(".tsx")) {
      out.push(full);
    }
  }
  return out;
}

describe("no CORS wildcard", () => {
  it("next.config.ts emits no Access-Control-Allow-Origin header", () => {
    const config = readFileSync(join(ROOT, "next.config.ts"), "utf8");
    expect(ACAO.test(config)).toBe(false);
  });

  it("no app/api route handler sets an Access-Control-Allow-Origin header", () => {
    const offenders = tsFilesUnder(join(ROOT, "app", "api")).filter((f) =>
      ACAO.test(readFileSync(f, "utf8")),
    );
    expect(offenders).toEqual([]);
  });
});
