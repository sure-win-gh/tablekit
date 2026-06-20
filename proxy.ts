// Edge proxy: runs on every request that matches `config.matcher`.
//
// Next 16 renamed the `middleware` file convention to `proxy` with a
// deprecation warning on the old name. The exported function is named
// `proxy` to match the new convention.
//
// Three jobs:
//   1. Keep the Supabase session cookie fresh. Without the
//      getUser() call + cookie plumbing below, the sb-* cookies go
//      stale on idle and users get silently logged out.
//   2. Gate /dashboard/* behind an authenticated session.
//   3. Gate /admin/* behind the ADMIN_EMAILS allowlist (Tablekit-staff
//      only). Returns 404 to non-allowlisted users so the surface
//      stays unadvertised. Defense in depth: every (admin) server
//      component also calls requirePlatformAdmin().
//
// Matcher excludes static assets, the health endpoint, and the auth
// callback (which has its own server-side session exchange).

import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

import { dashboardCsp } from "@/lib/security/csp";
import { isPlatformAdminEmail } from "@/lib/server/admin/allowlist";

function notFound(): NextResponse {
  return new NextResponse(null, { status: 404 });
}

// Per-request CSP nonce. Edge-safe (Web Crypto + btoa; no node:crypto/Buffer).
function generateNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

export async function proxy(request: NextRequest) {
  // Nonce-based CSP for the authenticated app surfaces (/dashboard, /admin).
  // Set the nonce + the CSP on the *request* headers before the first
  // NextResponse.next({ request }) so Next stamps the nonce onto its framework
  // <script> tags; x-nonce lets app code nonce its own scripts (none today).
  // Mutating request.headers in place means the Supabase cookie block's own
  // NextResponse.next({ request }) calls forward them too. See
  // docs/playbooks/security.md (dashboard CSP) + lib/security/csp.ts.
  const pathname = request.nextUrl.pathname;
  const isAdminRoute = pathname.startsWith("/admin");
  const isAppSurface = pathname.startsWith("/dashboard") || isAdminRoute;

  const supabaseUrl = process.env["NEXT_PUBLIC_SUPABASE_URL"];
  const supabaseKey = process.env["NEXT_PUBLIC_SUPABASE_ANON_KEY"];

  let csp: string | null = null;
  if (isAppSurface) {
    const nonce = generateNonce();
    csp = dashboardCsp(nonce, supabaseUrl ? { supabaseUrl } : {});
    request.headers.set("x-nonce", nonce);
    request.headers.set("Content-Security-Policy", csp);
  }

  let response = NextResponse.next({ request });

  if (!supabaseUrl || !supabaseKey) {
    // /admin must fail closed even when env is misconfigured — losing
    // the gate to an env typo would be a worst-case outcome.
    if (isAdminRoute) return notFound();
    // Other routes: let through so the server can render its own
    // "requireEnv" error rather than silently 500ing from the edge.
    return response;
  }

  const supabase = createServerClient(supabaseUrl, supabaseKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        for (const { name, value } of cookiesToSet) {
          request.cookies.set(name, value);
        }
        response = NextResponse.next({ request });
        for (const { name, value, options } of cookiesToSet) {
          response.cookies.set(name, value, options);
        }
      },
    },
  });

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (isAdminRoute) {
    if (!user || !isPlatformAdminEmail(user.email)) return notFound();
  }

  if (!user && request.nextUrl.pathname.startsWith("/dashboard")) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.searchParams.set("next", request.nextUrl.pathname);
    return NextResponse.redirect(url);
  }

  // Apply the browser-enforced CSP to the rendered app-surface response.
  // Report-Only by default; CSP_DASHBOARD_ENFORCE=true flips to enforcing
  // (an env change after the soak — no code change, instantly reversible).
  // The early returns above (admin 404, dashboard→/login) render no scripts,
  // so they need no policy.
  if (csp) {
    const header =
      process.env["CSP_DASHBOARD_ENFORCE"] === "true"
        ? "Content-Security-Policy"
        : "Content-Security-Policy-Report-Only";
    response.headers.set(header, csp);
    // Declares the `report-to` group named in the policy → modern Chrome
    // delivers violations to /api/csp-report (which accepts the Reporting-API
    // format). report-uri remains the fallback for other browsers.
    response.headers.set("Reporting-Endpoints", 'csp-endpoint="/api/csp-report"');
  }

  return response;
}

export const config = {
  matcher: [
    // Run on everything except static assets, favicon, the health
    // endpoint, the auth callback (which mints the session and would
    // otherwise race with the session refresh here), and the Stripe
    // webhook (needs a pristine raw body for signature verification —
    // session-refresh middleware cookies would be fine but skipping
    // the matcher entirely keeps the critical path minimal).
    "/((?!_next/static|_next/image|favicon.ico|api/health|api/stripe/webhook|auth/callback).*)",
  ],
};
