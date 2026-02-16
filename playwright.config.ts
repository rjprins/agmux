import { defineConfig } from "@playwright/test";

const appPort = Number(process.env.E2E_APP_PORT ?? 4931);
const appUrl = `http://127.0.0.1:${appPort}`;
const dbPath = process.env.E2E_DB_PATH ?? "/tmp/agent-tide-e2e.db";

export default defineConfig({
  testDir: "e2e",
  timeout: 60_000,
  retries: 0,
  use: {
    baseURL: appUrl,
    browserName: "chromium",
    launchOptions: {
      // Avoid Playwright browser downloads; use system Chromium.
      executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH ?? "/usr/bin/chromium",
    },
  },
  webServer: {
    command: `AGENT_TIDE_SHELL=bash AGENT_TIDE_SHELL_BACKEND=pty DB_PATH=${dbPath} PORT=${appPort} npm run -s app`,
    url: appUrl,
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
