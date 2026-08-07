import { describe, expect, it } from "vitest";

import {
  checkStagingTarget,
  hostOnly,
  parseProjectRef,
  refFromArgv,
} from "../../scripts/seed/staging-guard";

const STAGING = "rkqdbfzouzcqpgsggsuf";
const CI = "mqbfzbeyefvqyvpqaaha";

const poolerUrl = (ref: string) =>
  `postgresql://postgres.${ref}:pw%24word@aws-1-eu-west-2.pooler.supabase.com:5432/postgres`;
const directUrl = (ref: string) => `postgresql://postgres:pw@db.${ref}.supabase.co:5432/postgres`;
const supabaseUrl = (ref: string) => `https://${ref}.supabase.co`;

describe("parseProjectRef", () => {
  it("reads the ref from a session-pooler username (postgres.<ref>)", () => {
    expect(parseProjectRef(poolerUrl(STAGING))).toBe(STAGING);
  });

  it("reads the ref from a direct-connection host (db.<ref>.supabase.co)", () => {
    expect(parseProjectRef(directUrl(STAGING))).toBe(STAGING);
  });

  it("reads the ref from a Supabase base URL", () => {
    expect(parseProjectRef(supabaseUrl(STAGING))).toBe(STAGING);
  });

  it("is not fooled by a password containing a dollar sign", () => {
    // The username, not the password, carries the ref.
    expect(parseProjectRef(poolerUrl(STAGING))).toBe(STAGING);
  });

  it("returns null for a non-Supabase / unparseable target", () => {
    expect(parseProjectRef("postgresql://postgres:pw@localhost:5432/postgres")).toBeNull();
    expect(parseProjectRef("not a url")).toBeNull();
    expect(parseProjectRef(undefined)).toBeNull();
  });
});

describe("checkStagingTarget", () => {
  it("passes when both DB and Supabase URLs resolve to the expected ref", () => {
    const r = checkStagingTarget({
      databaseUrl: poolerUrl(STAGING),
      supabaseUrl: supabaseUrl(STAGING),
      expectedRef: STAGING,
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.ref).toBe(STAGING);
  });

  it("refuses when the DB URL targets a different project (e.g. CI)", () => {
    const r = checkStagingTarget({
      databaseUrl: poolerUrl(CI),
      supabaseUrl: supabaseUrl(STAGING),
      expectedRef: STAGING,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/database URL targets project 'mqbf/);
  });

  it("refuses when the Supabase URL targets a different project than the DB", () => {
    const r = checkStagingTarget({
      databaseUrl: poolerUrl(STAGING),
      supabaseUrl: supabaseUrl(CI),
      expectedRef: STAGING,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/NEXT_PUBLIC_SUPABASE_URL targets project/);
  });

  it("refuses when the expected ref is not supplied", () => {
    const r = checkStagingTarget({
      databaseUrl: poolerUrl(STAGING),
      supabaseUrl: supabaseUrl(STAGING),
      expectedRef: undefined,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/STAGING_PROJECT_REF/);
  });

  it("refuses an unrecognisable database URL rather than guessing", () => {
    const r = checkStagingTarget({
      databaseUrl: "postgresql://postgres:pw@localhost:5432/postgres",
      supabaseUrl: supabaseUrl(STAGING),
      expectedRef: STAGING,
    });
    expect(r.ok).toBe(false);
  });

  it("is case-insensitive on the declared ref", () => {
    const r = checkStagingTarget({
      databaseUrl: poolerUrl(STAGING),
      supabaseUrl: supabaseUrl(STAGING),
      expectedRef: STAGING.toUpperCase(),
    });
    expect(r.ok).toBe(true);
  });
});

describe("hostOnly", () => {
  it("returns host without credentials", () => {
    expect(hostOnly(poolerUrl(STAGING))).toBe("aws-1-eu-west-2.pooler.supabase.com:5432");
    expect(hostOnly(undefined)).toBe("<unset>");
    expect(hostOnly("garbage")).toBe("<unparseable>");
  });
});

describe("refFromArgv", () => {
  it("reads --ref <value> and --ref=<value>", () => {
    expect(refFromArgv(["node", "seed", "--ref", STAGING])).toBe(STAGING);
    expect(refFromArgv(["node", "seed", `--ref=${STAGING}`])).toBe(STAGING);
    expect(refFromArgv(["node", "seed"])).toBeUndefined();
  });
});
