import { defineConfig } from "vitest/config";

// Loopback-only Postgres. The suite creates and removes its own fresh random database.
export default defineConfig({ test: { include: ["test/integration/launch-campaign.test.ts"], environment: "node",
  fileParallelism: false, testTimeout: 30_000, hookTimeout: 30_000 } });
