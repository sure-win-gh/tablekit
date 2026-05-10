// CSP violation report sink.
//
// Browsers POST here when a Content-Security-Policy (or
// Content-Security-Policy-Report-Only) header on `/embed/*` or
// `/book/*` blocks a resource. We log a minimal, PII-stripped summary
// to stdout (→ Vercel logs) so we can see what would have been blocked
// before flipping the header from report-only to enforcing.
//
// Two wire formats are accepted:
//
//   • Legacy `report-uri`           — Content-Type: application/csp-report
//                                     body: { "csp-report": { ... } }
//   • Modern `report-to` / Reporting API — Content-Type: application/reports+json
//                                     body: [{ type, age, url, body: { ... } }, ...]
//
// The endpoint is anonymous + IP-rate-limited to stop a malicious site
// from filling our logs by hammering the URL. Browsers themselves
// throttle CSP reports per spec, so under normal use the limit never
// trips.
//
// PII posture (per docs/playbooks/gdpr.md §Logs):
//   • document-uri / referrer / blocked-uri may carry user IDs, venue
//     slugs, or query strings with email tokens (e.g. unsubscribe
//     links). We strip query strings + truncate paths to keep logs
//     useful for triage without leaking PII.
//   • We never persist these to the DB. Stdout only, retention is the
//     hosting provider's log policy (Vercel: 30 days).

import "server-only";

import { NextResponse, type NextRequest } from "next/server";

import { ipFromHeaders, rateLimit } from "@/lib/public/rate-limit";

export const runtime = "nodejs";

type LegacyCspReport = {
  "csp-report"?: {
    "document-uri"?: string;
    referrer?: string;
    "violated-directive"?: string;
    "effective-directive"?: string;
    "original-policy"?: string;
    disposition?: "enforce" | "report";
    "blocked-uri"?: string;
    "status-code"?: number;
    "script-sample"?: string;
    "source-file"?: string;
    "line-number"?: number;
    "column-number"?: number;
  };
};

type ReportingApiReport = {
  type: string;
  age?: number;
  url?: string;
  body?: {
    documentURL?: string;
    referrer?: string;
    effectiveDirective?: string;
    originalPolicy?: string;
    disposition?: "enforce" | "report";
    blockedURL?: string;
    statusCode?: number;
    sample?: string;
    sourceFile?: string;
    lineNumber?: number;
    columnNumber?: number;
  };
};

export async function POST(req: NextRequest): Promise<NextResponse> {
  // Per-IP rate limit. The bucket size (60/min) is well above any
  // legitimate browser's CSP-report throughput but blunts a malicious
  // poster trying to drown the logs.
  const ip = ipFromHeaders(req.headers);
  const rl = await rateLimit(`csp-report:${ip}`, 60, 60);
  if (!rl.ok) {
    return new NextResponse(null, { status: 429 });
  }

  let payload: unknown;
  try {
    payload = await req.json();
  } catch {
    return new NextResponse(null, { status: 204 });
  }

  for (const report of extractReports(payload)) {
    // Single string so structured-log capture doesn't drop fields.
    // Vercel ships these to the log drain; grep on `csp.violation`
    // in production logs surfaces real issues. We DO NOT write to
    // audit_log — these are pre-launch CSP tuning signals, not
    // security-relevant audit events.
    console.warn(`csp.violation ${JSON.stringify(report)}`);
  }

  // 204 with no body — browsers don't care about the response.
  return new NextResponse(null, { status: 204 });
}

// Normalise both wire formats into a single redacted record. Stripping
// query strings + truncating paths is what keeps PII out of the log.
function extractReports(payload: unknown): Array<Record<string, unknown>> {
  if (!payload || typeof payload !== "object") return [];

  // Modern Reporting API: payload is an array of envelopes.
  if (Array.isArray(payload)) {
    const out: Array<Record<string, unknown>> = [];
    for (const envelope of payload) {
      const e = envelope as ReportingApiReport;
      if (e.type !== "csp-violation" && e.type !== "csp-report") continue;
      const b = e.body ?? {};
      out.push({
        kind: "reporting-api",
        directive: b.effectiveDirective ?? null,
        blockedHost: hostOf(b.blockedURL),
        documentPath: pathOf(b.documentURL),
        sourceHost: hostOf(b.sourceFile),
        line: b.lineNumber ?? null,
        disposition: b.disposition ?? null,
      });
    }
    return out;
  }

  // Legacy report-uri: { "csp-report": { ... } }
  const legacy = (payload as LegacyCspReport)["csp-report"];
  if (legacy) {
    return [
      {
        kind: "report-uri",
        directive: legacy["effective-directive"] ?? legacy["violated-directive"] ?? null,
        blockedHost: hostOf(legacy["blocked-uri"]),
        documentPath: pathOf(legacy["document-uri"]),
        sourceHost: hostOf(legacy["source-file"]),
        line: legacy["line-number"] ?? null,
        disposition: legacy.disposition ?? null,
      },
    ];
  }

  return [];
}

// Returns host portion only. `blocked-uri` can also be a keyword
// (`inline`, `eval`, `data`, `self`); pass those through unchanged so
// the log says what was actually blocked.
function hostOf(uri: string | undefined | null): string | null {
  if (!uri) return null;
  if (!uri.includes("://")) return uri; // keyword or scheme-less
  try {
    return new URL(uri).host || null;
  } catch {
    return null;
  }
}

// Path-only — drops query strings (potential PII / tokens) and
// fragments. Keeps the leading slash so the route is recognisable.
function pathOf(uri: string | undefined | null): string | null {
  if (!uri) return null;
  try {
    const u = new URL(uri);
    return u.pathname || null;
  } catch {
    return null;
  }
}
