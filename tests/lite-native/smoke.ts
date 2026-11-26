import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import {
  createReadStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { projectCatalogPath } from "../../scripts/projects/store";
import { projectCatalogFixture } from "../../scripts/projects/testing";

async function digest(path: string) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
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
  const catalog = projectCatalogPath(home);
  assert(!existsSync(catalog), "Native smoke requires an empty catalog");
  const portable = resolve("apps/lite/build/windows-x64");
  const executable = realpathSync.native(
    join(portable, "agent-forge-lite.exe"),
  );
  const protectedFiles = [
    executable,
    join(portable, "hearth.exe"),
    join(portable, "desktop-host.exe"),
    join(portable, ".forge-desktop-source.json"),
    join(root, "scripts/hearth/server.ts"),
  ];
  const before = await Promise.all(protectedFiles.map(digest));
  const work = mkdtempSync(join(temp, "forge-lite-webview-"));
  const saved = projectCatalogFixture(root);
  const name = `Native foundry ${randomUUID().slice(0, 8)}`;
  saved.projects[0]!.name = name;
  const bytes = JSON.stringify(saved);
  const template = join(work, "expected-catalog.json");
  writeFileSync(template, bytes, { flag: "wx" });
  mkdirSync(dirname(catalog), { recursive: true });
  const screenshot = resolve(".tmp/screenshots/forge-lite/native-work-map.png");
  mkdirSync(dirname(screenshot), { recursive: true });
  const app = spawn(executable, ["--root", root], {
    cwd: portable,
    shell: false,
    stdio: "ignore",
    env: {
      ...process.env,
      AGENT_FORGE_HOME: home,
      WEBVIEW2_USER_DATA_FOLDER: join(work, "profile"),
      // Chromium starts with its accessibility provider ready for the hosted UIA client.
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:
        "--force-renderer-accessibility=complete",
    },
  });
  try {
    await once(app, "spawn");
    assert(app.pid);
    // Windows PowerShell supplies the framework UI Automation assemblies.
    // The helper reads the real window and invokes its accessible Refresh button.
    const probe = spawnSync(
      "powershell.exe",
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Mta",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        resolve("tests/lite-native/window.ps1"),
        "-AppPid",
        String(app.pid),
        "-Executable",
        executable,
        "-Template",
        template,
        "-Catalog",
        catalog,
        "-ProjectName",
        name,
        "-Screenshot",
        screenshot,
      ],
      { windowsHide: true, timeout: 85000, stdio: "inherit" },
    );
    if (probe.error) throw probe.error;
    assert.equal(
      probe.status,
      0,
      "Native WebView accessibility journey failed",
    );
    assert.equal(
      readFileSync(catalog, "utf8"),
      bytes,
      "Lite modified the fixture catalog",
    );
    assert(
      readFileSync(screenshot)
        .subarray(0, 8)
        .equals(Buffer.from("89504e470d0a1a0a", "hex")),
    );
    const after = await Promise.all(protectedFiles.map(digest));
    assert.deepEqual(
      after,
      before,
      "The staged binaries, source marker, or workspace changed during the native read",
    );
    console.log(
      "Staged Lite showed the empty catalog and refreshed the unique saved project through its native WebView. Catalog and source hashes match.",
    );
  } finally {
    if (app.pid && app.exitCode === null && app.signalCode === null) app.kill();
    if (existsSync(catalog) && readFileSync(catalog, "utf8") === bytes)
      unlinkSync(catalog);
  }
}

await main();
