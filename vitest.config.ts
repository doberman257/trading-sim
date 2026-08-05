import { defaultExclude, defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: {
    environment: "node",
    passWithNoTests: true,
    // lib/db tests need a real Postgres and run separately via
    // `npm run test:integration` (see vitest.integration.config.ts). They
    // must stay out of the default run so `npm run verify` - and the
    // PostToolUse hook that fires it after every edit - never depends on a
    // database being reachable.
    exclude: [...defaultExclude, "lib/db/**"],
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./"),
      // See vitest.server-only-shim.ts for why this alias exists.
      "server-only": path.resolve(__dirname, "./vitest.server-only-shim.ts"),
    },
  },
});
