import { defineConfig } from "@playwright/test";

const DEFAULT_E2E_APP_PORT = 4956;
const requestedPort = Number(process.env.E2E_APP_PORT ?? String(DEFAULT_E2E_APP_PORT));
const appPort = Number.isInteger(requestedPort) && requestedPort > 0 ? requestedPort : DEFAULT_E2E_APP_PORT;
const appUrl = `http://127.0.0.1:${appPort}`;
const dbPath = process.env.E2E_DB_PATH ?? `/tmp/agent-tide-e2e-${appPort}.db`;

export default defineConfig({
  testDir: "e2e",
  timeout: 60_000,
  retries: 0,
  use: {
    baseURL: appUrl,
    browserName: "chromium",
    launchOptions: {
      // Use system Chromium if available, otherwise fall back to Playwright's managed browser.
      ...(process.env.PLAYWRIGHT_CHROMIUM_PATH
        ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH }
        : {}),
    },
  },
  webServer: {
    command: `AGENT_TIDE_SHELL=bash AGENT_TIDE_SHELL_BACKEND=pty AGENT_TIDE_NO_OPEN=1 DB_PATH=${dbPath} PORT=${appPort} npm run -s app`,
    url: appUrl,
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
