import { defineConfig } from "drizzle-kit";
import { config as loadEnv } from "dotenv";

// Match Next.js env-file precedence: .env.local overrides .env.
// Runs before defineConfig below reads process.env.
loadEnv({ path: ".env.local" });
loadEnv({ path: ".env" });

export default defineConfig({
  schema: "./lib/db/schema.ts",
  out: "./drizzle/migrations",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env["DATABASE_URL"] ?? "",
  },
  strict: true,
  verbose: true,
});
