import { defineConfig } from "vitest/config";

// Unit tests: pure functions and HTTP handlers with in-memory fakes. No chain, no Postgres.
// The full stack (base-anvil + Postgres + Ponder + keeper) runs under vitest.e2e.config.ts.
export default defineConfig({
  test: {
    include: ["test/unit/**/*.test.ts"],
    environment: "node",
    testTimeout: 20_000,
  },
});
