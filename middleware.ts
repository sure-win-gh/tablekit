// Edge middleware for the /admin (Tablekit-staff) dashboard.
//
// Defense in depth: every page under app/(admin) also calls
// requirePlatformAdmin() in its server component. This middleware
// catches the request earlier — at the edge, before the (admin)
// route group renders — and returns 404 (not 403/redirect) for
// non-allowlisted users. Returning 404 hides the existence of the
// admin surface from the public; allowlisted users see the page.
//
// The matcher below scopes this middleware to /admin/* only —
// operator, widget, marketing routes never see it.
//
// Note on cookies: the @supabase/ssr middleware adapter rewrites the
// request and response cookies in lockstep so a refreshed session
// cookie set by getUser() is available to the downstream handler.

import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

import { isPlatformAdminEmail } from "@/lib/server/admin/allowlist";

function notFound(): NextResponse {
  // Render the standard Next.js 404 page rather than redirecting —
  // we don't want to advertise that /admin exists to non-staff.
  return new NextResponse(null, { status: 404 });
}

export async function middleware(request: NextRequest) {
  let response = NextResponse.next({ request });

  const url = process.env["NEXT_PUBLIC_SUPABASE_URL"];
  const anon = process.env["NEXT_PUBLIC_SUPABASE_ANON_KEY"];
  if (!url || !anon) {
    // Fail closed: misconfigured environment must not silently allow
    // the admin surface through.
    return notFound();
  }

  const supabase = createServerClient(url, anon, {
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll: (cookiesToSet) => {
        cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
        response = NextResponse.next({ request });
        cookiesToSet.forEach(({ name, value, options }) =>
          response.cookies.set(name, value, options),
        );
      },
    },
  });

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) return notFound();
  if (!isPlatformAdminEmail(user.email)) return notFound();

  return response;
}

export const config = {
  matcher: ["/admin/:path*"],
};
