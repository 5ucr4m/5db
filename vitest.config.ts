import { defineConfig } from "vitest/config";

// Only the pure logic in src/lib; e2e/ belongs to Playwright.
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
  },
});
