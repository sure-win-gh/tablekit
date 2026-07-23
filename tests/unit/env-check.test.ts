import { describe, expect, it } from "vitest";

import {
  REQUIRED_ALWAYS,
  REQUIRED_PRODUCTION,
  isPlaceholder,
  isProdLike,
  missingRequiredEnv,
  type Env,
} from "../../lib/env-check";
import { documentedNames, undocumentedNames } from "../../scripts/check-env-parity";

function fullEnv(): Env {
  const env: Record<string, string> = {};
  for (const name of [...REQUIRED_ALWAYS, ...REQUIRED_PRODUCTION]) {
    env[name] = "real-value";
  }
  return env;
}

describe("missingRequiredEnv", () => {
  it("passes when everything is set", () => {
    expect(missingRequiredEnv(fullEnv(), { prodLike: true })).toEqual([]);
  });

  it("flags a missing base-tier variable in every mode", () => {
    const env = fullEnv();
    delete env["DATABASE_URL"];
    expect(missingRequiredEnv(env, { prodLike: false })).toEqual(["DATABASE_URL"]);
    expect(missingRequiredEnv(env, { prodLike: true })).toEqual(["DATABASE_URL"]);
  });

  it("flags production-tier variables only in prod-like mode", () => {
    const env = fullEnv();
    delete env["STRIPE_SECRET_KEY"];
    expect(missingRequiredEnv(env, { prodLike: false })).toEqual([]);
    expect(missingRequiredEnv(env, { prodLike: true })).toEqual(["STRIPE_SECRET_KEY"]);
  });

  it("treats placeholder values as unset", () => {
    const env = fullEnv();
    env["SESSION_SIGNING_SECRET"] = "changeme_generate_48_random_bytes_base64";
    env["STRIPE_SECRET_KEY"] = "sk_test_YOUR_STRIPE_SECRET_KEY";
    expect(missingRequiredEnv(env, { prodLike: true })).toEqual([
      "SESSION_SIGNING_SECRET",
      "STRIPE_SECRET_KEY",
    ]);
  });

  it("treats empty strings as unset", () => {
    const env = fullEnv();
    env["TABLEKIT_MASTER_KEY"] = "";
    expect(missingRequiredEnv(env, { prodLike: false })).toEqual(["TABLEKIT_MASTER_KEY"]);
  });
});

describe("isPlaceholder", () => {
  it("matches the repo's sentinel shapes", () => {
    expect(isPlaceholder("sk_test_YOUR_STRIPE_SECRET_KEY")).toBe(true);
    expect(isPlaceholder("changeme_reserve_with_google_shared_secret")).toBe(true);
    expect(isPlaceholder("sk_live_abc123")).toBe(false);
  });
});

describe("isProdLike", () => {
  it("is true only for Vercel production or explicit staging", () => {
    expect(isProdLike({ VERCEL_ENV: "production" })).toBe(true);
    expect(isProdLike({ TABLEKIT_ENV: "staging", VERCEL_ENV: "preview" })).toBe(true);
    expect(isProdLike({ VERCEL_ENV: "preview" })).toBe(false);
    // NODE_ENV=production alone (local `pnpm start`, CI e2e) must NOT
    // trigger the production tier.
    expect(isProdLike({ NODE_ENV: "production" })).toBe(false);
    expect(isProdLike({})).toBe(false);
  });
});

describe("example-file drift helpers", () => {
  const example = [
    "# comment line, not a name",
    'NEXT_PUBLIC_APP_URL="http://localhost:3000"',
    '# DATABASE_URL_EU=""',
    "  STRIPE_SECRET_KEY=sk_test_x",
  ].join("\n");

  it("collects documented names, including commented ones", () => {
    const names = documentedNames(example);
    expect(names.has("NEXT_PUBLIC_APP_URL")).toBe(true);
    expect(names.has("DATABASE_URL_EU")).toBe(true);
    expect(names.has("STRIPE_SECRET_KEY")).toBe(true);
    expect(names.has("comment")).toBe(false);
  });

  it("reports ours-shaped names that are set but undocumented, ignoring others", () => {
    const documented = documentedNames(example);
    const env: Env = {
      STRIPE_SECRET_KEY: "sk_test_x", // documented
      STRIPE_SECRETKEY: "typo", // ours + undocumented → reported
      PATH: "/usr/bin", // not ours → ignored
      VERCEL_ENV: "production", // not ours → ignored
    };
    expect(undocumentedNames(env, documented)).toEqual(["STRIPE_SECRETKEY"]);
  });
});
