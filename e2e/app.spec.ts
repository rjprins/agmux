import { expect, test, type Page } from "@playwright/test";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const E2E_TOKEN = process.env.E2E_AGMUX_TOKEN ?? "e2e-token";

async function readSessionToken(_page: Page): Promise<string> {
  return E2E_TOKEN;
}

async function listRunningPtys(page: Page, token: string): Promise<string[]> {
  const res = await page.request.get(`/api/ptys?token=${encodeURIComponent(token)}`, { timeout: 5_000 });
  if (!res.ok()) return [];
  const json = (await res.json()) as { ptys?: Array<{ id?: unknown; status?: unknown }> };
  return (json.ptys ?? [])
    .filter((p) => p?.status === "running")
    .map((p) => p?.id)
    .filter((id): id is string => typeof id === "string");
}

async function killPty(page: Page, token: string, ptyId: string): Promise<void> {
  const res = await page.request.post(`/api/ptys/${encodeURIComponent(ptyId)}/kill?token=${encodeURIComponent(token)}`, {
    timeout: 5_000,
  });
  if (!res.ok() && res.status() !== 404) {
    throw new Error(`failed to kill PTY ${ptyId}: HTTP ${res.status()}`);
  }
}

async function killAllRunningPtys(page: Page, token: string): Promise<void> {
  const running = await listRunningPtys(page, token);
  for (const id of running) {
    await killPty(page, token, id);
  }
}

async function ensureNoRunningPtys(page: Page, token: string): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const running = await listRunningPtys(page, token);
    if (running.length === 0) return;
    await killAllRunningPtys(page, token);
    await page.waitForTimeout(250);
  }
  const remaining = await listRunningPtys(page, token);
  throw new Error(`timed out waiting for PTY cleanup: ${remaining.join(", ")}`);
}

async function ensureInactiveItemVisible(page: Page, itemText: string): Promise<void> {
  const target = page.locator(".pty-item.inactive").filter({ hasText: itemText });
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (await target.isVisible().catch(() => false)) return;
    await page.evaluate(() => {
      const inactiveHeader = [...document.querySelectorAll<HTMLElement>(".pty-group-header")]
        .find((el) => (el.textContent ?? "").includes("Inactive") && el.classList.contains("collapsed"));
      if (inactiveHeader) inactiveHeader.click();

      const inactiveInline = [...document.querySelectorAll<HTMLElement>(".inline-inactive-divider")]
        .find((el) => (el.textContent ?? "").includes("Inactive") && el.classList.contains("collapsed"));
      if (inactiveInline) inactiveInline.click();

      const projectHeader = [...document.querySelectorAll<HTMLElement>(".worktree-subheader")]
        .find((el) => (el.textContent ?? "").includes("test-project") && el.classList.contains("collapsed"));
      if (projectHeader) projectHeader.click();
    });
    await page.waitForTimeout(250);
  }
  throw new Error(`inactive item did not become visible: ${itemText}`);
}

async function attachTmuxWithRetry(
  page: Page,
  token: string,
  name: string,
  server?: "agmux" | "default",
): Promise<string> {
  let lastStatus = 0;
  let lastBody = "";
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const attachRes = await page.request.post(`/api/ptys/attach-tmux?token=${encodeURIComponent(token)}`, {
      data: server ? { name, server } : { name },
    });
    if (attachRes.ok()) {
      const attachJson = (await attachRes.json()) as { id?: unknown };
      const ptyId = typeof attachJson.id === "string" ? attachJson.id : null;
      if (ptyId) return ptyId;
      lastStatus = attachRes.status();
      lastBody = JSON.stringify(attachJson);
    } else {
      lastStatus = attachRes.status();
      lastBody = await attachRes.text();
    }
    await page.waitForTimeout(250);
  }
  throw new Error(`attach-tmux failed for ${name}: status=${lastStatus} body=${lastBody}`);
}

async function commandAvailable(command: string, args: string[]): Promise<boolean> {
  try {
    await execFileAsync(command, args);
    return true;
  } catch {
    return false;
  }
}

