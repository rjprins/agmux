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
