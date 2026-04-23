import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/integration/**/*.test.ts"],
    exclude: ["node_modules", ".next"],
    setupFiles: ["tests/integration/setup.ts"],
    globals: false,
    clearMocks: true,
    // Integration tests hit a real database — don't let a second test
    // file interleave users/orgs with the first.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
  resolve: {
    alias: {
      "@": resolve(__dirname, "../.."),
      // `server-only` errors in non-server-component contexts. Vitest
      // isn't bundling for the browser, so shim it with an empty
      // module instead.
      "server-only": resolve(__dirname, "./server-only-shim.ts"),
    },
  },
});
