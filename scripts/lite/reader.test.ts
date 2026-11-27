import { test as bunTest, expect } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// Keep Windows native fixture setup in its own process and surface its exit
// separately from the source reader's. Both must complete all their assertions.
function test(name: string, verify: () => Promise<void>) {
  bunTest(name, async () => {
    if (process.platform !== "win32") return verify();
    const completed = `Verified Lite reader fixture: ${name}`;
    if (process.env.AGENT_FORGE_LITE_READER_TEST === name) {
      await verify();
      process.stdout.write(completed + "\n");
      return;
    }
    const child = Bun.spawnSync(
      [process.execPath, "test", "./scripts/lite/reader.test.ts", "-t", name],
      {
        cwd: resolve(import.meta.dir, "../.."),
        env: { ...process.env, AGENT_FORGE_LITE_READER_TEST: name },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        windowsHide: true,
        timeout: 10_000,
      },
    );
    expect(child.exitCode, child.stderr.toString()).toBe(0);
    expect(child.stdout.toString().split(/\r?\n/)).toContain(completed);
  });
}

const projectId = "project-12345678-abcd-4eef-8aaa-123456789abc";
function fixture() {
  const folder = realpathSync.native(
    mkdtempSync(join(tmpdir(), "forge lite ")),
  );
  const checkout = join(folder, "checkout with spaces");
  mkdirSync(join(checkout, ".git"), { recursive: true });
  mkdirSync(join(checkout, "scripts/hearth"), { recursive: true });
  writeFileSync(join(checkout, "scripts/hearth/server.ts"), "");
  return { folder, checkout, home: join(folder, "home") };
}

test("Lite accepts only its two fixed reads and keeps a fresh offline catalog read free of writes", async () => {
  const { liteRequest, readLite } = await import("./reader");
  const f = fixture();
  try {
    for (const args of [
      ["delete", f.checkout],
      ["work-map", f.checkout, "extra"],
      ["project-trends", f.checkout, "../secret"],
    ]) {
      expect(() => liteRequest(args)).toThrow();
    }
    expect(
      await readLite(["work-map", f.checkout], "unused", f.home),
    ).toMatchObject({
      projects: [],
      beads: [],
      trackerAvailable: false,
      sessionsComplete: false,
    });
    expect(readdirSync(f.folder)).toEqual(["checkout with spaces"]);
    await expect(
      readLite(["project-trends", f.checkout, projectId], "unused", f.home),
    ).rejects.toThrow("Hearth");
  } finally {
    rmSync(f.folder, { recursive: true, force: true });
  }
});

// A real Lite reader is one bounded process, with the Hearth HTTP owner in another.
async function sourceRead(home: string, args: string[]): Promise<unknown> {
  const child = Bun.spawn(
    [process.execPath, join(import.meta.dir, "fixtures/read-once.ts"), ...args],
    {
      env: { ...process.env, AGENT_FORGE_HOME: home },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      windowsHide: true,
      timeout: 4000,
    },
  );
  const [code, output, error] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (code === 1) throw Error(error);
  if (code !== 0)
    throw Error(`Reader child terminated with code ${code}: ${error}`);
  try {
    return JSON.parse(output);
  } catch {
    throw Error("The Lite source reader returned invalid JSON.");
  }
}

test("Lite reads the identified Hearth and returns only the selected project's validated trend data", async () => {
  const { API_PREFIX, HEALTH_ROUTE } = await import("../hearth/paths");
  const { withLiteHearth } = await import("./fixtures/live-hearth");
  const f = fixture();
  try {
    await withLiteHearth(f.checkout, f.home, async (hearth) => {
      expect(await sourceRead(f.home, ["work-map", f.checkout])).toEqual(
        hearth.workMap,
      );
      expect(
        await sourceRead(f.home, ["project-trends", f.checkout, projectId]),
      ).toEqual(hearth.trends);
      const auth = hearth.credential;
      expect(hearth.calls.map((c) => [c.method, c.path, c.credential])).toEqual(
        [
          ["GET", HEALTH_ROUTE, null],
          ["GET", API_PREFIX + "/projects/work-map", auth],
          ["GET", HEALTH_ROUTE, null],
          ["GET", API_PREFIX + "/projects/" + projectId + "/overview", auth],
        ],
      );
      hearth.wrongHealthRoot();
      await expect(
        sourceRead(f.home, ["work-map", f.checkout]),
      ).rejects.toThrow("could not be verified");
      expect(hearth.calls.slice(4)).toEqual([
        { path: HEALTH_ROUTE, method: "GET", credential: null },
      ]);
    });
  } finally {
    rmSync(f.folder, { recursive: true, force: true });
  }
});
