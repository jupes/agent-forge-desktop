import { expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lockPath, tokenPath } from "../hearth/home";
import { ensurePrivateHome } from "../hearth/home-guard";
import { API_PREFIX, HEALTH_ROUTE, OPERATOR_HEADER } from "../hearth/paths";
import { writeOwnerOnly } from "../hearth/token";
import { liteRequest, readLite } from "./reader";

const projectId = "project-12345678-abcd-4eef-8aaa-123456789abc";
const now = "2026-11-20T01:00:00.000Z";
const empty = {
  asOf: now,
  trackerAvailable: false,
  sessionsComplete: false,
  projects: [],
  epics: [],
  beads: [],
  dependencies: [],
};
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

test("Lite reads the identified Hearth and returns only the selected project's validated trend data", async () => {
  const f = fixture();
  const calls: { path: string; method: string; credential: string | null }[] =
    [];
  let healthRoot = f.checkout;
  const credential = "a".repeat(64);
  const observation = {
    data: [{ date: "2026-11-20", count: 2 }],
    asOf: now,
    complete: true,
    source: "ledger",
    reason: null,
  };
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(request) {
      const path = new URL(request.url).pathname;
      calls.push({
        path,
        method: request.method,
        credential: request.headers.get(OPERATOR_HEADER),
      });
      const data =
        path === HEALTH_ROUTE
          ? { pid: process.pid, root: healthRoot }
          : path === API_PREFIX + "/projects/work-map"
            ? empty
            : {
                summary: {
                  projectId,
                  asOf: now,
                  runs: [],
                  sessions: ["private-incident"],
                },
                throughput: observation,
                beads: ["private-bead"],
              };
      return Response.json({ ok: true, data, error: null });
    },
  });
  try {
    ensurePrivateHome(f.home);
    const file = tokenPath(f.home, f.checkout);
    writeOwnerOnly(file, credential);
    writeFileSync(
      lockPath(f.home, f.checkout),
      JSON.stringify({
        pid: process.pid,
        port: server.port,
        root: f.checkout,
        startedAt: now,
        tokenFile: file,
      }),
      { mode: 0o600 },
    );
    expect(await readLite(["work-map", f.checkout], "unused", f.home)).toEqual(
      empty,
    );
    expect(
      await readLite(
        ["project-trends", f.checkout, projectId],
        "unused",
        f.home,
      ),
    ).toEqual({
      projectId,
      asOf: now,
      runs: [],
      throughput: observation,
    });
    expect(calls.map((c) => [c.method, c.path, c.credential])).toEqual([
      ["GET", HEALTH_ROUTE, null],
      ["GET", API_PREFIX + "/projects/work-map", credential],
      ["GET", HEALTH_ROUTE, null],
      ["GET", API_PREFIX + "/projects/" + projectId + "/overview", credential],
    ]);
    healthRoot = "other-checkout";
    await expect(
      readLite(["work-map", f.checkout], "unused", f.home),
    ).rejects.toThrow("could not be verified");
    expect(calls.at(-1)).toEqual({
      path: HEALTH_ROUTE,
      method: "GET",
      credential: null,
    });
  } finally {
    await server.stop(true);
    rmSync(f.folder, { recursive: true, force: true });
  }
});
