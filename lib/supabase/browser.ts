// Browser Supabase client — for client components that need Realtime.
//
// Uses the anon key + the cookie session (via @supabase/ssr) so Realtime
// authorizes with the signed-in user's JWT and the same RLS policies that
// guard our REST reads also gate the websocket stream. A singleton per tab
// so we don't open a socket per component.

"use client";

import { createBrowserClient } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";

let _client: SupabaseClient | null = null;

export function createBrowserSupabase(): SupabaseClient {
  if (_client) return _client;
  const url = process.env["NEXT_PUBLIC_SUPABASE_URL"];
  const anonKey = process.env["NEXT_PUBLIC_SUPABASE_ANON_KEY"];
  if (!url || !anonKey) {
    throw new Error("lib/supabase/browser.ts: NEXT_PUBLIC_SUPABASE_URL / _ANON_KEY not set");
  }
  _client = createBrowserClient(url, anonKey);
  return _client;
}
