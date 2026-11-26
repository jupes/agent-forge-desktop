import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { basename, dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { type Browser, chromium } from "@playwright/test";
import { projectCatalogPath } from "../../scripts/projects/store";
import { projectCatalogFixture } from "../../scripts/projects/testing";

// Connect to the staged application's WebView2 on the disposable hosted runner.
// No WebView flag, additional permission, mock bridge, or test bundle ships.
async function loopbackPort(): Promise<number> {
  const reservation = createServer();
  reservation.listen(0, "127.0.0.1");
  await once(reservation, "listening");
  const address = reservation.address();
  assert(address && typeof address === "object");
  await new Promise<void>((done, fail) =>
    reservation.close((err) => (err ? fail(err) : done())),
  );
  return address.port;
}

async function attachWebView(app: ChildProcess, port: number) {
  const endpoint = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    assert(
      app.exitCode === null && app.signalCode === null,
      "Lite exited before WebView2 opened",
    );
    try {
      const response = await fetch(endpoint + "/json/version", {
        signal: AbortSignal.timeout(1000),
      });
      if (response.ok)
        return await chromium.connectOverCDP(endpoint, { timeout: 5000 });
    } catch {
      // The WebView and its CDP endpoint start asynchronously.
    }
    await delay(250);
  }
  throw new Error(
    "The staged Lite window's WebView2 endpoint did not become ready",
  );
}

async function main() {
  assert(
    process.platform === "win32" &&
      process.env.GITHUB_ACTIONS === "true" &&
      process.env.RUNNER_ENVIRONMENT === "github-hosted",
    "Native Lite smoke runs only on an isolated GitHub-hosted Windows runner",
  );
  const temp = realpathSync.native(process.env.RUNNER_TEMP!);
  const root = realpathSync.native(process.argv[2]!);
  const home = realpathSync.native(process.env.AGENT_FORGE_HOME!);
  for (const [path, prefix] of [
    [root, "forge-lite-source-"],
    [home, "forge-lite-home-"],
  ] as const) {
    assert.equal(dirname(path).toLowerCase(), temp.toLowerCase());
    assert(
      basename(path).startsWith(prefix),
      "Expected a disposable CI fixture",
    );
  }
  const catalogPath = projectCatalogPath(home);
  assert(
    !existsSync(catalogPath),
    "Native smoke requires the fresh empty catalog fixture",
  );
  const portable = resolve("apps/lite/build/windows-x64");
  const executable = realpathSync.native(
    join(portable, "agent-forge-lite.exe"),
  );
  const profile = mkdtempSync(join(temp, "forge-lite-webview-"));
  const port = await loopbackPort();
  const app = spawn(executable, ["--root", root], {
    cwd: portable,
    shell: false,
    stdio: "ignore",
    env: {
      ...process.env,
      AGENT_FORGE_HOME: home,
      WEBVIEW2_USER_DATA_FOLDER: profile,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-address=127.0.0.1 --remote-debugging-port=${port}`,
    },
  });
  let browser: Browser | undefined;
  let written: string | undefined;
  try {
    await once(app, "spawn");
    browser = await attachWebView(app, port);
    const context = browser.contexts()[0];
    assert(context, "The hosted WebView2 has no default context");
    const page =
      context.pages()[0] ??
      (await context.waitForEvent("page", { timeout: 15000 }));
    await page.waitForURL(/^https?:\/\/tauri\.localhost\//, { timeout: 15000 });
    assert.equal(await page.title(), "Agent Forge Lite");
    await page
      .getByRole("heading", { name: "No projects in this catalog" })
      .waitFor({ timeout: 30000 });
    await page
      .getByText("Tracker data is unavailable.", { exact: false })
      .waitFor({ timeout: 5000 });

    // A sentinel unknown to the built application distinguishes actual native
    // reads from a renderer that simply draws an empty graph or fixture.
    const saved = projectCatalogFixture(root);
    const name = `Native foundry ${randomUUID().slice(0, 8)}`;
    saved.projects[0]!.name = name;
    const bytes = JSON.stringify(saved);
    mkdirSync(dirname(catalogPath), { recursive: true });
    writeFileSync(catalogPath, bytes, { flag: "wx" });
    written = bytes;
    await page.getByRole("button", { name: "Refresh", exact: true }).click();
    const graph = page.getByRole("group", { name: "Portfolio graph" });
    await graph
      .getByRole("button", { name, exact: true })
      .waitFor({ timeout: 30000 });
    assert.equal(
      await page
        .getByRole("heading", { name: "No projects in this catalog" })
        .count(),
      0,
    );
    assert.equal(
      readFileSync(catalogPath, "utf8"),
      bytes,
      "Lite modified the fixture catalog",
    );
    const evidence = resolve(".tmp/screenshots/forge-lite/native-work-map.png");
    mkdirSync(dirname(evidence), { recursive: true });
    await page.screenshot({ path: evidence, animations: "disabled" });
    console.log(
      "Staged Agent Forge Lite rendered its empty catalog and refreshed the real saved project over native IPC.",
    );
  } finally {
    try {
      await browser?.close();
    } finally {
      if (app.pid && app.exitCode === null && app.signalCode === null)
        app.kill();
      if (
        written !== undefined &&
        readFileSync(catalogPath, "utf8") === written
      )
        unlinkSync(catalogPath);
    }
  }
}

await main();
