import { expect, test, type Page } from "@playwright/test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

async function readSessionToken(page: Page): Promise<string> {
  const res = await page.request.get("/api/session");
  const json = (await res.json()) as { token?: unknown };
  if (typeof json.token !== "string" || json.token.length === 0) {
    throw new Error("missing session token");
  }
  return json.token;
}

async function commandAvailable(command: string, args: string[]): Promise<boolean> {
  try {
    await execFileAsync(command, args);
    return true;
  } catch {
    return false;
  }
}

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
    const token = await readSessionToken(page);
    await page.request.post(`/api/ptys/${encodeURIComponent(ptyId)}/kill?token=${encodeURIComponent(token)}`);
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
  await page.keyboard.type("for i in $(seq 1 8000); do echo line-$i; done");
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
    .toContain("line-8000");

  // Force to bottom, then wheel up and verify visible viewport changes.
  await page.evaluate(() => (window as any).__agentTide?.scrollToBottomActive?.());
  const bottomViewport = await page.evaluate(() => (window as any).__agentTide?.dumpViewport?.() ?? "");

  await page.evaluate(() => {
    const el = document.querySelector(".term-pane:not(.hidden)") as HTMLElement | null;
    if (!el) return;
    for (let i = 0; i < 8; i++) {
      el.dispatchEvent(
        new WheelEvent("wheel", {
          deltaY: -1000,
          bubbles: true,
          cancelable: true,
        }),
      );
    }
  });

  await expect
    .poll(async () => page.evaluate(() => (window as any).__agentTide?.dumpViewport?.() ?? ""), {
      timeout: 5_000,
    })
    .not.toBe(bottomViewport);

  // Cleanup (avoid leaking tmux sessions in e2e).
  const ptyId = await page.locator(".pty-item.active").evaluate((el) => el.getAttribute("data-pty-id"));
  if (ptyId) {
    const token = await readSessionToken(page);
    await page.request.post(`/api/ptys/${encodeURIComponent(ptyId)}/kill?token=${encodeURIComponent(token)}`);
  }
});

test("scroll up after cat reveals the cat command", async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 520 });
  await page.goto("/?nosup=1");

  // Constrain the terminal height so scrollback is needed even with modest output.
  await page.addStyleTag({
    content: `
      .terminal-wrap { height: 260px !important; }
      #terminal { height: 240px !important; min-height: 240px !important; }
    `,
  });

  await page.getByRole("button", { name: "New PTY" }).click();
  await expect(page.locator(".pty-item.active")).toHaveCount(1);

  const xterm = page.locator(".term-pane:not(.hidden) .xterm");
  await xterm.click();

  // Create a file with enough lines to push the cat command off-screen,
  // but stay well within the 5000-line scrollback limit.
  await page.keyboard.type("seq 1 80 > /tmp/e2e-bigfile.txt && cat /tmp/e2e-bigfile.txt");
  await page.keyboard.press("Enter");

  // Wait for cat output to finish — the shell prompt reappears after "80".
  await expect
    .poll(
      async () =>
        page.evaluate(() => {
          const d = (window as any).__agentTide?.dumpActive;
          return typeof d === "function" ? String(d()) : "";
        }),
      { timeout: 30_000 },
    )
    .toMatch(/\b80\n.*\$/s);

  // At the bottom the cat command should be scrolled out of view.
  await page.evaluate(() => (window as any).__agentTide?.scrollToBottomActive?.());

  // Scroll up with the mouse wheel to reveal the cat command.
  await xterm.hover();
  await page.mouse.wheel(0, -8000);

  await expect
    .poll(
      async () => page.evaluate(() => (window as any).__agentTide?.dumpViewport?.() ?? ""),
      { timeout: 5_000 },
    )
    .toContain("cat /tmp/e2e-bigfile.txt");

  // Cleanup.
  const ptyId = await page.locator(".pty-item.active").evaluate((el) => el.getAttribute("data-pty-id"));
  if (ptyId) {
    const token = await readSessionToken(page);
    await page.request.post(`/api/ptys/${encodeURIComponent(ptyId)}/kill?token=${encodeURIComponent(token)}`);
  }
});

test("pty list shows running subprocess name", async ({ page }) => {
  await page.goto("/?nosup=1");
  await page.getByRole("button", { name: "New PTY" }).click();
  await expect(page.locator(".pty-item.active")).toHaveCount(1);

  const ptyId = await page.locator(".pty-item.active").evaluate((el) => el.getAttribute("data-pty-id"));
  try {
    await page.locator(".term-pane:not(.hidden) .xterm").click();
    await page.keyboard.type("sleep 8");
    await page.keyboard.press("Enter");

    await expect(page.locator(".pty-item.active .primary")).toContainText("sleep", { timeout: 10_000 });
    await expect(page.locator(".pty-item.active .secondary")).toContainText("> sleep 8", { timeout: 10_000 });
  } finally {
    if (ptyId) {
      const token = await readSessionToken(page);
      await page.request.post(`/api/ptys/${encodeURIComponent(ptyId)}/kill?token=${encodeURIComponent(token)}`);
    }
  }
});

