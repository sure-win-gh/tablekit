// The property that lets staging and production share ONE Upstash database
// without sharing buckets: the same bucket name under two environments must
// produce two different keys.

import { describe, expect, it } from "vitest";

import { rlKeyPrefix } from "@/lib/public/rate-limit";

describe("rlKeyPrefix — env keyspace namespacing", () => {
  it("gives the same bucket two different keys under two different envs", () => {
    const stagingPrefix = rlKeyPrefix({ TABLEKIT_ENV: "staging" });
    const prodPrefix = rlKeyPrefix({ VERCEL_ENV: "production" });

    expect(stagingPrefix).not.toBe(prodPrefix);
    expect(`${stagingPrefix}login:ip:1.2.3.4`).not.toBe(`${prodPrefix}login:ip:1.2.3.4`);
  });

  it("prefers TABLEKIT_ENV, then VERCEL_ENV, then 'dev'", () => {
    expect(rlKeyPrefix({ TABLEKIT_ENV: "staging", VERCEL_ENV: "production" })).toBe("rl:staging:");
    expect(rlKeyPrefix({ VERCEL_ENV: "production" })).toBe("rl:production:");
    expect(rlKeyPrefix({})).toBe("rl:dev:");
  });
});
