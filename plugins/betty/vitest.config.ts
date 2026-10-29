import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    server: { deps: { inline: ["@get-bb/plugin-sdk"] } },
    include: ["src/**/*.test.ts"],
  },
});
