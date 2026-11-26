import assert from "node:assert/strict";
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
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
import {
  asRecord,
  cdp,
  cdpEnable,
  evaluate,
  openCdp,
} from "../../scripts/desktop/webview-smoke-cdp";
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
  const origin = `http://127.0.0.1:${port}`;
  const started = Date.now();
  let last = "discovery has not answered";
  while (Date.now() - started < 45000) {
    assert(
      app.exitCode === null && app.signalCode === null,
      `Lite exited during discovery: ${app.exitCode ?? app.signalCode}`,
    );
    let targets: unknown;
    try {
      const response = await fetch(origin + "/json/list", {
        signal: AbortSignal.timeout(1000),
      });
      last = `discovery HTTP ${response.status}`;
      if (response.ok) targets = await response.json();
    } catch (error) {
      last =
        "discovery " +
        String(
          asRecord(error)?.code ??
            (error instanceof Error ? error.name : "unavailable"),
        );
    }
    if (Array.isArray(targets)) {
      last += `, ${targets.length} targets`;
      const target = targets
        .map(asRecord)
        .find(
          (row) =>
            row?.type === "page" &&
            typeof row.webSocketDebuggerUrl === "string",
        );
      if (target) {
        const url = new URL(String(target.webSocketDebuggerUrl));
        assert(
          url.protocol === "ws:" &&
            ["localhost", "127.0.0.1"].includes(url.hostname) &&
            url.port === String(port),
          "Unexpected WebView2 page socket",
        );
        console.log(
          `WebView2 page target discovered after ${Date.now() - started} ms (${last})`,
        );
        const socket = await openCdp(url.href);
        try {
          await cdpEnable(socket);
        } catch (error) {
          socket.close();
          throw error;
        }
        console.log("WebView2 page socket attached and enabled");
        return socket;
      }
    }
    await delay(250);
  }
  throw Error("WebView2 page discovery failed after 45s: " + last);
}

async function waitForUi(socket: WebSocket, condition: string, label: string) {
  const start = Date.now();
  while (Date.now() - start < 30000) {
    if (await evaluate(socket, `Boolean((${condition}))`)) {
      console.log(`${label} after ${Date.now() - start} ms`);
      return;
    }
    await delay(180);
  }
  throw Error("Timed out observing " + label);
}

function reportNativeState(app: ChildProcess, profile: string) {
  console.log("Native smoke state", {
    pid: app.pid,
    exit: app.exitCode,
    signal: app.signalCode,
    profileInitialized: [
      "Local State",
      "EBWebView/Local State",
      "Default",
      "EBWebView/Default",
    ].some((name) => existsSync(join(profile, name))),
  });
  if (!app.pid) return;
  const diagnostic = spawnSync(
    "pwsh.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `$p = Get-Process -Id ${app.pid} -ErrorAction SilentlyContinue
    $children = @(Get-CimInstance Win32_Process -Filter 'ParentProcessId = ${app.pid}')
    $title = if (!$p) {'exited'} elseif (!$p.MainWindowTitle) {'no window'} elseif ($p.MainWindowTitle -eq 'Agent Forge Lite') {'Lite window'} elseif ($p.MainWindowTitle -match 'WebView|Microsoft Edge') {'WebView runtime dialog'} else {'other window'}
    [pscustomobject]@{window=$title; responding=$p.Responding; webviewChildren=@($children | Where-Object Name -eq 'msedgewebview2.exe').Count; companionChildren=@($children | Where-Object Name -eq 'desktop-host.exe').Count} | ConvertTo-Json -Compress`,
    ],
    { windowsHide: true, timeout: 8000, encoding: "utf8" },
  );
  if (diagnostic.status === 0) console.log(diagnostic.stdout.trim());
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
  let socket: WebSocket | undefined;
  let written: string | undefined;
  try {
    await once(app, "spawn");
    socket = await attachWebView(app, port);
    await waitForUi(
      socket,
      `location.hostname === "tauri.localhost" && document.title === "Agent Forge Lite" && Array.from(document.querySelectorAll("h2")).some(h => h.textContent === "No projects in this catalog") && document.body.innerText.includes("Tracker data is unavailable.")`,
      "native empty catalog",
    );
    // A sentinel unknown to the built application distinguishes actual native
    // reads from a renderer that simply draws an empty graph or fixture.
    const saved = projectCatalogFixture(root);
    const name = `Native foundry ${randomUUID().slice(0, 8)}`;
    saved.projects[0]!.name = name;
    const bytes = JSON.stringify(saved);
    mkdirSync(dirname(catalogPath), { recursive: true });
    writeFileSync(catalogPath, bytes, { flag: "wx" });
    written = bytes;
    const button = asRecord(
      await evaluate(
        socket,
        `(() => {
      const button = Array.from(document.querySelectorAll("button")).find(b => !b.disabled && b.textContent.trim() === "Refresh");
      if (!button) return null;
      button.scrollIntoView({ block: "center" });
      const r = button.getBoundingClientRect(), x = r.x+r.width/2, y = r.y+r.height/2;
      return button.contains(document.elementFromPoint(x,y)) ? { x,y } : null;
    })()`,
      ),
    );
    assert(
      button && typeof button.x === "number" && typeof button.y === "number",
      "Native Refresh button did not become clickable",
    );
    for (const type of ["mousePressed", "mouseReleased"]) {
      await cdp(socket, "Input.dispatchMouseEvent", {
        type,
        x: button.x,
        y: button.y,
        button: "left",
        clickCount: 1,
      });
    }
    await waitForUi(
      socket,
      `Array.from(document.querySelectorAll('[aria-label="Portfolio graph"] button[data-kind="project"]')).some(b => b.getAttribute("aria-label") === ${JSON.stringify(name)} && b.getBoundingClientRect().width > 0) && !Array.from(document.querySelectorAll("h2")).some(h => h.textContent === "No projects in this catalog")`,
      "native saved-project refresh",
    );
    assert.equal(
      readFileSync(catalogPath, "utf8"),
      bytes,
      "Lite modified the fixture catalog",
    );
    const evidence = resolve(".tmp/screenshots/forge-lite/native-work-map.png");
    mkdirSync(dirname(evidence), { recursive: true });
    const screenshot = await cdp(socket, "Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: false,
    });
    assert(typeof screenshot.data === "string");
    const png = Buffer.from(screenshot.data, "base64");
    assert(png.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex")));
    writeFileSync(evidence, png);
    console.log(
      "Staged Agent Forge Lite rendered its empty catalog and refreshed the real saved project over native IPC.",
    );
  } catch (error) {
    reportNativeState(app, profile);
    if (socket?.readyState === WebSocket.OPEN) {
      const state = await evaluate(
        socket,
        `({
        localApp: location.hostname === "tauri.localhost", titleMatches: document.title === "Agent Forge Lite",
        ready: document.readyState, hidden: document.hidden,
        bridgePresent: typeof window.__TAURI_INTERNALS__?.invoke === "function",
        rendered: !!document.querySelector("#app > *"),
        readRefused: document.body.innerText.includes("Could not read this checkout"),
        empty: document.body.innerText.includes("No projects in this catalog"),
        projects: document.querySelectorAll('[aria-label="Portfolio graph"] button[data-kind="project"]').length
      })`,
      ).catch(() => "page state could not be read");
      console.log("Native renderer state", state);
    }
    throw error;
  } finally {
    try {
      socket?.close();
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
