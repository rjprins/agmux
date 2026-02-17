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

async function killPty(page: Page, token: string, ptyId: string): Promise<void> {
  await page.request
    .post(`/api/ptys/${encodeURIComponent(ptyId)}/kill?token=${encodeURIComponent(token)}`, { timeout: 5_000 })
    .catch(() => {});
}

async function killAllRunningPtys(page: Page, token: string): Promise<void> {
  const res = await page.request.get(`/api/ptys?token=${encodeURIComponent(token)}`, { timeout: 5_000 });
  if (!res.ok()) return;
  const json = (await res.json()) as { ptys?: Array<{ id?: unknown; status?: unknown }> };
  const running = (json.ptys ?? []).filter((p) => p?.status === "running").map((p) => p?.id).filter((id): id is string => typeof id === "string");
  for (const id of running) {
    await killPty(page, token, id);
  }
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

test("pty list item shows current working directory", async ({ page }) => {
  await page.goto("/?nosup=1");
  await page.getByRole("button", { name: "New PTY" }).click();
  await expect(page.locator(".pty-item.active")).toHaveCount(1);

  const ptyId = await page.locator(".pty-item.active").evaluate((el) => el.getAttribute("data-pty-id"));
  const token = await readSessionToken(page);

  try {
    const active = page.locator(".pty-item.active");

    // The cwd label should appear once readiness recomputes.
    await expect(active.locator(".cwd-label")).toHaveCount(1, { timeout: 10_000 });
    const cwdText = await active.locator(".cwd-label").textContent();
    expect(cwdText?.trim().length).toBeGreaterThan(0);

    // cd to /tmp and verify the cwd label updates.
    await page.locator(".term-pane:not(.hidden) .xterm").click();
    await page.keyboard.type("cd /tmp");
    await page.keyboard.press("Enter");

    await expect(active.locator(".cwd-label")).toContainText("tmp", { timeout: 10_000 });
    // Full path should be in the tooltip.
    await expect(active.locator(".cwd-label")).toHaveAttribute("title", /\/tmp/, { timeout: 10_000 });
  } finally {
    if (ptyId) {
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

test("pty readiness does not flash busy for immediate prompt commands", async ({ page }) => {
  await page.goto("/?nosup=1");
  await page.getByRole("button", { name: "New PTY" }).click();
  await expect(page.locator(".pty-item.active")).toHaveCount(1);

  const ptyId = await page.locator(".pty-item.active").evaluate((el) => el.getAttribute("data-pty-id"));
  try {
    const active = page.locator(".pty-item.active");
    await page.locator(".term-pane:not(.hidden) .xterm").click();
    await expect(active.locator(".ready-dot.ready")).toHaveCount(1, { timeout: 10_000 });

    await page.evaluate(() => {
      const root = document.querySelector(".pty-list") ?? document.body;
      (window as any).__busyFlashSeen = false;
      const update = () => {
        if (document.querySelector(".pty-item.active .ready-dot.busy")) {
          (window as any).__busyFlashSeen = true;
        }
      };
      const observer = new MutationObserver(update);
      observer.observe(root, { subtree: true, childList: true, attributes: true, attributeFilter: ["class"] });
      (window as any).__busyFlashObserver = observer;
      update();
    });

    await page.keyboard.type(":");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(700);

    const busySeen = await page.evaluate(() => Boolean((window as any).__busyFlashSeen));
    expect(busySeen).toBeFalsy();
    await expect(active.locator(".ready-dot.ready")).toHaveCount(1, { timeout: 10_000 });

    await page.evaluate(() => {
      const obs = (window as any).__busyFlashObserver;
      if (obs && typeof obs.disconnect === "function") obs.disconnect();
      delete (window as any).__busyFlashObserver;
      delete (window as any).__busyFlashSeen;
    });
  } finally {
    if (ptyId) {
      const token = await readSessionToken(page);
      await page.request.post(`/api/ptys/${encodeURIComponent(ptyId)}/kill?token=${encodeURIComponent(token)}`);
    }
  }
});

test("pty readiness flips to busy during sustained output", async ({ page }) => {
  await page.goto("/?nosup=1");
  await page.getByRole("button", { name: "New PTY" }).click();
  await expect(page.locator(".pty-item.active")).toHaveCount(1);

  const ptyId = await page.locator(".pty-item.active").evaluate((el) => el.getAttribute("data-pty-id"));
  try {
    const active = page.locator(".pty-item.active");
    await page.locator(".term-pane:not(.hidden) .xterm").click();
    await expect(active.locator(".ready-dot.ready")).toHaveCount(1, { timeout: 10_000 });

    await page.keyboard.type("for i in $(seq 1 30); do echo $i; sleep 0.05; done");
    await page.keyboard.press("Enter");

    await expect(active.locator(".ready-dot.busy")).toHaveCount(1, { timeout: 6_000 });
    await expect(active.locator(".ready-dot.ready")).toHaveCount(1, { timeout: 12_000 });
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

test("tmux non-shell prompt with footer line stays stable", async ({ page }) => {
  const hasTmux = await commandAvailable("tmux", ["-V"]);
  const hasPython = await commandAvailable("python3", ["--version"]);
  test.skip(!hasTmux || !hasPython, "requires tmux and python3");

  const sessionName = `agent_tide_e2e_footer_prompt_${Date.now()}_${Math.floor(Math.random() * 1_000_000)}`;
  let ptyId: string | null = null;

  const script =
    "import sys,time; print('› Ask anything'); print('  100% context left'); sys.stdout.flush(); " +
    "[(sys.stdout.write('\\\\x1b[?25l\\\\x1b[?25h'), sys.stdout.flush(), time.sleep(0.05)) for _ in range(320)]; input()";
  await execFileAsync("tmux", ["new-session", "-d", "-s", sessionName, "python3", "-u", "-c", script]);

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
    await expect
      .poll(async () => {
        const stable = await page
          .locator(
            `.pty-item[data-pty-id="${ptyId}"] [aria-label="PTY is ready"], ` +
            `.pty-item[data-pty-id="${ptyId}"] [aria-label="PTY is unknown"]`,
          )
          .count();
        return stable;
      }, { timeout: 10_000 })
      .toBeGreaterThan(0);

    // Keep this above the server prompt window; we only require the PTY row remains present.
    await page.waitForTimeout(16_000);
    await expect(item).toHaveCount(1, { timeout: 10_000 });
  } finally {
    if (ptyId) {
      const token = await readSessionToken(page);
      await page.request.post(`/api/ptys/${encodeURIComponent(ptyId)}/kill?token=${encodeURIComponent(token)}`);
    }
    await execFileAsync("tmux", ["kill-session", "-t", sessionName]).catch(() => {});
  }
});

test("escape key is delivered to tmux session promptly", async ({ page }) => {
  const hasTmux = await commandAvailable("tmux", ["-V"]);
  test.skip(!hasTmux, "requires tmux");

  const sessionName = `agent_tide_e2e_esc_${Date.now()}_${Math.floor(Math.random() * 1_000_000)}`;
  let ptyId: string | null = null;

  // Create a tmux session running cat -v, which echoes Escape as ^[.
  await execFileAsync("tmux", ["new-session", "-d", "-s", sessionName, "cat", "-v"]);

  try {
    await page.goto("/?nosup=1");
    const token = await readSessionToken(page);
    // Attaching applies tmuxApplySessionUiOptions which sets escape-time 10ms.
    const attachRes = await page.request.post(`/api/ptys/attach-tmux?token=${encodeURIComponent(token)}`, {
      data: { name: sessionName },
    });
    expect(attachRes.ok()).toBeTruthy();
    const attachJson = (await attachRes.json()) as { id?: unknown };
    ptyId = typeof attachJson.id === "string" ? attachJson.id : null;
    if (!ptyId) throw new Error("attach-tmux did not return a PTY id");

    const item = page.locator(`.pty-item[data-pty-id="${ptyId}"]`);
    await expect(item).toHaveCount(1, { timeout: 10_000 });
    await item.click();

    // Wait for the terminal to be ready.
    await page.waitForTimeout(500);
    const xterm = page.locator(".term-pane:not(.hidden) .xterm");
    await xterm.click();

    // Press Escape — cat -v should echo ^[.
    await page.keyboard.press("Escape");

    // ^[ must appear within 2s (with 500ms escape-time it would be delayed,
    // but with 10ms it should appear almost instantly).
    await expect
      .poll(
        async () =>
          page.evaluate(() => {
            const d = (window as any).__agentTide?.dumpActive;
            return typeof d === "function" ? String(d()) : "";
          }),
        { timeout: 5_000 },
      )
      .toContain("^[");
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

test("each browser tab restores its own active PTY after reload", async ({ page }) => {
  let page2: Page | null = null;
  let firstTabPtyId: string | null = null;
  let secondTabPtyId: string | null = null;

  try {
    await page.goto("/?nosup=1");
    page2 = await page.context().newPage();
    await page2.goto("/?nosup=1");

    await page.getByRole("button", { name: "New PTY" }).click();
    await expect(page.locator(".pty-item.active")).toHaveCount(1);
    firstTabPtyId = await page.locator(".pty-item.active").evaluate((el) => el.getAttribute("data-pty-id"));
    if (!firstTabPtyId) throw new Error("missing first tab PTY id");

    await page2.getByRole("button", { name: "New PTY" }).click();
    await expect(page2.locator(".pty-item.active")).toHaveCount(1);
    secondTabPtyId = await page2.locator(".pty-item.active").evaluate((el) => el.getAttribute("data-pty-id"));
    if (!secondTabPtyId) throw new Error("missing second tab PTY id");
    expect(secondTabPtyId).not.toBe(firstTabPtyId);

    await expect(page.locator(`.pty-item[data-pty-id="${firstTabPtyId}"].active`)).toHaveCount(1, { timeout: 10_000 });
    await expect(page2.locator(`.pty-item[data-pty-id="${secondTabPtyId}"].active`)).toHaveCount(1, { timeout: 10_000 });

    await page.reload();
    await page2.reload();

    await expect(page.locator(`.pty-item[data-pty-id="${firstTabPtyId}"].active`)).toHaveCount(1, { timeout: 10_000 });
    await expect(page2.locator(`.pty-item[data-pty-id="${secondTabPtyId}"].active`)).toHaveCount(1, { timeout: 10_000 });
  } finally {
    const token = await readSessionToken(page);
    if (firstTabPtyId) {
      await page.request.post(`/api/ptys/${encodeURIComponent(firstTabPtyId)}/kill?token=${encodeURIComponent(token)}`);
    }
    if (secondTabPtyId && secondTabPtyId !== firstTabPtyId) {
      await page.request.post(`/api/ptys/${encodeURIComponent(secondTabPtyId)}/kill?token=${encodeURIComponent(token)}`);
    }
    if (page2) await page2.close();
  }
});

test("ready PTY keeps last input visible after reload", async ({ page }) => {
  await page.goto("/?nosup=1");
  await page.getByRole("button", { name: "New PTY" }).click();
  await expect(page.locator(".pty-item.active")).toHaveCount(1);

  const marker = "__last_input_ready__";
  const ptyId = await page.locator(".pty-item.active").evaluate((el) => el.getAttribute("data-pty-id"));
  if (!ptyId) throw new Error("missing PTY id");

  try {
    await page.locator(".term-pane:not(.hidden) .xterm").click();
    await page.keyboard.type(`echo ${marker}`);
    await page.keyboard.press("Enter");

    const activeSecondary = page.locator(".pty-item.active .secondary");
    await expect(activeSecondary).toContainText(`> echo ${marker}`, { timeout: 10_000 });
    await expect(page.locator(".pty-item.active .ready-dot.ready")).toHaveCount(1, { timeout: 10_000 });

    await page.reload();

    await expect(page.locator(`.pty-item[data-pty-id="${ptyId}"].active`)).toHaveCount(1, { timeout: 10_000 });
    await expect(page.locator(`.pty-item[data-pty-id="${ptyId}"] .secondary`)).toContainText(`> echo ${marker}`, {
      timeout: 10_000,
    });
  } finally {
    const token = await readSessionToken(page);
    await page.request.post(`/api/ptys/${encodeURIComponent(ptyId)}/kill?token=${encodeURIComponent(token)}`);
  }
});

test("input context bar tracks last input history per PTY", async ({ page }) => {
  await page.goto("/?nosup=1");
  const token = await readSessionToken(page);
  let ptyOne: string | null = null;
  let ptyTwo: string | null = null;

  try {
    await killAllRunningPtys(page, token);

    await page.getByRole("button", { name: "New PTY" }).click();
    await expect(page.locator(".pty-item.active")).toHaveCount(1);
    ptyOne = await page.locator(".pty-item.active").evaluate((el) => el.getAttribute("data-pty-id"));
    if (!ptyOne) throw new Error("missing PTY one id");

    await page.locator(`.pty-item[data-pty-id="${ptyOne}"]`).click();
    const ptyOneXterm = page.locator(`.term-pane[data-pty-id="${ptyOne}"]:not(.hidden) .xterm`);
    await expect(ptyOneXterm).toBeVisible({ timeout: 10_000 });
    await ptyOneXterm.click({ force: true });
    await page.keyboard.type("echo __ctx_pty_one__");
    await page.keyboard.press("Enter");
    await page.keyboard.type("pwd");
    await page.keyboard.press("Enter");

    await expect(page.locator("#input-context")).not.toHaveClass(/hidden/, { timeout: 10_000 });
    await expect(page.locator("#input-context-last")).toContainText("pwd", { timeout: 10_000 });
    await expect(page.locator("#input-history-label")).toHaveText(/History \(\d+\)/, { timeout: 10_000 });

    await page.locator("#input-context-toggle").click();
    await expect(page.locator("#input-history-list")).not.toHaveClass(/hidden/, { timeout: 10_000 });
    await expect(page.locator("#input-history-list")).toContainText("pwd", { timeout: 10_000 });
    await expect(page.locator("#input-history-list")).toContainText("echo __ctx_pty_one__", { timeout: 10_000 });

    await page.getByRole("button", { name: "New PTY" }).click();
    await expect(page.locator(".pty-item.active")).toHaveCount(1);
    ptyTwo = await page.locator(".pty-item.active").evaluate((el) => el.getAttribute("data-pty-id"));
    if (!ptyTwo) throw new Error("missing PTY two id");

    await page.locator(`.pty-item[data-pty-id="${ptyTwo}"]`).click();
    const ptyTwoXterm = page.locator(`.term-pane[data-pty-id="${ptyTwo}"]:not(.hidden) .xterm`);
    await expect(ptyTwoXterm).toBeVisible({ timeout: 10_000 });
    await ptyTwoXterm.click({ force: true });
    await page.keyboard.type("echo __ctx_pty_two__");
    await page.keyboard.press("Enter");

    await expect(page.locator("#input-context-last")).toContainText("echo __ctx_pty_two__", { timeout: 10_000 });
    await expect(page.locator("#input-history-label")).toHaveText(/History \(\d+\)/, { timeout: 10_000 });
    await expect(page.locator("#input-history-list")).toContainText("echo __ctx_pty_two__", { timeout: 10_000 });
    await expect(page.locator("#input-history-list")).not.toContainText("echo __ctx_pty_one__", { timeout: 10_000 });

    await page.locator(`.pty-item[data-pty-id="${ptyOne}"]`).click();
    await expect(page.locator("#input-context-last")).toContainText("pwd", { timeout: 10_000 });
    await expect(page.locator("#input-history-label")).toHaveText(/History \(\d+\)/, { timeout: 10_000 });
    await expect(page.locator("#input-history-list")).toContainText("echo __ctx_pty_one__", { timeout: 10_000 });
  } finally {
    if (ptyOne) {
      await killPty(page, token, ptyOne);
    }
    if (ptyTwo && ptyTwo !== ptyOne) {
      await killPty(page, token, ptyTwo);
    }
  }
});

test("switching between multiple PTYs keeps each terminal's content distinct", async ({ page }) => {
  await page.goto("/?nosup=1");
  const token = await readSessionToken(page);

  const ptys: Array<{ id: string; marker: string }> = [];
  const markerById = new Map<string, string>();
  const markers = ["__switch_pty_one__", "__switch_pty_two__", "__switch_pty_three__"];

  const readActivePtyId = async (): Promise<string | null> =>
    page.locator(".pty-item.active").evaluate((el) => el.getAttribute("data-pty-id"));

  const dumpActiveBuffer = async (): Promise<string> =>
    page.evaluate(() => {
      const dump = (window as any).__agentTide?.dumpActive;
      return typeof dump === "function" ? String(dump()) : "";
    });

  const assertActiveHasOwnMarkerOnly = async (ptyId: string): Promise<void> => {
    const marker = markerById.get(ptyId);
    if (!marker) throw new Error(`missing marker for PTY ${ptyId}`);
    const otherMarkers = ptys.filter((p) => p.id !== ptyId).map((p) => p.marker);

    await expect(page.locator(`.pty-item[data-pty-id="${ptyId}"].active`)).toHaveCount(1, { timeout: 10_000 });
    await expect
      .poll(
        async () => {
          const buffer = await dumpActiveBuffer();
          return buffer.includes(marker) && otherMarkers.every((m) => !buffer.includes(m));
        },
        { timeout: 10_000 },
      )
      .toBe(true);
  };

  try {
    await killAllRunningPtys(page, token);

    for (const marker of markers) {
      const prevActivePtyId = ptys.length > 0 ? ptys[ptys.length - 1].id : null;
      await page.getByRole("button", { name: "New PTY" }).click();
      await expect(page.locator(".pty-item.active")).toHaveCount(1);
      if (prevActivePtyId) {
        await expect.poll(readActivePtyId, { timeout: 10_000 }).not.toBe(prevActivePtyId);
      }

      const ptyId = await readActivePtyId();
      if (!ptyId) throw new Error("missing PTY id");
      expect(ptys.map((p) => p.id)).not.toContain(ptyId);

      ptys.push({ id: ptyId, marker });
      markerById.set(ptyId, marker);

      const xterm = page.locator(`.term-pane[data-pty-id="${ptyId}"]:not(.hidden) .xterm`);
      await expect(xterm).toBeVisible({ timeout: 10_000 });
      await xterm.click({ force: true });
      await page.keyboard.type(`echo ${marker}`);
      await page.keyboard.press("Enter");

      await assertActiveHasOwnMarkerOnly(ptyId);
    }

    const firstPtyId = ptys[0]?.id;
    const lastPtyId = ptys[2]?.id;
    if (!firstPtyId || !lastPtyId) throw new Error("expected three PTYs");

    await page.locator(`.pty-item[data-pty-id="${firstPtyId}"]`).click();
    await assertActiveHasOwnMarkerOnly(firstPtyId);

    await page.keyboard.press("Control+Shift+BracketRight");
    await expect.poll(readActivePtyId, { timeout: 10_000 }).not.toBe(firstPtyId);

    const switchedPtyId = await readActivePtyId();
    if (!switchedPtyId) throw new Error("missing switched PTY id");
    await assertActiveHasOwnMarkerOnly(switchedPtyId);

    await page.keyboard.press("Control+Shift+BracketLeft");
    await expect.poll(readActivePtyId, { timeout: 10_000 }).toBe(firstPtyId);
    await assertActiveHasOwnMarkerOnly(firstPtyId);

    await page.locator(`.pty-item[data-pty-id="${lastPtyId}"]`).click();
    await assertActiveHasOwnMarkerOnly(lastPtyId);
  } finally {
    for (const p of ptys) {
      await killPty(page, token, p.id);
    }
  }
});
