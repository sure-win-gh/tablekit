// Integration test setup: load .env.local so DATABASE_URL and the
// Supabase keys are available. Runs before every integration test
// file (configured via tests/integration/vitest.config.ts).

import { config as loadEnv } from "dotenv";
import { resolve } from "node:path";

loadEnv({ path: resolve(process.cwd(), ".env.local") });
loadEnv({ path: resolve(process.cwd(), ".env") });
