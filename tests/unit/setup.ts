// Unit-test setup: load .env.local so secret-dependent modules (the
// crypto master key, etc.) can read their env. Unit tests that don't
// care about env are unaffected — loading is a no-op when .env.local
// is absent.

import { config as loadEnv } from "dotenv";
import { resolve } from "node:path";

loadEnv({ path: resolve(process.cwd(), ".env.local") });
loadEnv({ path: resolve(process.cwd(), ".env") });
