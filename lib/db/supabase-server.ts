// Supabase client bound to the current request's cookie session.
//
// Used by Server Components, Server Actions, and Route Handlers that
// need to read/refresh the authenticated user. For mutations into our
// own domain tables, use lib/db/client.ts:withUser — this client is
// for auth ops (sign up / sign in / get user).
//
// Next 16's cookies() is async — await it before passing to the
// Supabase adapter.

import "server-only";

import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `lib/db/supabase-server.ts: ${name} is not set. See .env.local.example.`,
    );
  }
  return value;
}

export async function supabaseServer() {
  const cookieStore = await cookies();

  return createServerClient(
    requireEnv("NEXT_PUBLIC_SUPABASE_URL"),
    requireEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY"),
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          // In Server Components, cookieStore.set throws. The
          // middleware refreshes sessions so this is safe to swallow —
          // Supabase's own docs recommend exactly this pattern.
          try {
            for (const { name, value, options } of cookiesToSet) {
              cookieStore.set({ name, value, ...options });
            }
          } catch {
            // Called from a Server Component — session refresh
            // happens via middleware instead.
          }
        },
      },
    },
  );
}
