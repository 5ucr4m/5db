import { defineConfig } from "@playwright/test";

// Runs the UI in Chromium against the dev bridge, which talks to the docker
// fixtures (`pnpm db:up`). The bridge gets a throwaway data directory.
export default defineConfig({
  testDir: "e2e",
  globalSetup: "./e2e/global-setup.ts",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: "http://localhost:1420",
    viewport: { width: 1440, height: 900 },
    colorScheme: "dark",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "chromium", use: { browserName: "chromium" } },
    // WKWebView, which Tauri uses on macOS, is WebKit.
    { name: "webkit", use: { browserName: "webkit" } },
  ],
  webServer: [
    {
      command: "pnpm bridge",
      url: "http://127.0.0.1:1430/rpc",
      reuseExistingServer: true,
      timeout: 300_000,
      env: { FIVEDB_DATA_DIR: ".e2e-data" },
    },
    { command: "pnpm dev", url: "http://localhost:1420", reuseExistingServer: true },
  ],
});
