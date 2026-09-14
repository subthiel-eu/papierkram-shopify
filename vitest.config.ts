import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    globals: true,
    environment: "node",
    include: ["tests/**/*.test.ts"],
    globalSetup: ["tests/setup/database.ts"],
    setupFiles: ["tests/setup/env.ts"],
    // Die Integrationstests teilen sich eine SQLite-Datei.
    fileParallelism: false,
  },
});
