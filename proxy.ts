// Edge proxy: runs on every request that matches `config.matcher`.
//
// Next 16 renamed the `middleware` file convention to `proxy` with a
// deprecation warning on the old name. The exported function is named
// `proxy` to match the new convention.
//
// Two jobs:
//   1. Keep the Supabase session cookie fresh. Without the
//      getUser() call + cookie plumbing below, the sb-* cookies go
//      stale on idle and users get silently logged out.
//   2. Gate /dashboard/* behind an authenticated session.
//
// Matcher excludes static assets, the health endpoint, and the auth
// callback (which has its own server-side session exchange).

import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

export async function proxy(request: NextRequest) {
  let response = NextResponse.next({ request });

  const supabaseUrl = process.env["NEXT_PUBLIC_SUPABASE_URL"];
  const supabaseKey = process.env["NEXT_PUBLIC_SUPABASE_ANON_KEY"];
  if (!supabaseUrl || !supabaseKey) {
    // Misconfigured env — let the request through so the server can
    // render its own "requireEnv" error rather than silently 500ing
    // from the edge (which is harder to debug).
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
    // endpoint, and the auth callback (which mints the session and
    // would otherwise race with the session refresh here).
    "/((?!_next/static|_next/image|favicon.ico|api/health|auth/callback).*)",
  ],
};