test.beforeEach(async ({ page }) => {
  const token = await readSessionToken(page);
  await page.addInitScript((t: string) => {
    sessionStorage.setItem("agmux:authToken", t);
  }, token);
  await ensureNoRunningPtys(page, token);
});

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
          const d = (window as any).__agmux?.dumpActive;
          return typeof d === "function" ? String(d()) : "";
        }),
      { timeout: 30_000 },
    )
    .toContain("ready");

  // Trigger should fire; assert via temporary sidebar highlight.
  await expect(page.locator(".pty-item.active.highlight")).toHaveCount(1, { timeout: 30_000 });

  // Answer the prompt and ensure the script completes.
  await page.keyboard.type("y");
  await page.keyboard.press("Enter");
  await expect
    .poll(
      async () =>
        page.evaluate(() => {
          const d = (window as any).__agmux?.dumpActive;
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

test("mobile UI can send input via composer", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => {
    const sent: unknown[] = [];
    (window as any).__agmuxSentWs = sent;
    const originalSend = WebSocket.prototype.send;
    WebSocket.prototype.send = function (data: string | ArrayBufferLike | Blob | ArrayBufferView) {
      try {
        if (typeof data === "string") {
          sent.push(JSON.parse(data));
        } else {
          sent.push(String(data));
        }
      } catch {
        sent.push(String(data));
      }
      return originalSend.call(this, data);
    };
  });
  await page.goto("/?nosup=1");

  const token = await readSessionToken(page);
  const createRes = await page.request.post(`/api/ptys/shell?token=${encodeURIComponent(token)}`);
  expect(createRes.ok()).toBeTruthy();
  const createJson = (await createRes.json()) as { id?: unknown };
  const ptyId = typeof createJson.id === "string" ? createJson.id : null;

  await expect(page.locator(".mobile-session-card")).not.toHaveCount(0, { timeout: 30_000 });
  await expect(page.locator(".mobile-connection")).toContainText("Live", { timeout: 10_000 });
  await page.locator(".mobile-session-card").first().click();
  await expect(page.locator(".mobile-focus")).toHaveCount(1, { timeout: 10_000 });

  const textarea = page.locator(".mobile-composer textarea");
  await textarea.fill("echo mobile-ok");
  await expect(page.locator(".mobile-send")).toBeEnabled();
  await textarea.press("Enter");
  await expect(textarea).toHaveValue("");

  await expect
    .poll(
      async () =>
        page.evaluate(() => {
          const d = (window as any).__agmux?.dumpActive;
          return typeof d === "function" ? String(d()) : "";
        }),
      { timeout: 30_000 },
    )
    .toContain("mobile-ok");

  const mobileSubmitBodies = await page.evaluate(() => {
    const sent = ((window as any).__agmuxSentWs ?? []) as Array<{ type?: unknown; body?: unknown }>;
    return sent
      .filter((msg) => msg && msg.type === "mobile_submit")
      .map((msg) => (typeof msg.body === "string" ? msg.body : ""));
  });
  expect(mobileSubmitBodies).toContain("echo mobile-ok");

  if (ptyId) {
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
          const d = (window as any).__agmux?.dumpActive;
          return typeof d === "function" ? String(d()) : "";
        }),
      { timeout: 30_000 },
    )
    .toContain("line-8000");

  // Force to bottom, then wheel up and verify visible viewport changes.
  await page.evaluate(() => (window as any).__agmux?.scrollToBottomActive?.());
  const bottomViewport = await page.evaluate(() => (window as any).__agmux?.dumpViewport?.() ?? "");

  await page.locator(".term-pane:not(.hidden) .xterm").hover();
  for (let i = 0; i < 8; i += 1) {
    await page.mouse.wheel(0, -1000);
  }

  await expect
    .poll(async () => page.evaluate(() => (window as any).__agmux?.dumpViewport?.() ?? ""), {
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
          const d = (window as any).__agmux?.dumpActive;
          return typeof d === "function" ? String(d()) : "";
        }),
      { timeout: 30_000 },
    )
    .toMatch(/\b80\n.*[#\$]/s);

  // At the bottom the cat command should be scrolled out of view.
  await page.evaluate(() => (window as any).__agmux?.scrollToBottomActive?.());

  // Scroll up with the mouse wheel to reveal the cat command.
  await xterm.hover();
  await page.mouse.wheel(0, -8000);

  await expect
    .poll(
      async () => page.evaluate(() => (window as any).__agmux?.dumpViewport?.() ?? ""),
      { timeout: 5_000 },
    )
    .toMatch(/cat \/tmp\/e2e-bigfile\.t/i);

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

    await expect(page.locator(".pty-item.active .ready-dot:not(.compact).busy")).toHaveCount(1, { timeout: 10_000 });
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

    // cd to /tmp and verify grouping updates to the new cwd bucket.
    await page.locator(".term-pane:not(.hidden) .xterm").click();
    await page.keyboard.type("cd /tmp");
    await page.keyboard.press("Enter");

    const groupHeader = page.locator("#pty-list .pty-group-header").first();
    await expect(groupHeader).toContainText("tmp", { timeout: 10_000 });
    await expect(groupHeader).toHaveAttribute("title", /\/tmp/, { timeout: 10_000 });
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

    await expect(active.locator(".ready-dot:not(.compact).busy")).toHaveCount(1, { timeout: 5_000 });
    await expect(active.locator(".ready-dot:not(.compact).ready")).toHaveCount(1, { timeout: 10_000 });
  } finally {
    if (ptyId) {
      const token = await readSessionToken(page);
      await page.request.post(`/api/ptys/${encodeURIComponent(ptyId)}/kill?token=${encodeURIComponent(token)}`);
    }
  }
});

