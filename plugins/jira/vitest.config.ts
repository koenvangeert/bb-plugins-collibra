import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": new URL("./", import.meta.url).pathname,
      "better-sqlite3": new URL("./src/betterSqliteShim.ts", import.meta.url).pathname,
    },
  },
  test: {
    environment: "node",
    server: { deps: { inline: ["@get-bb/plugin-sdk"] } },
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
  },
});
