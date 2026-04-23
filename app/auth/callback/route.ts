// Supabase PKCE callback.
//
// Hit by the user's browser after clicking the email-confirm link or a
// magic link. We exchange the one-time code for a session, which sets
// the sb-* cookies via the SSR client's cookie adapter, then redirect
// on to the requested landing page.

import { NextResponse, type NextRequest } from "next/server";

import { supabaseServer } from "@/lib/db/supabase-server";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  const next = searchParams.get("next") ?? "/dashboard";

  // Prevent open-redirect: only allow same-origin relative paths.
  const safeNext = next.startsWith("/") && !next.startsWith("//") ? next : "/dashboard";

  if (!code) {
    return NextResponse.redirect(`${origin}/login?error=missing_code`);
  }

  const supabase = await supabaseServer();
  const { error } = await supabase.auth.exchangeCodeForSession(code);

  if (error) {
    return NextResponse.redirect(`${origin}/login?error=invalid_code`);
  }

  return NextResponse.redirect(`${origin}${safeNext}`);
}
