import { sql } from "drizzle-orm";
import { NextResponse } from "next/server";

import { anonymous } from "@/lib/db/client";
import { captureException } from "@/lib/observability/capture";
import { sendSlackAlert } from "@/lib/observability/slack";

// Readiness probe. An external uptime monitor (e.g. a Vercel cron or
// a third-party pinger) hits this on an interval; on failure it can
// page us, and this handler also fires a Slack alert itself so we
// hear about a dead database before a customer does.
//
// Liveness (is the process up?) is implicit — if Next can serve this
// route at all, the runtime is alive. The meaningful check is
// readiness: can we reach Postgres? We run a trivial `select 1`
// through the RLS-respecting anon client (no session needed, no data
// touched).

export const dynamic = "force-dynamic";

export async function GET() {
  const startedAt = Date.now();
  try {
    await anonymous(async (db) => {
      await db.execute(sql`select 1`);
    });

    return NextResponse.json({
      ok: true,
      service: "tablekit",
      checks: { database: "ok" },
      latencyMs: Date.now() - startedAt,
      ts: new Date().toISOString(),
    });
  } catch (error) {
    captureException(error, { route: "api/health", check: "database" });
    // Fire-and-forget Slack alert; don't let it delay the 503.
    void sendSlackAlert({
      title: "Health check failed",
      text: "The /api/health database check did not pass.",
      level: "critical",
      fields: { check: "database", latencyMs: Date.now() - startedAt },
    });

    // 503 so uptime monitors register the failure. No error detail in
    // the body — a probe doesn't need internals and neither does a
    // malicious caller.
    return NextResponse.json(
      {
        ok: false,
        service: "tablekit",
        checks: { database: "fail" },
        ts: new Date().toISOString(),
      },
      { status: 503 },
    );
  }
}
