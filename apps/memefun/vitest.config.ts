import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    include: ["src/**/*.test.{ts,tsx}"],
    // *.local.test.ts need a local chain: pnpm test:local.
    exclude: ["src/**/*.local.test.ts", "node_modules/**"],
    // Component tests opt into the DOM with a `@vitest-environment jsdom` docblock.
    environment: "node",
  },
});