test("pty readiness settles back to ready for immediate prompt commands", async ({ page }) => {
  await page.goto("/?nosup=1");
  await page.getByRole("button", { name: "New PTY" }).click();
  await expect(page.locator(".pty-item.active")).toHaveCount(1);

  const ptyId = await page.locator(".pty-item.active").evaluate((el) => el.getAttribute("data-pty-id"));
  try {
    const active = page.locator(".pty-item.active");
    await page.locator(".term-pane:not(.hidden) .xterm").click();
    await expect(active.locator(".ready-dot:not(.compact).ready")).toHaveCount(1, { timeout: 10_000 });

    await page.keyboard.type(":");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(700);
    await expect(active.locator(".ready-dot:not(.compact).ready")).toHaveCount(1, { timeout: 10_000 });
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
    await expect(active.locator(".ready-dot:not(.compact).ready")).toHaveCount(1, { timeout: 10_000 });

    await page.keyboard.type("for i in $(seq 1 30); do echo $i; sleep 0.05; done");
    await page.keyboard.press("Enter");

    await expect(active.locator(".ready-dot:not(.compact).busy")).toHaveCount(1, { timeout: 6_000 });
    await expect(active.locator(".ready-dot:not(.compact).ready")).toHaveCount(1, { timeout: 12_000 });
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

  const sessionName = `agmux_e2e_prompt_${Date.now()}_${Math.floor(Math.random() * 1_000_000)}`;
  let ptyId: string | null = null;

  await execFileAsync("tmux", ["new-session", "-d", "-s", sessionName, "python3", "-q"]);

  try {
    await page.goto("/?nosup=1");
    const token = await readSessionToken(page);
    ptyId = await attachTmuxWithRetry(page, token, sessionName);

    const item = page.locator(`.pty-item[data-pty-id="${ptyId}"]`);
    await expect(item).toHaveCount(1, { timeout: 10_000 });
    await expect(item.locator(".ready-dot:not(.compact).ready")).toHaveCount(1, { timeout: 10_000 });

    // Keep this above the server prompt window to catch stale busy regressions.
    await page.waitForTimeout(16_000);
    await expect(item.locator(".ready-dot:not(.compact).ready")).toHaveCount(1, { timeout: 10_000 });

    await page.reload();
    const reloadedItem = page.locator(`.pty-item[data-pty-id="${ptyId}"]`);
    await expect(reloadedItem).toHaveCount(1, { timeout: 10_000 });
    await expect(reloadedItem.locator(".ready-dot:not(.compact).ready")).toHaveCount(1, { timeout: 10_000 });
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

  const sessionName = `agmux_e2e_footer_prompt_${Date.now()}_${Math.floor(Math.random() * 1_000_000)}`;
  let ptyId: string | null = null;

  const script =
    "import sys,time; print('› Ask anything'); print('  100% context left'); sys.stdout.flush(); " +
    "[(sys.stdout.write('\\\\x1b[?25l\\\\x1b[?25h'), sys.stdout.flush(), time.sleep(0.05)) for _ in range(320)]; input()";
  await execFileAsync("tmux", ["new-session", "-d", "-s", sessionName, "python3", "-u", "-c", script]);

  try {
    await page.goto("/?nosup=1");
    const token = await readSessionToken(page);
    ptyId = await attachTmuxWithRetry(page, token, sessionName);

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

test("tmux claude/codex subprocess prompt uses prompt readiness detection", async ({ page }) => {
  const hasTmux = await commandAvailable("tmux", ["-V"]);
  const hasPython = await commandAvailable("python3", ["--version"]);
  test.skip(!hasTmux || !hasPython, "requires tmux and python3");

  const pythonExecRes = await execFileAsync("python3", ["-c", "import sys; print(sys.executable)"]);
  const pythonExec = pythonExecRes.stdout.trim();
  if (!pythonExec) throw new Error("could not resolve python3 executable path");

  await page.goto("/?nosup=1");
  const token = await readSessionToken(page);

  for (const family of ["codex", "claude"] as const) {
    const suffix = `${Date.now()}_${Math.floor(Math.random() * 1_000_000)}`;
    const sessionName = `agmux_e2e_${family}_prompt_${suffix}`;
    const binaryPath = `/tmp/${family}-e2e-prompt-${suffix}`;
    const promptLine = family === "codex" ? "› Ask anything" : "❯ Ask anything";
    const script = `import sys,time; print(${JSON.stringify(promptLine)}); sys.stdout.flush(); time.sleep(20)`;
    let ptyId: string | null = null;

    await execFileAsync("ln", ["-sf", pythonExec, binaryPath]);
    await execFileAsync("tmux", ["new-session", "-d", "-s", sessionName, binaryPath, "-u", "-c", script]);

    try {
      ptyId = await attachTmuxWithRetry(page, token, sessionName);

      const item = page.locator(`.pty-item[data-pty-id="${ptyId}"]`);
      await expect(item).toHaveCount(1, { timeout: 10_000 });
      await expect(item.locator(".ready-dot:not(.compact).ready")).toHaveCount(1, { timeout: 12_000 });
    } finally {
      if (ptyId) {
        await page.request.post(`/api/ptys/${encodeURIComponent(ptyId)}/kill?token=${encodeURIComponent(token)}`);
      }
      await execFileAsync("tmux", ["kill-session", "-t", sessionName]).catch(() => {});
      await execFileAsync("rm", ["-f", binaryPath]).catch(() => {});
    }
  }
});

test("escape key is delivered to tmux session promptly", async ({ page }) => {
  const hasTmux = await commandAvailable("tmux", ["-V"]);
  test.skip(!hasTmux, "requires tmux");

  const sessionName = `agmux_e2e_esc_${Date.now()}_${Math.floor(Math.random() * 1_000_000)}`;
  let ptyId: string | null = null;

  // Create a tmux session running cat -v, which echoes Escape as ^[.
  await execFileAsync("tmux", ["new-session", "-d", "-s", sessionName, "cat", "-v"]);

  try {
    await page.goto("/?nosup=1");
    const token = await readSessionToken(page);
    // Attaching applies tmuxApplySessionUiOptions which sets escape-time 10ms.
    ptyId = await attachTmuxWithRetry(page, token, sessionName);

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
            const d = (window as any).__agmux?.dumpActive;
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
            const d = (window as any).__agmux?.dumpActive;
            return typeof d === "function" ? String(d()) : "";
          }),
        { timeout: 30_000 },
      )
      .toContain(marker);

    await page.reload();
    await page.locator(`.pty-item[data-pty-id="${ptyId}"]`).click();

    await expect
      .poll(
        async () => page.evaluate(() => (window as any).__agmux?.dumpViewport?.() ?? ""),
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
  const token = await readSessionToken(page);

  try {
    await page.goto("/?nosup=1");
    page2 = await page.context().newPage();
    await page2.addInitScript((t: string) => {
      sessionStorage.setItem("agmux:authToken", t);
    }, token);
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
    if (firstTabPtyId) await killPty(page, token, firstTabPtyId);
    if (secondTabPtyId && secondTabPtyId !== firstTabPtyId) await killPty(page, token, secondTabPtyId);
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
    await expect(page.locator(".pty-item.active .ready-dot:not(.compact).ready")).toHaveCount(1, { timeout: 10_000 });

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

test("input context bar keeps recent history visible across PTY switches", async ({ page }) => {
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

    await page.locator(`.pty-item[data-pty-id="${ptyOne}"]`).click();
    await expect(page.locator("#input-context-last")).toHaveText(/pwd|echo __ctx_pty_two__/, { timeout: 10_000 });
    await expect(page.locator("#input-history-label")).toHaveText(/History \(\d+\)/, { timeout: 10_000 });
    await expect(page.locator("#input-history-list")).toContainText("echo __ctx_pty_one__", { timeout: 10_000 });
    await expect(page.locator("#input-history-list")).toContainText("echo __ctx_pty_two__", { timeout: 10_000 });
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
      const dump = (window as any).__agmux?.dumpActive;
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

test("OSC window title appears in sidebar secondary text", async ({ page }) => {
  await page.goto("/?nosup=1");
  await page.getByRole("button", { name: "New PTY" }).click();
  await expect(page.locator(".pty-item.active")).toHaveCount(1);

  const ptyId = await page.locator(".pty-item.active").evaluate((el) => el.getAttribute("data-pty-id"));
  if (!ptyId) throw new Error("missing PTY id");

  try {
    await page.locator(".term-pane:not(.hidden) .xterm").click();

    // Send an OSC 0 (set window title) escape sequence.
    const title = "__e2e_window_title__";
    await page.keyboard.type(`printf '\\033]0;${title}\\007'`);
    await page.keyboard.press("Enter");

    // The title should appear in the sidebar item's secondary text (or title-label).
    const item = page.locator(`.pty-item[data-pty-id="${ptyId}"]`);
    await expect(item).toContainText(title, { timeout: 10_000 });
  } finally {
    const token = await readSessionToken(page);
    await page.request.post(`/api/ptys/${encodeURIComponent(ptyId)}/kill?token=${encodeURIComponent(token)}`);
  }
});

test("switching same-name tmux sessions across servers keeps PTYs distinct", async ({ page }) => {
  const hasTmux = await commandAvailable("tmux", ["-V"]);
  test.skip(!hasTmux, "requires tmux");

  const suffix = `${Date.now()}_${Math.floor(Math.random() * 1_000_000)}`;
  const sessionName = `agmux_e2e_same_name_${suffix}`;
  const defaultValue = `default:${sessionName}`;
  const agmuxValue = `agmux:${sessionName}`;

  let defaultPtyId: string | null = null;
  let agmuxPtyId: string | null = null;

  page.on("dialog", (dialog) => {
    void dialog.accept();
  });

  const tmuxSocket = process.env.AGMUX_TMUX_SOCKET ?? "agmux";
  await execFileAsync("tmux", ["new-session", "-d", "-s", sessionName, "sh", "-lc", "echo default-server; exec cat"]);
  await execFileAsync("tmux", ["-L", tmuxSocket, "-f", "/dev/null", "new-session", "-d", "-s", sessionName, "sh", "-lc", "echo agmux-server; exec cat"]);

  try {
    await page.goto("/?nosup=1");

    await page.locator("#tmux-session-select").focus();
    await expect(page.locator(`#tmux-session-select option[value="${defaultValue}"]`)).toHaveCount(1, { timeout: 10_000 });
    await expect(page.locator(`#tmux-session-select option[value="${agmuxValue}"]`)).toHaveCount(1, { timeout: 10_000 });

    await page.selectOption("#tmux-session-select", defaultValue);
    await expect(page.locator(".pty-item.active")).toHaveCount(1, { timeout: 10_000 });
    defaultPtyId = await page.locator(".pty-item.active").evaluate((el) => el.getAttribute("data-pty-id"));
    expect(defaultPtyId).toBeTruthy();

    await page.selectOption("#tmux-session-select", agmuxValue);
    await expect
      .poll(
        async () => page.locator(".pty-item.active").evaluate((el) => el.getAttribute("data-pty-id")),
        { timeout: 10_000 },
      )
      .not.toBe(defaultPtyId);

    agmuxPtyId = await page.locator(".pty-item.active").evaluate((el) => el.getAttribute("data-pty-id"));
    expect(agmuxPtyId).toBeTruthy();
    expect(agmuxPtyId).not.toBe(defaultPtyId);

    await expect(page.locator(`.pty-item[data-pty-id="${defaultPtyId}"]`)).toHaveCount(1);
    await expect(page.locator(`.pty-item[data-pty-id="${agmuxPtyId}"]`)).toHaveCount(1);

    const token = await readSessionToken(page);
    const listRes = await page.request.get(`/api/ptys?token=${encodeURIComponent(token)}`);
    expect(listRes.ok()).toBe(true);
    const listJson = (await listRes.json()) as {
      ptys?: Array<{ id?: unknown; backend?: unknown; tmuxSession?: unknown; tmuxServer?: unknown; status?: unknown }>;
    };

    const sameNameRunning = (listJson.ptys ?? []).filter(
      (p) =>
        p?.backend === "tmux" &&
        p?.status === "running" &&
        p?.tmuxSession === sessionName,
    );

    expect(sameNameRunning.length).toBe(2);
    const servers = sameNameRunning
      .map((p) => (typeof p.tmuxServer === "string" ? p.tmuxServer : ""))
      .sort();
    expect(servers).toEqual(["agmux", "default"]);
  } finally {
    const token = await readSessionToken(page).catch(() => "");
    if (token && defaultPtyId) await killPty(page, token, defaultPtyId);
    if (token && agmuxPtyId) await killPty(page, token, agmuxPtyId);

    await execFileAsync("tmux", ["kill-session", "-t", sessionName]).catch(() => {});
    await execFileAsync("tmux", ["-L", "agmux", "-f", "/dev/null", "kill-session", "-t", sessionName]).catch(() => {});
  }
});

test("settings modal opens, saves worktree template, and persists", async ({ page }) => {
  await page.goto("/?nosup=1");
  const token = await readSessionToken(page);

  // Open settings modal
  await page.getByRole("button", { name: "Settings" }).click();
  await expect(page.locator(".launch-modal h3")).toContainText("Settings");

  // Verify default template field is empty (placeholder shows default)
  const templateInput = page.locator(".launch-modal input[type='text']").first();
  await expect(templateInput).toHaveValue("");

  // Set a custom template
  await templateInput.fill("../{repo-name}-custom-{branch}");

  // Save
  await page.locator(".launch-modal-go").click();

  // Modal should close
  await expect(page.locator(".launch-modal")).toHaveCount(0, { timeout: 5_000 });

  // Verify via API that template was saved
  const res = await page.request.get(`/api/settings?token=${encodeURIComponent(token)}`);
  const settings = await res.json();
  expect(settings.worktreePathTemplate).toBe("../{repo-name}-custom-{branch}");

  // Reset via API for test cleanup
  await page.request.put(`/api/settings?token=${encodeURIComponent(token)}`, {
    data: { worktreePathTemplate: null },
  });
});

test("GET /api/worktrees returns git worktree list entries", async ({ page }) => {
  const token = await readSessionToken(page);
  const res = await page.request.get(`/api/worktrees?token=${encodeURIComponent(token)}`);
  expect(res.ok()).toBe(true);
  const data = await res.json();
  expect(data.repoRoot).toBeTruthy();
  expect(Array.isArray(data.worktrees)).toBe(true);
  for (const wt of data.worktrees) {
    expect(wt.name).toBeTruthy();
    expect(wt.path).toBeTruthy();
  }
});

test("launching in new worktree creates sibling directory", async ({ page }) => {
  const token = await readSessionToken(page);
  const testBranch = `e2e-wt-${Date.now()}`;

  try {
    // Create worktree via API (same as launch modal does)
    const res = await page.request.post(`/api/ptys/launch?token=${encodeURIComponent(token)}`, {
      data: {
        agent: "shell",
        worktree: "__new__",
        branch: testBranch,
        baseBranch: "main",
      },
    });
    expect(res.ok()).toBe(true);
    const { id: ptyId } = await res.json();

    // Verify worktree appears in API listing
    const wtRes = await page.request.get(`/api/worktrees?token=${encodeURIComponent(token)}`);
    const wtData = await wtRes.json();
    const created = wtData.worktrees.find((wt: any) => wt.branch === testBranch);
    expect(created).toBeTruthy();

    // Verify it's a sibling (not under .worktrees/)
    expect(created.path).not.toContain("/.worktrees/");

    // Cleanup: kill pty
    await page.request.post(`/api/ptys/${encodeURIComponent(ptyId)}/kill?token=${encodeURIComponent(token)}`);
  } finally {
    // Cleanup: find the worktree path from git and remove it
    try {
      const { stdout } = await execFileAsync("git", ["worktree", "list", "--porcelain"]);
      const blocks = stdout.split(/\n\n+/);
      for (const block of blocks) {
        if (block.includes(`branch refs/heads/${testBranch}`)) {
          const pathMatch = block.match(/^worktree (.+)$/m);
          if (pathMatch) {
            await execFileAsync("git", ["worktree", "remove", "--force", pathMatch[1]]).catch(() => {});
          }
          break;
        }
      }
    } catch {
      // ignore
    }
    await execFileAsync("git", ["branch", "-D", testBranch]).catch(() => {});
  }
});

test("session preview modal opens on inactive session click and shows conversation", async ({ page }) => {
  const token = await readSessionToken(page);

  // Mock the agent-sessions API to return a fake inactive session,
  // and the conversation endpoint to return test messages.
  const fakeProvider = "claude";
  const fakeSessionId = "e2e-preview-test-session";
  const fakeAgentSession = {
    id: `agent:${fakeProvider}:${fakeSessionId}`,
    provider: fakeProvider,
    providerSessionId: fakeSessionId,
    name: "Preview test session",
    command: fakeProvider,
    args: ["--resume", fakeSessionId],
    cwd: "/tmp/test-project",
    cwdSource: "log",
    projectRoot: "/tmp/test-project",
    worktree: null,
    createdAt: Date.now() - 86400_000,
    lastSeenAt: Date.now() - 3600_000,
    lastRestoredAt: null,
  };

  const fakeMessages = [
    { role: "user", text: "Fix the authentication bug" },
    { role: "assistant", text: "I'll look at the auth module and fix the bug." },
    { role: "user", text: "Also add tests please" },
    { role: "assistant", text: "Adding unit tests for the auth module now." },
  ];

  // Intercept the conversation endpoint for our fake session
  await page.route(
    `**/api/agent-sessions/${fakeProvider}/${fakeSessionId}/conversation`,
    async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ messages: fakeMessages }),
      });
    },
  );

  // Intercept the agent-sessions list — replace with ONLY our fake session to avoid
  // auto-collapse/archive behavior from real sessions on this machine.
  await page.route((url) => url.pathname === "/api/agent-sessions", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ sessions: [fakeAgentSession] }),
    });
  });

  await page.goto("/?nosup=1");

  await ensureInactiveItemVisible(page, "Preview test session");
  const inactiveItem = page.locator(`.pty-item.inactive`).filter({ hasText: "Preview test session" });
  await expect(inactiveItem).toBeVisible({ timeout: 10_000 });

  // Click the inactive session to open preview modal (not the > arrow)
  await inactiveItem.click();

  // Preview modal should appear
  const previewModal = page.locator(".session-preview-modal");
  await expect(previewModal).toBeVisible({ timeout: 5_000 });

  // Should show the session title
  await expect(previewModal.locator("h3")).toContainText("Preview test session");

  // Should show conversation messages
  await expect(previewModal.locator(".session-preview-msg")).toHaveCount(4, { timeout: 5_000 });
  await expect(previewModal.locator(".session-preview-msg.user").first()).toContainText("Fix the authentication bug");
  await expect(previewModal.locator(".session-preview-msg.assistant").first()).toContainText("I'll look at the auth module");

  // Close with Escape
  await previewModal.press("Escape");
  await expect(previewModal).not.toBeVisible({ timeout: 3_000 });

  // Re-open and test Restore button
  await inactiveItem.click();
  await expect(previewModal).toBeVisible({ timeout: 5_000 });

  // Click Restore button — should close preview and open restore modal
  await previewModal.getByRole("button", { name: "Restore" }).click();
  await expect(previewModal).not.toBeVisible({ timeout: 3_000 });

  // Restore session modal should now be visible
  const restoreModal = page.locator(".restore-session-modal");
  await expect(restoreModal).toBeVisible({ timeout: 5_000 });

  // Close restore modal
  await restoreModal.press("Escape");
  await expect(restoreModal).not.toBeVisible({ timeout: 3_000 });
});

