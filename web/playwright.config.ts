import { defineConfig } from "@playwright/test";

// Run through `make e2e`: it clones the corpus database, starts the API and `next start`
// against the clone, runs this suite, then stops everything and drops the clone.
export default defineConfig({
  testDir: "./e2e",
  workers: 1,
  timeout: 180_000,
  reporter: "list",
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://127.0.0.1:3100",
    acceptDownloads: true,
    trace: "retain-on-failure",
  },
});
