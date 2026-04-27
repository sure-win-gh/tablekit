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

import { isPlatformAdminEmail } from "@/lib/server/admin/allowlist";

function notFound(): NextResponse {
  return new NextResponse(null, { status: 404 });
}

export async function proxy(request: NextRequest) {
  let response = NextResponse.next({ request });

  const isAdminRoute = request.nextUrl.pathname.startsWith("/admin");

  const supabaseUrl = process.env["NEXT_PUBLIC_SUPABASE_URL"];
  const supabaseKey = process.env["NEXT_PUBLIC_SUPABASE_ANON_KEY"];
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
