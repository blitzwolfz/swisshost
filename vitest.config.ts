import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@swisshost/contracts": path.resolve(__dirname, "packages/contracts/src/index.ts"),
      "@swisshost/database": path.resolve(__dirname, "packages/database/src/index.ts"),
      "@swisshost/transit-core": path.resolve(__dirname, "packages/transit-core/src/index.ts"),
      "@swisshost/adapters": path.resolve(__dirname, "packages/adapters/src/index.ts"),
      "@swisshost/analytics": path.resolve(__dirname, "packages/analytics/src/index.ts"),
      "@swisshost/test-fixtures": path.resolve(__dirname, "packages/test-fixtures/src/index.ts"),
    },
  },
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
  },
});
