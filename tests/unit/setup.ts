// Unit-test setup: load .env.local so secret-dependent modules (the
// crypto master key, etc.) can read their env. Unit tests that don't
// care about env are unaffected — loading is a no-op when .env.local
// is absent.

import { config as loadEnv } from "dotenv";
import { resolve } from "node:path";

loadEnv({ path: resolve(process.cwd(), ".env.local") });
loadEnv({ path: resolve(process.cwd(), ".env") });

// CI doesn't ship .env.local, so unit tests that touch the crypto
// master key would crash with "TABLEKIT_MASTER_KEY is not set".
// Default to a deterministic 32-byte test key when nothing else
// provided one. Local dev is unaffected — .env.local always wins.
// The unit tests using hashForLookup only need a stable key, not a
// real one, since they assert determinism / shape rather than
// security against a known plaintext.
if (!process.env["TABLEKIT_MASTER_KEY"]) {
  process.env["TABLEKIT_MASTER_KEY"] = Buffer.from(new Uint8Array(32).fill(7)).toString("base64");
}
