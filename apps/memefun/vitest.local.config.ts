import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

/** Tests against a local memefun chain (`pnpm dev:chain` in apps/memefun-backend). */
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    include: ["src/**/*.local.test.ts"],
    environment: "node",
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // One chain, one wallet: the steps build on each other.
    sequence: { concurrent: false },
    fileParallelism: false,
  },
});
