import { expect, test } from "@playwright/test";

test("can create a PTY and fires proceed trigger", async ({ page }) => {
  const dialogs: string[] = [];

  page.on("dialog", async (d) => {
    dialogs.push(d.message());
    const msg = d.message();

    if (msg.startsWith("Command to run")) {
      await d.accept("bash");
      return;
    }
    if (msg.startsWith("Name (optional)")) {
      await d.accept("e2e-proceed");
      return;
    }
    if (msg.startsWith("Args as JSON array")) {
      await d.accept(`["-lc","echo ready; read -p 'proceed (y)? ' x; echo done"]`);
      return;
    }
    if (msg.startsWith("CWD (optional)")) {
      await d.accept("");
      return;
    }

    await d.dismiss();
  });

  await page.goto("/?nosup=1");
  await page.getByRole("button", { name: "New PTY" }).click();

  // PTY should appear and become active.
  await expect(page.locator(".pty-item.active")).toHaveCount(1);

  // It should print "ready" in the output view.
  await expect(page.locator("#terminal")).toContainText("ready", { timeout: 30_000 });

  // Trigger should fire; either via highlight class or events panel.
  await expect(page.locator("#events")).toContainText("trigger proceed_prompt", { timeout: 30_000 });
});

