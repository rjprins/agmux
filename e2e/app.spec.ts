import { expect, test } from "@playwright/test";

test("can create a PTY and fires proceed trigger", async ({ page }) => {
  await page.goto("/?nosup=1");
  await page.getByRole("button", { name: "New PTY" }).click();

  // PTY should appear and become active.
  await expect(page.locator(".pty-item.active")).toHaveCount(1);

  // Focus the xterm instance and drive the shell.
  await page.locator(".term-pane:not(.hidden) .xterm").click();
  await page.keyboard.type("echo ready; read -p 'proceed (y)? ' x; echo done");
  await page.keyboard.press("Enter");

  // It should print "ready" in the terminal buffer (via a small debug hook).
  await expect
    .poll(
      async () =>
        page.evaluate(() => {
          const d = (window as any).__agentTide?.dumpActive;
          return typeof d === "function" ? String(d()) : "";
        }),
      { timeout: 30_000 },
    )
    .toContain("ready");

  // Trigger should fire; either via highlight class or events panel.
  await expect(page.locator("#events")).toContainText("trigger proceed_prompt", { timeout: 30_000 });

  // Answer the prompt and ensure the script completes.
  await page.keyboard.type("y");
  await page.keyboard.press("Enter");
  await expect
    .poll(
      async () =>
        page.evaluate(() => {
          const d = (window as any).__agentTide?.dumpActive;
          return typeof d === "function" ? String(d()) : "";
        }),
      { timeout: 30_000 },
    )
    .toContain("done");

  // Cleanup: kill the PTY/tmux session so e2e runs don't leak sessions.
  const ptyId = await page.locator(".pty-item.active").evaluate((el) => el.getAttribute("data-pty-id"));
  if (ptyId) {
    await page.request.post(`/api/ptys/${encodeURIComponent(ptyId)}/kill`);
  }
});

test("xterm viewport scrolls with mouse wheel", async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 520 });
  await page.goto("/?nosup=1");

  // Clamp the terminal height so scrollback is guaranteed even on large screens.
  await page.addStyleTag({
    content: `
      .terminal-wrap { height: 260px !important; }
      #terminal { height: 240px !important; min-height: 240px !important; }
    `,
  });

  await page.getByRole("button", { name: "New PTY" }).click();
  await expect(page.locator(".pty-item.active")).toHaveCount(1);

  // Produce enough output to have scrollback.
  await page.locator(".term-pane:not(.hidden) .xterm").click();
  await page.keyboard.type("for i in $(seq 1 1200); do echo line-$i; done");
  await page.keyboard.press("Enter");

  await expect
    .poll(
      async () =>
        page.evaluate(() => {
          const d = (window as any).__agentTide?.dumpActive;
          return typeof d === "function" ? String(d()) : "";
        }),
      { timeout: 30_000 },
    )
    .toContain("line-1200");

  // Force to bottom, then wheel up and verify viewportY decreases.
  await page.evaluate(() => (window as any).__agentTide?.scrollToBottomActive?.());
  const bottomInfo = await page.evaluate(() => (window as any).__agentTide?.bufferActiveInfo?.());
  expect(bottomInfo?.baseY ?? 0).toBeGreaterThan(0);
  expect(bottomInfo?.viewportY ?? 0).toBeGreaterThan(0);

  await page.locator(".term-pane:not(.hidden) .xterm").hover();
  await page.mouse.wheel(0, -1400);

  await expect
    .poll(async () => page.evaluate(() => (window as any).__agentTide?.bufferActiveInfo?.()?.viewportY ?? 0), {
      timeout: 5_000,
    })
    .toBeLessThan(bottomInfo.viewportY);

  // Cleanup (avoid leaking tmux sessions in e2e).
  const ptyId = await page.locator(".pty-item.active").evaluate((el) => el.getAttribute("data-pty-id"));
  if (ptyId) {
    await page.request.post(`/api/ptys/${encodeURIComponent(ptyId)}/kill`);
  }
});
