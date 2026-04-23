// Drizzle clients for the app.
//
// Three flavours, each for a different audience:
//
//   withUser(fn)    — authed, RLS-respecting. The session's JWT
//                     claims are set on the Postgres transaction so
//                     policies against auth.uid() / auth.jwt() resolve
//                     to the caller. Use this for every authed query.
//
//   anonymous(fn)   — public / unauthed, RLS still applies under the
//                     `anon` role. Use for public widget endpoints
//                     and any route handler without a session.
//
//   adminDb is NOT exported from here — it lives under
//   lib/server/admin/db.ts and BYPASSES RLS. Importing it outside of
//   lib/server/admin/** is flagged by the code-reviewer subagent.
//
// The pattern is a per-request transaction that SET LOCAL configures
// role + JWT claims. Supabase's own auth.uid() helper reads these
// settings, so every RLS policy written against auth.uid() works
// without change. ~1 extra ms per request on the session pooler.

import "server-only";

import { sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import * as schema from "./schema";
import { supabaseServer } from "./supabase-server";

type Db = NodePgDatabase<typeof schema>;

let _pool: Pool | null = null;

function pool(): Pool {
  if (_pool) return _pool;
  const connectionString = process.env["DATABASE_URL"];
  if (!connectionString) {
    throw new Error(
      "lib/db/client.ts: DATABASE_URL is not set. See .env.local.example — use the Session pooler URL.",
    );
  }
  _pool = new Pool({ connectionString, max: 10 });
  return _pool;
}

function drizzleClient(): Db {
  return drizzle(pool(), { schema });
}

// Sets role + JWT claim settings on the current transaction so
// Supabase's auth.uid() / auth.jwt() resolve to the caller.
async function setRlsContext(
  tx: Db,
  role: "authenticated" | "anon",
  userId: string | null,
): Promise<void> {
  await tx.execute(sql`select set_config('role', ${role}, true)`);
  if (userId) {
    const claims = JSON.stringify({ sub: userId, role });
    await tx.execute(sql`select set_config('request.jwt.claims', ${claims}, true)`);
    await tx.execute(sql`select set_config('request.jwt.claim.sub', ${userId}, true)`);
  }
}

/**
 * Run `fn` as the current Supabase-authenticated user, with RLS
 * enforcement. Throws if there is no session — callers must handle
 * the unauthenticated case before calling this (usually via
 * middleware redirect to /login).
 */
export async function withUser<T>(fn: (db: Db) => Promise<T>): Promise<T> {
  const supabase = await supabaseServer();
  const {
    data: { user },
    error,
  } = await supabase.auth.getUser();

  if (error || !user) {
    throw new Error("withUser: no authenticated session");
  }

  const db = drizzleClient();
  return db.transaction(async (tx) => {
    await setRlsContext(tx, "authenticated", user.id);
    return fn(tx);
  });
}

/**
 * Run `fn` as an unauthenticated caller (Postgres `anon` role). RLS
 * policies that allow `anon` still apply; policies scoped to
 * `authenticated` do not match.
 */
export async function anonymous<T>(fn: (db: Db) => Promise<T>): Promise<T> {
  const db = drizzleClient();
  return db.transaction(async (tx) => {
    await setRlsContext(tx, "anon", null);
    return fn(tx);
  });
}