test("arrow button on inactive session opens restore modal directly (not preview)", async ({ page }) => {
  const token = await readSessionToken(page);

  const fakeProvider = "claude";
  const fakeSessionId = "e2e-arrow-test-session";
  const fakeAgentSession = {
    id: `agent:${fakeProvider}:${fakeSessionId}`,
    provider: fakeProvider,
    providerSessionId: fakeSessionId,
    name: "Arrow test session",
    command: fakeProvider,
    args: ["--resume", fakeSessionId],
    cwd: "/tmp/test-project",
    cwdSource: "log",
    projectRoot: "/tmp/test-project",
    worktree: null,
    createdAt: Date.now() - 86400_000,
    lastSeenAt: Date.now() - 3600_000,
    lastRestoredAt: null,
  };

  await page.route((url) => url.pathname === "/api/agent-sessions", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ sessions: [fakeAgentSession] }),
    });
  });

  await page.goto("/?nosup=1");

  await ensureInactiveItemVisible(page, "Arrow test session");
  const inactiveItem = page.locator(`.pty-item.inactive`).filter({ hasText: "Arrow test session" });
  await expect(inactiveItem).toBeVisible({ timeout: 10_000 });

  // Click the > arrow button specifically
  await inactiveItem.locator(".pty-actions-arrow").click();

  // Should open restore modal directly (not preview modal)
  const restoreModal = page.locator(".restore-session-modal");
  await expect(restoreModal).toBeVisible({ timeout: 5_000 });

  // Preview modal should NOT be visible
  const previewModal = page.locator(".session-preview-modal");
  await expect(previewModal).not.toBeVisible();

  // Close
  await restoreModal.press("Escape");
});

