import { defineConfig } from "vitest/config";

// The full stack: base-anvil + Postgres + Ponder (`ponder start`) + API + keeper, end to end.
// Needs the dev Postgres (`pnpm dev:db`) and Base's Foundry build (~/.base-foundry/bin).
export default defineConfig({
  test: {
    include: ["test/e2e/**/*.e2e.ts"],
    globalSetup: ["test/e2e/setup.ts"],
    environment: "node",
    pool: "forks",
    fileParallelism: false,
    sequence: { concurrent: false },
    testTimeout: 240_000,
    hookTimeout: 600_000,
  },
});
