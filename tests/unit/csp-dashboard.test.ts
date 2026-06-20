// Unit tests for the dashboard/admin CSP builder. The load-bearing guarantee
// is that script-src drops 'unsafe-inline' (only the nonce + strict-dynamic
// run) while style-src deliberately keeps it. See docs/playbooks/security.md.

import { describe, expect, it } from "vitest";

import { dashboardCsp } from "@/lib/security/csp";

// Pull a single directive's value out of the CSP string.
function directive(csp: string, name: string): string | undefined {
  return csp
    .split(";")
    .map((d) => d.trim())
    .find((d) => d.startsWith(`${name} `))
    ?.slice(name.length + 1);
}

describe("dashboardCsp", () => {
  const nonce = "abc123==";
  const csp = dashboardCsp(nonce);

  it("script-src carries the nonce + strict-dynamic and NO unsafe-inline", () => {
    const scriptSrc = directive(csp, "script-src")!;
    expect(scriptSrc).toContain(`'nonce-${nonce}'`);
    expect(scriptSrc).toContain("'strict-dynamic'");
    expect(scriptSrc).toContain("'self'");
    expect(scriptSrc).not.toContain("'unsafe-inline'");
  });

  it("style-src deliberately keeps unsafe-inline (React inline style attrs)", () => {
    expect(directive(csp, "style-src")).toContain("'unsafe-inline'");
  });

  it("locks down the framing + object + base directives", () => {
    expect(directive(csp, "frame-ancestors")).toBe("'none'");
    expect(directive(csp, "object-src")).toBe("'none'");
    expect(directive(csp, "base-uri")).toBe("'self'");
    expect(directive(csp, "form-action")).toBe("'self'");
  });

  it("connect-src is same-origin only when no Supabase URL is given", () => {
    expect(directive(csp, "connect-src")).toBe("'self'");
  });

  it("connect-src includes the Supabase https + wss origins for Realtime", () => {
    const withSupabase = dashboardCsp(nonce, { supabaseUrl: "https://abc.supabase.co" });
    const connectSrc = directive(withSupabase, "connect-src")!;
    expect(connectSrc).toContain("'self'");
    expect(connectSrc).toContain("https://abc.supabase.co");
    expect(connectSrc).toContain("wss://abc.supabase.co");
  });

  it("reports violations via both report-uri (legacy) and report-to (Reporting-API)", () => {
    expect(directive(csp, "report-uri")).toBe("/api/csp-report");
    expect(directive(csp, "report-to")).toBe("csp-endpoint");
  });

  it("interpolates a fresh nonce each call", () => {
    expect(dashboardCsp("AAAA")).toContain("'nonce-AAAA'");
    expect(dashboardCsp("BBBB")).toContain("'nonce-BBBB'");
    expect(dashboardCsp("AAAA")).not.toContain("'nonce-BBBB'");
  });
});
