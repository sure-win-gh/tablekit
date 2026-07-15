// Pins the checked-in Cloudflare ruleset (infra/cloudflare/ruleset.ts)
// to the codebase so the edge config can't rot:
//
//   • every skip-rule path must map to a real route under app/api (or
//     the Sentry tunnel configured in next.config.ts) — a skip rule
//     for a deleted route is an unauthenticated hole waiting for a
//     path reuse;
//   • every signature-verified webhook receiver in the repo must have
//     a skip rule — otherwise the WAF can break signed traffic;
//   • rate-limit rules must reference paths that exist.

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { RATE_LIMIT_RULES, SKIP_RULES } from "@/infra/cloudflare/ruleset";

const root = resolve(__dirname, "../..");

describe("skip rules map to real code", () => {
  it.each(SKIP_RULES.map((r) => [r.path, r.route] as const))("%s → %s exists", (_path, route) => {
    if (route.startsWith("next.config.ts")) {
      const config = readFileSync(resolve(root, "next.config.ts"), "utf8");
      expect(config).toContain('tunnelRoute: "/monitoring"');
      return;
    }
    expect(existsSync(resolve(root, route))).toBe(true);
  });

  it("every api skip path matches its route directory", () => {
    for (const rule of SKIP_RULES) {
      if (!rule.path.startsWith("/api/")) continue;
      // /api/foo/bar → app/api/foo/bar must be the route's prefix.
      const expectedPrefix = `app${rule.path}`;
      expect(rule.route.startsWith(expectedPrefix)).toBe(true);
    }
  });
});

describe("signature-verified receivers are all covered", () => {
  const REQUIRED_WEBHOOK_ROUTES = [
    "app/api/stripe/webhook/route.ts",
    "app/api/twilio/webhook/route.ts",
    "app/api/resend/webhook/route.ts",
    "app/api/webhooks/resend-inbound/route.ts",
    "app/api/webhooks/pos/square/route.ts",
    "app/api/webhooks/pos/lightspeed/route.ts",
    "app/api/pos/ingest/route.ts",
  ];

  it.each(REQUIRED_WEBHOOK_ROUTES.map((r) => [r] as const))(
    "%s is covered by a skip path",
    (route) => {
      expect(existsSync(resolve(root, route))).toBe(true);
      const covered = SKIP_RULES.some((rule) => route.startsWith(`app${rule.path}`));
      expect(covered).toBe(true);
    },
  );
});

describe("rate-limit rules reference real paths", () => {
  it("api paths in expressions resolve to route files or prefixes", () => {
    for (const rule of RATE_LIMIT_RULES) {
      const match = rule.expression.match(/"(\/api\/[^"]+)"/);
      if (!match) continue; // page paths (/login, /signup) are app router pages
      const path = match[1]!;
      const asPrefix = path.endsWith("/");
      const target = asPrefix
        ? resolve(root, `app${path.slice(0, -1)}`)
        : resolve(root, `app${path}/route.ts`);
      expect(existsSync(target), `${rule.id}: ${path}`).toBe(true);
    }
  });

  it("auth rules challenge instead of blocking", () => {
    for (const rule of RATE_LIMIT_RULES) {
      if (rule.expression.includes("/login") || rule.expression.includes("/signup")) {
        expect(rule.action).toBe("managed_challenge");
      }
    }
  });
});
