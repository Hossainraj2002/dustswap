import { defineConfig } from "vitest/config";

// Postgres only: creates and removes its own random database on loopback, with public test credentials.
export default defineConfig({
  test: {
    include: ["test/integration/upload-quota.test.ts"],
    environment: "node",
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
