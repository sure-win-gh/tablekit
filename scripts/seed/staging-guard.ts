// Safety guard for the staging seeder. Pure and dependency-free so it can be
// unit-tested and, crucially, evaluated BEFORE any database connection is
// opened — the whole point is that it is impossible to point the seeder at
// production (or the CI project, or a developer's local DB) by accident.
//
// A Supabase project is identified by its ref. Depending on the connection
// string shape the ref lives in different places:
//   - session/transaction pooler:  postgresql://postgres.<ref>:pw@aws-…pooler.supabase.com
//     → ref is in the USERNAME (`postgres.<ref>`), not the host.
//   - direct connection:           postgresql://postgres:pw@db.<ref>.supabase.co
//     → ref is the first host label after `db.`.
//   - Supabase REST/base URL:      https://<ref>.supabase.co
//     → ref is the first host label.
// so a naive "host contains the ref" check fails for pooler URLs (the common
// case). parseProjectRef handles all three.

export type StagingCheckInput = {
  /** The effective Postgres URL the seeder will connect to (DATABASE_URL_EU ?? DATABASE_URL). */
  databaseUrl: string | undefined;
  /** The Supabase project URL used for the admin auth API (NEXT_PUBLIC_SUPABASE_URL). */
  supabaseUrl: string | undefined;
  /** The ref the operator has declared as staging (STAGING_PROJECT_REF or --ref). */
  expectedRef: string | undefined;
};

export type StagingCheckResult =
  | { ok: true; ref: string; databaseHost: string; supabaseHost: string }
  | { ok: false; reason: string };

/**
 * Extract the Supabase project ref from a Postgres connection string or a
 * Supabase https URL. Returns null when no ref can be identified — callers
 * treat null as "not a recognisable Supabase target", i.e. refuse.
 */
export function parseProjectRef(connectionOrUrl: string | undefined): string | null {
  if (!connectionOrUrl) return null;
  let url: URL;
  try {
    url = new URL(connectionOrUrl);
  } catch {
    return null;
  }

  // Pooler: username is `postgres.<ref>`.
  const user = decodeURIComponent(url.username);
  const dotted = user.match(/^postgres\.([a-z0-9]{16,})$/i);
  if (dotted) return dotted[1]!.toLowerCase();

  // Direct DB host: `db.<ref>.supabase.co`.
  const dbHost = url.hostname.match(/^db\.([a-z0-9]{16,})\.supabase\.(co|com|net)$/i);
  if (dbHost) return dbHost[1]!.toLowerCase();

  // Supabase base/REST URL: `<ref>.supabase.co`.
  const baseHost = url.hostname.match(/^([a-z0-9]{16,})\.supabase\.(co|com|net)$/i);
  if (baseHost) return baseHost[1]!.toLowerCase();

  return null;
}

/** Host only — never the credentials — for safe logging. */
export function hostOnly(connectionOrUrl: string | undefined): string {
  if (!connectionOrUrl) return "<unset>";
  try {
    return new URL(connectionOrUrl).host;
  } catch {
    return "<unparseable>";
  }
}

/**
 * Decide whether it is safe to seed. Every target the seeder will touch — the
 * database it writes to AND the Supabase project it creates auth users in —
 * must resolve to the same, operator-declared staging ref. Any mismatch,
 * missing value, or unrecognisable target refuses.
 */
export function checkStagingTarget(input: StagingCheckInput): StagingCheckResult {
  const expected = input.expectedRef?.trim().toLowerCase();
  if (!expected) {
    return {
      ok: false,
      reason: "STAGING_PROJECT_REF is not set (pass it in the env or as --ref <ref>).",
    };
  }

  const dbRef = parseProjectRef(input.databaseUrl);
  if (!dbRef) {
    return {
      ok: false,
      reason: `could not read a Supabase project ref from the database URL (host ${hostOnly(
        input.databaseUrl,
      )}).`,
    };
  }
  if (dbRef !== expected) {
    return {
      ok: false,
      reason: `database URL targets project '${dbRef}', not the declared staging project '${expected}'. Refusing.`,
    };
  }

  const supaRef = parseProjectRef(input.supabaseUrl);
  if (!supaRef) {
    return {
      ok: false,
      reason: `could not read a Supabase project ref from NEXT_PUBLIC_SUPABASE_URL (host ${hostOnly(
        input.supabaseUrl,
      )}).`,
    };
  }
  if (supaRef !== expected) {
    return {
      ok: false,
      reason: `NEXT_PUBLIC_SUPABASE_URL targets project '${supaRef}', not the declared staging project '${expected}'. Auth users would land in the wrong project. Refusing.`,
    };
  }

  return {
    ok: true,
    ref: expected,
    databaseHost: hostOnly(input.databaseUrl),
    supabaseHost: hostOnly(input.supabaseUrl),
  };
}

/** `--ref <value>` or `--ref=<value>` from argv, if present. */
export function refFromArgv(argv: readonly string[]): string | undefined {
  const eq = argv.find((a) => a.startsWith("--ref="));
  if (eq) return eq.slice("--ref=".length);
  const i = argv.indexOf("--ref");
  if (i !== -1 && argv[i + 1]) return argv[i + 1];
  return undefined;
}
