import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { API_PREFIX, HEALTH_ROUTE } from "../../scripts/hearth/paths";
import { withLiteHearth } from "../../scripts/lite/fixtures/live-hearth";

function read(
  executable: string,
  args: string[],
  checkout: string,
  home: string,
) {
  return new Promise<{ code: number; stdout: string; stderr: string }>(
    (resolve, reject) => {
      // These settings mirror the one-shot command launched by the Rust shell.
      execFile(
        executable,
        args,
        {
          cwd: checkout,
          env: { ...process.env, AGENT_FORGE_HOME: home },
          windowsHide: true,
          encoding: "utf8",
          timeout: 20_000,
          maxBuffer: 256 * 1024,
        },
        (error, stdout, stderr) => {
          const code = error ? error.code : 0;
          if (error?.killed || typeof code !== "number") {
            reject(
              Error(
                "The staged reader could not start or finish within its bounds",
              ),
            );
            return;
          }
          resolve({ code, stdout, stderr });
        },
      );
    },
  );
}

assert(
  process.platform === "win32" &&
    process.env.GITHUB_ACTIONS === "true" &&
    process.env.RUNNER_ENVIRONMENT === "github-hosted",
  "Use the isolated hosted Windows candidate",
);
const executable = realpathSync.native(
  resolve("apps/lite/build/windows-x64/desktop-host.exe"),
);
const temp = realpathSync.native(process.env.RUNNER_TEMP!);
const folder = realpathSync.native(mkdtempSync(join(temp, "forge-lite-auth-")));
assert(
  dirname(folder).toLowerCase() === temp.toLowerCase() &&
    basename(folder).startsWith("forge-lite-auth-"),
);
try {
  const checkout = join(folder, "checkout with spaces");
  const home = join(folder, "home");
  mkdirSync(join(checkout, ".git"), { recursive: true });
  mkdirSync(join(checkout, "scripts/hearth"), { recursive: true });
  writeFileSync(join(checkout, "scripts/hearth/server.ts"), "", { flag: "wx" });
  await withLiteHearth(checkout, home, async (hearth) => {
    for (let round = 1; round <= 2; round++) {
      for (const kind of ["work-map", "project-trends"] as const) {
        console.log(`Authenticated Lite read ${round}: ${kind}`);
        const map = kind === "work-map";
        const args = map
          ? [kind, checkout]
          : [kind, checkout, hearth.projectId];
        const start = hearth.calls.length;
        const result = await read(executable, args, checkout, home);
        assert(
          result.code === 0 && result.stderr === "",
          `Unexpected ${kind} reader exit or diagnostic`,
        );
        let publicData: unknown;
        try {
          publicData = JSON.parse(result.stdout);
        } catch {
          throw Error(`Invalid JSON from ${kind}`);
        }
        assert(
          isDeepStrictEqual(publicData, map ? hearth.workMap : hearth.trends),
          `Unexpected public ${kind} projection`,
        );
        const route = map
          ? "/projects/work-map"
          : `/projects/${hearth.projectId}/overview`;
        assert(
          isDeepStrictEqual(hearth.calls.slice(start), [
            { path: HEALTH_ROUTE, method: "GET", credential: null },
            {
              path: API_PREFIX + route,
              method: "GET",
              credential: hearth.credential,
            },
          ]),
          `Unexpected health or authenticated ${kind} request`,
        );
      }
    }
    console.log(
      "Checking the staged reader refuses a mismatched Hearth identity",
    );
    hearth.wrongHealthRoot();
    const start = hearth.calls.length;
    const refused = await read(
      executable,
      ["work-map", checkout],
      checkout,
      home,
    );
    assert(
      refused.code === 1 && refused.stdout === "" && refused.stderr === "",
      "Mismatched Hearth must fail privately",
    );
    assert(
      isDeepStrictEqual(hearth.calls.slice(start), [
        { path: HEALTH_ROUTE, method: "GET", credential: null },
      ]),
      "Expected only the credential-free health check after identity mismatch",
    );
  });
  console.log(
    "Four authenticated reader processes and one identity refusal verified",
  );
} finally {
  rmSync(folder, { recursive: true, force: true });
}
