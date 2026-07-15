// Read-only Cloudflare drift check.
//
// Compares the dashboard's live rate-limiting + custom (skip) rules
// against the checked-in source of truth (infra/cloudflare/ruleset.ts)
// and reports differences. GET-only — this script never mutates the
// zone, so the API token it needs can be scoped to Zone:Read.
//
// Usage:
//   CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ZONE_ID=... pnpm tsx scripts/cloudflare-drift.ts
//
// Exit codes: 0 in sync, 1 drift found, 2 config/API error.

import { RATE_LIMIT_RULES, SKIP_RULES } from "../infra/cloudflare/ruleset";

const API = "https://api.cloudflare.com/client/v4";

type CfRule = {
  id: string;
  description?: string;
  expression?: string;
  action?: string;
  enabled?: boolean;
};

type CfRuleset = {
  id: string;
  phase: string;
  rules?: CfRule[];
};

async function cf<T>(path: string, token: string): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    throw new Error(`Cloudflare API ${res.status} for GET ${path}`);
  }
  const body = (await res.json()) as { success: boolean; result: T; errors: unknown[] };
  if (!body.success) {
    throw new Error(`Cloudflare API error for GET ${path}: ${JSON.stringify(body.errors)}`);
  }
  return body.result;
}

async function main(): Promise<number> {
  const token = process.env["CLOUDFLARE_API_TOKEN"];
  const zoneId = process.env["CLOUDFLARE_ZONE_ID"];
  if (!token || !zoneId) {
    console.error("Set CLOUDFLARE_API_TOKEN (Zone:Read) and CLOUDFLARE_ZONE_ID.");
    return 2;
  }

  // NOTE: unpaginated read — fine at this zone's scale (a handful of
  // rulesets); revisit if the list ever exceeds one page. ZONE_SETTINGS
  // toggles are not checked here (quarterly eyeball per the playbook).
  const rulesets = await cf<CfRuleset[]>(`/zones/${zoneId}/rulesets`, token);

  const phases: Record<string, CfRule[]> = {};
  for (const rs of rulesets) {
    const detail = await cf<CfRuleset>(`/zones/${zoneId}/rulesets/${rs.id}`, token);
    (phases[rs.phase] ??= []).push(...(detail.rules ?? []));
  }

  const liveRateRules = phases["http_ratelimit"] ?? [];
  const liveCustomRules = phases["http_request_firewall_custom"] ?? [];
  let drift = 0;

  // Rate-limit rules: match by the R-id we put in the dashboard
  // description; compare the expression.
  for (const want of RATE_LIMIT_RULES) {
    const live = liveRateRules.find((r) => r.description?.startsWith(want.id));
    if (!live) {
      console.error(`DRIFT missing rate-limit rule ${want.id} (${want.rationale})`);
      drift = 1;
    } else if (live.expression !== want.expression) {
      console.error(
        `DRIFT ${want.id} expression differs\n  repo: ${want.expression}\n  live: ${live.expression}`,
      );
      drift = 1;
    } else if (live.enabled === false) {
      console.error(`DRIFT ${want.id} exists but is disabled`);
      drift = 1;
    }
  }

  // Skip rules: every checked-in path must appear in some enabled
  // custom skip rule's expression.
  for (const want of SKIP_RULES) {
    const covered = liveCustomRules.some(
      (r) => r.action === "skip" && r.enabled !== false && r.expression?.includes(want.path),
    );
    if (!covered) {
      console.error(`DRIFT no enabled skip rule covers ${want.path} (${want.verification})`);
      drift = 1;
    }
  }

  if (drift === 0) {
    console.log(
      `In sync: ${RATE_LIMIT_RULES.length} rate-limit rules, ${SKIP_RULES.length} skip paths.`,
    );
  }
  return drift;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(2);
  });