test("pty readiness flips busy to ready around subprocess execution", async ({ page }) => {
  await page.goto("/?nosup=1");
  await page.getByRole("button", { name: "New PTY" }).click();
  await expect(page.locator(".pty-item.active")).toHaveCount(1);

  const ptyId = await page.locator(".pty-item.active").evaluate((el) => el.getAttribute("data-pty-id"));
  try {
    const active = page.locator(".pty-item.active");
    await page.locator(".term-pane:not(.hidden) .xterm").click();
    await page.keyboard.type("sleep 1");
    await page.keyboard.press("Enter");

    await expect(active.locator(".ready-dot.busy")).toHaveCount(1, { timeout: 5_000 });
    await expect(active.locator(".ready-dot.ready")).toHaveCount(1, { timeout: 10_000 });
  } finally {
    if (ptyId) {
      const token = await readSessionToken(page);
      await page.request.post(`/api/ptys/${encodeURIComponent(ptyId)}/kill?token=${encodeURIComponent(token)}`);
    }
  }
});

test("tmux non-shell interactive prompt stays ready after reload", async ({ page }) => {
  const hasTmux = await commandAvailable("tmux", ["-V"]);
  const hasPython = await commandAvailable("python3", ["--version"]);
  test.skip(!hasTmux || !hasPython, "requires tmux and python3");

  const sessionName = `agent_tide_e2e_prompt_${Date.now()}_${Math.floor(Math.random() * 1_000_000)}`;
  let ptyId: string | null = null;

  await execFileAsync("tmux", ["new-session", "-d", "-s", sessionName, "python3", "-q"]);

  try {
    await page.goto("/?nosup=1");
    const token = await readSessionToken(page);
    const attachRes = await page.request.post(`/api/ptys/attach-tmux?token=${encodeURIComponent(token)}`, {
      data: { name: sessionName },
    });
    expect(attachRes.ok()).toBeTruthy();
    const attachJson = (await attachRes.json()) as { id?: unknown };
    ptyId = typeof attachJson.id === "string" ? attachJson.id : null;
    if (!ptyId) throw new Error("attach-tmux did not return a PTY id");

    const item = page.locator(`.pty-item[data-pty-id="${ptyId}"]`);
    await expect(item).toHaveCount(1, { timeout: 10_000 });
    await expect(item.locator(".ready-dot.ready")).toHaveCount(1, { timeout: 10_000 });

    // Keep this above the server prompt window to catch stale busy regressions.
    await page.waitForTimeout(16_000);
    await expect(item.locator(".ready-dot.ready")).toHaveCount(1, { timeout: 10_000 });

    await page.reload();
    const reloadedItem = page.locator(`.pty-item[data-pty-id="${ptyId}"]`);
    await expect(reloadedItem).toHaveCount(1, { timeout: 10_000 });
    await expect(reloadedItem.locator(".ready-dot.ready")).toHaveCount(1, { timeout: 10_000 });
  } finally {
    if (ptyId) {
      const token = await readSessionToken(page);
      await page.request.post(`/api/ptys/${encodeURIComponent(ptyId)}/kill?token=${encodeURIComponent(token)}`);
    }
    await execFileAsync("tmux", ["kill-session", "-t", sessionName]).catch(() => {});
  }
});

test("reopening running tmux PTY after refresh shows output without wheel scroll", async ({ page }) => {
  await page.goto("/?nosup=1");
  await page.getByRole("button", { name: "New PTY" }).click();
  await expect(page.locator(".pty-item.active")).toHaveCount(1);

  const ptyId = await page.locator(".pty-item.active").evaluate((el) => el.getAttribute("data-pty-id"));
  const token = await readSessionToken(page);
  const ptysRes = await page.request.get(`/api/ptys?token=${encodeURIComponent(token)}`);
  const ptysJson = (await ptysRes.json()) as { ptys?: Array<{ id?: string; backend?: string }> };
  const backend = ptysJson.ptys?.find((p) => p.id === ptyId)?.backend;
  test.skip(backend !== "tmux", "requires tmux backend");

  const marker = "__refresh-visible-marker__";

  try {
    const xterm = page.locator(".term-pane:not(.hidden) .xterm");
    await xterm.click();
    await page.keyboard.type(`echo ${marker}`);
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
      .toContain(marker);

    await page.reload();
    await page.locator(`.pty-item[data-pty-id="${ptyId}"]`).click();

    await expect
      .poll(
        async () => page.evaluate(() => (window as any).__agentTide?.dumpViewport?.() ?? ""),
        { timeout: 10_000 },
      )
      .toContain(marker);
  } finally {
    if (ptyId) {
      await page.request.post(`/api/ptys/${encodeURIComponent(ptyId)}/kill?token=${encodeURIComponent(token)}`);
    }
  }
});
