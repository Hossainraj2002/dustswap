import { defineConfig } from "vitest/config";

// Loopback-only Postgres; the fixture creates and removes its own random test database.
export default defineConfig({ test: { include: ["test/integration/platform-token.test.ts"], environment: "node",
  fileParallelism: false, testTimeout: 30_000, hookTimeout: 30_000 } });
