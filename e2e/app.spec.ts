import { expect, test } from "@playwright/test";

test("can create a PTY and fires proceed trigger", async ({ page }) => {
  await page.goto("/?nosup=1");
  await page.getByRole("button", { name: "New PTY" }).click();

  // PTY should appear and become active.
  await expect(page.locator(".pty-item.active")).toHaveCount(1);

  // Drive the shell via the input box.
  await page.locator("#input").fill("echo ready; read -p 'proceed (y)? ' x; echo done");
  await page.locator("#input").press("Enter");

  // It should print "ready" in the output view.
  await expect(page.locator("#terminal")).toContainText("ready", { timeout: 30_000 });

  // Trigger should fire; either via highlight class or events panel.
  await expect(page.locator("#events")).toContainText("trigger proceed_prompt", { timeout: 30_000 });
});
