import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["lib/db/**/*.test.ts"],
    setupFiles: ["./vitest.integration.setup.ts"],
    // All tests share one database; running files concurrently would let
    // one file's truncate wipe another's fixtures mid-test.
    fileParallelism: false,
    testTimeout: 15_000,
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./"),
      // See vitest.server-only-shim.ts for why this alias exists.
      "server-only": path.resolve(__dirname, "./vitest.server-only-shim.ts"),
    },
  },
});
