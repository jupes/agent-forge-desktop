import { defineConfig } from "@playwright/test";

const url = "http://127.0.0.1:18829";

export default defineConfig({
  testDir: "tests/lite-e2e",
  outputDir: "test-results/lite",
  forbidOnly: Boolean(process.env.CI),
  workers: 1,
  timeout: 30_000,
  use: {
    baseURL: url,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "desktop",
      use: { colorScheme: "dark", viewport: { width: 1440, height: 900 } },
    },
    {
      name: "narrow",
      use: { colorScheme: "light", viewport: { width: 390, height: 844 } },
    },
  ],
  webServer: {
    command:
      "bun run lite:web:build && node node_modules/vite/bin/vite.js preview apps/lite --outDir dist --host 127.0.0.1 --port 18829 --strictPort",
    url,
    reuseExistingServer: false,
    timeout: 90_000,
  },
});