test("session preview modal shows loading state and handles empty conversation", async ({ page }) => {
  const token = await readSessionToken(page);

  const fakeProvider = "claude";
  const fakeSessionId = "e2e-empty-conv-session";
  const fakeAgentSession = {
    id: `agent:${fakeProvider}:${fakeSessionId}`,
    provider: fakeProvider,
    providerSessionId: fakeSessionId,
    name: "Empty conversation session",
    command: fakeProvider,
    args: ["--resume", fakeSessionId],
    cwd: "/tmp/test-project",
    cwdSource: "log",
    projectRoot: "/tmp/test-project",
    worktree: null,
    createdAt: Date.now() - 86400_000,
    lastSeenAt: Date.now() - 3600_000,
    lastRestoredAt: null,
  };

  await page.route((url) => url.pathname === "/api/agent-sessions", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ sessions: [fakeAgentSession] }),
    });
  });

  // Return 404 for conversation (log file not found)
  await page.route(
    `**/api/agent-sessions/${fakeProvider}/${fakeSessionId}/conversation`,
    async (route) => {
      await route.fulfill({
        status: 404,
        contentType: "application/json",
        body: JSON.stringify({ error: "log file not found for session" }),
      });
    },
  );

  await page.goto("/?nosup=1");

  await ensureInactiveItemVisible(page, "Empty conversation session");
  const inactiveItem = page.locator(`.pty-item.inactive`).filter({ hasText: "Empty conversation session" });
  await expect(inactiveItem).toBeVisible({ timeout: 10_000 });

  await inactiveItem.click();

  const previewModal = page.locator(".session-preview-modal");
  await expect(previewModal).toBeVisible({ timeout: 5_000 });

  // Should show "No messages found" since the API returned 404
  await expect(previewModal.locator(".session-preview-loading")).toContainText("No messages found", { timeout: 5_000 });

  // Close with overlay click
  await page.locator(".launch-modal-overlay").click({ position: { x: 5, y: 5 } });
  await expect(previewModal).not.toBeVisible({ timeout: 3_000 });
});
