import { existsSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { lockPath, tokenPath } from "../../hearth/home";
import { ensurePrivateHome } from "../../hearth/home-guard";
import { API_PREFIX, HEALTH_ROUTE, OPERATOR_HEADER } from "../../hearth/paths";
import { writeOwnerOnly } from "../../hearth/token";

const projectId = "project-12345678-abcd-4eef-8aaa-123456789abc";
const asOf = "2026-11-20T01:00:00.000Z";
const workMap = {
  asOf,
  trackerAvailable: true,
  sessionsComplete: true,
  projects: [
    {
      id: projectId,
      name: "Live forge",
      archived: false,
      availability: "available",
    },
  ],
  epics: [],
  beads: [],
  dependencies: [],
};
const trends = {
  projectId,
  asOf,
  runs: [],
  throughput: {
    data: [{ date: "2026-11-20", count: 2 }],
    asOf,
    complete: true,
    source: "ledger",
    reason: null,
  },
};
interface LiteHearthFixture {
  projectId: string;
  workMap: typeof workMap;
  trends: typeof trends;
  calls: { path: string; method: string; credential: string | null }[];
  credential: string;
  wrongHealthRoot(): void;
}

/** Own a fresh fixture home and serve it from a different process than the readers. */
export async function withLiteHearth(
  checkout: string,
  home: string,
  run: (fixture: LiteHearthFixture) => Promise<void>,
): Promise<void> {
  const credential = "a".repeat(64);
  const calls: LiteHearthFixture["calls"] = [];
  let healthRoot = checkout;
  const server = createServer((request, response) => {
    const path = request.url ?? "";
    const secret = request.headers[OPERATOR_HEADER.toLowerCase()];
    const method = request.method ?? "";
    calls.push({
      path,
      method,
      credential: typeof secret === "string" ? secret : null,
    });
    let data: unknown;
    if (method !== "GET") response.statusCode = 405;
    else if (path === HEALTH_ROUTE && secret === undefined)
      data = { pid: process.pid, root: healthRoot };
    else if (secret !== credential) response.statusCode = 403;
    else if (path === API_PREFIX + "/projects/work-map") data = workMap;
    else if (path === API_PREFIX + "/projects/" + projectId + "/overview") {
      data = {
        summary: { projectId, asOf, runs: [], sessions: ["private-incident"] },
        throughput: trends.throughput,
        beads: ["private-bead"],
      };
    } else response.statusCode = 404;
    const payload = JSON.stringify({
      ok: data !== undefined,
      data,
      error: data === undefined ? "Fixture refused" : null,
    });
    response.setHeader("Content-Type", "application/json");
    response.setHeader("Content-Length", Buffer.byteLength(payload));
    response.end(payload);
  });
  // Refuse to take ownership of an existing home.
  if (existsSync(home)) throw Error("Choose an unused fixture home");
  try {
    ensurePrivateHome(home);
    const tokenFile = tokenPath(home, checkout);
    writeOwnerOnly(tokenFile, credential);
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    try {
      const address = server.address();
      if (!address || typeof address === "string")
        throw Error("Missing fixture port");
      writeFileSync(
        lockPath(home, checkout),
        JSON.stringify({
          pid: process.pid,
          port: address.port,
          root: checkout,
          startedAt: asOf,
          tokenFile,
        }),
        { mode: 0o600 },
      );
      await run({
        projectId,
        workMap,
        trends,
        calls,
        credential,
        wrongHealthRoot() {
          healthRoot = "other-checkout";
        },
      });
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}
