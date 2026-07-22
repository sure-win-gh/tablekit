import { describe, expect, it } from "vitest";

import { scanSql, statementsOf } from "../../scripts/check-migration-safety";

describe("scanSql — unsafe statements", () => {
  it("flags DROP TABLE", () => {
    const f = scanSql(`DROP TABLE "bookings";`);
    expect(f.map((x) => x.rule)).toContain("drop-table");
  });

  it("flags DROP COLUMN", () => {
    const f = scanSql(`ALTER TABLE "bookings" DROP COLUMN "legacy_ref";`);
    expect(f.map((x) => x.rule)).toContain("drop-column");
  });

  it("flags RENAME COLUMN", () => {
    const f = scanSql(`ALTER TABLE "guests" RENAME COLUMN "surname" TO "last_name";`);
    expect(f.map((x) => x.rule)).toContain("rename-column");
  });

  it("flags RENAME TABLE", () => {
    const f = scanSql(`ALTER TABLE "orgs" RENAME TO "organisations";`);
    expect(f.map((x) => x.rule)).toContain("rename-table");
  });

  it("flags SET NOT NULL", () => {
    const f = scanSql(`ALTER TABLE "bookings" ALTER COLUMN "venue_id" SET NOT NULL;`);
    expect(f.map((x) => x.rule)).toContain("set-not-null");
  });

  it("flags ADD COLUMN NOT NULL without a default", () => {
    const f = scanSql(`ALTER TABLE "bookings" ADD COLUMN "party_size" integer NOT NULL;`);
    expect(f.map((x) => x.rule)).toContain("add-not-null-no-default");
  });
});

describe("scanSql — safe statements pass", () => {
  it("allows a nullable ADD COLUMN", () => {
    expect(scanSql(`ALTER TABLE "organisations" ADD COLUMN "wrapped_dek" "bytea";`)).toHaveLength(
      0,
    );
  });

  it("allows ADD COLUMN NOT NULL WITH a default (metadata-only, back-compat)", () => {
    expect(
      scanSql(`ALTER TABLE "organisations" ADD COLUMN "dek_version" integer DEFAULT 1 NOT NULL;`),
    ).toHaveLength(0);
  });

  it("allows DROP NOT NULL (loosening is safe)", () => {
    expect(scanSql(`ALTER TABLE "bookings" ALTER COLUMN "area_id" DROP NOT NULL;`)).toHaveLength(0);
  });

  it("allows DROP DEFAULT and DROP CONSTRAINT", () => {
    expect(scanSql(`ALTER TABLE "bookings" ALTER COLUMN "status" DROP DEFAULT;`)).toHaveLength(0);
    expect(scanSql(`ALTER TABLE "bookings" DROP CONSTRAINT "bookings_pkey";`)).toHaveLength(0);
  });

  it("allows CREATE TABLE / CREATE INDEX", () => {
    expect(
      scanSql(`CREATE TABLE "areas" ("id" uuid PRIMARY KEY, "name" text NOT NULL);`),
    ).toHaveLength(0);
  });
});

describe("scanSql — noise handling", () => {
  it("ignores keywords inside comments", () => {
    expect(scanSql(`-- we used to DROP TABLE here\nCREATE TABLE "x" ("id" uuid);`)).toHaveLength(0);
  });

  it("ignores keywords inside dollar-quoted function bodies", () => {
    const trigger = `CREATE OR REPLACE FUNCTION f() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        -- DROP COLUMN mentioned in a body must not trip the linter
        RETURN NEW;
      END;
      $$;`;
    expect(scanSql(trigger)).toHaveLength(0);
  });

  it("splits on statement boundaries", () => {
    const sql = `CREATE TABLE "a" ("id" uuid);--> statement-breakpoint
      ALTER TABLE "a" DROP COLUMN "b";`;
    expect(statementsOf(sql).length).toBe(2);
    expect(scanSql(sql).map((x) => x.rule)).toEqual(["drop-column"]);
  });
});
