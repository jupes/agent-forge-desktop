import { existsSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import { projectTrendsSchema } from "../../apps/lite/protocol";
import { hearthHome, lockPath, tokenPath } from "../hearth/home";
import { readHomeFile, readHomeLock } from "../hearth/home-guard";
import { isPidAlive, sameLock } from "../hearth/lock";
import { healthProblem, loopbackExchange } from "../hearth/loopback";
import { API_PREFIX, OPERATOR_HEADER } from "../hearth/paths";
import { localStateRoot } from "../hearth/routes/dev-api";
import { projectSnapshotReader } from "../hearth/routes/project-summaries";
import { resolveCheckout } from "../ledger/workspace";
import {
  ownTrackerReader,
  trackerChild,
} from "../projects/complete-tracker-reader";
import { projectWorkMap } from "../projects/project-work-map";
import {
  MAX_PROJECT_WORK_MAP_BYTES,
  projectWorkMapSchema,
} from "../projects/project-work-map-protocol";
import { workspaceKey } from "../projects/scope";
import { isProjectId } from "../projects/store";

const unavailable = "The selected workspace's Hearth could not be verified.";
const overview = z.object({
  summary: projectTrendsSchema.pick({
    projectId: true,
    asOf: true,
    runs: true,
  }),
  throughput: projectTrendsSchema.shape.throughput,
});

export function liteRequest(args: string[]) {
  const [kind, root, projectId] = args;
  if (
    !root ||
    !(
      (kind === "work-map" && args.length === 2) ||
      (kind === "project-trends" && args.length === 3 && isProjectId(projectId))
    )
  ) {
    throw Error("Invalid Lite read.");
  }
  const checkout = realpathSync.native(root);
  if (
    !existsSync(join(checkout, ".git")) ||
    !existsSync(join(checkout, "scripts/hearth/server.ts"))
  ) {
    throw Error("Choose an Agent Forge harness checkout.");
  }
  return { kind, checkout, projectId };
}

export async function readLite(
  args: string[],
  trackerExecutable = join(dirname(process.execPath), "hearth.exe"),
  home = hearthHome(),
) {
  const { kind, checkout, projectId } = liteRequest(args);
  const lock = readHomeLock(home, lockPath(home, checkout));
  if (lock.problem) throw Error(unavailable);

  if (lock.lock && isPidAlive(lock.lock.pid)) {
    const active = lock.lock;
    const file = tokenPath(home, checkout);
    if (
      workspaceKey(active.root) !== workspaceKey(checkout) ||
      resolve(active.tokenFile) !== resolve(file) ||
      (await healthProblem(active)) !== null
    ) {
      throw Error(unavailable);
    }
    const token = readHomeFile(home, file);
    const confirmed = readHomeLock(home, lockPath(home, checkout));
    if (confirmed.problem !== null || !sameLock(active, confirmed.lock))
      throw Error(unavailable);
    if (
      token.problem !== null ||
      !/^[a-f0-9]{64}$/.test(token.text?.trim() ?? "")
    )
      throw Error(unavailable);
    const target =
      kind === "work-map"
        ? "/projects/work-map"
        : "/projects/" + projectId + "/overview";
    const result = await loopbackExchange({
      port: active.port,
      method: "GET",
      target: API_PREFIX + target,
      headers: {
        origin: "http://127.0.0.1:" + active.port,
        [OPERATOR_HEADER]: token.text!.trim(),
      },
      timeoutMs: 12000,
      maxBytes: MAX_PROJECT_WORK_MAP_BYTES + 4096,
    });
    if (result.status !== 200)
      throw Error("The Hearth could not supply the requested observation.");
    const envelope = z
      .object({ ok: z.literal(true), data: z.unknown(), error: z.null() })
      .parse(JSON.parse(result.body));
    if (kind === "work-map") return projectWorkMapSchema.parse(envelope.data);
    const data = overview.parse(envelope.data);
    if (data.summary.projectId !== projectId)
      throw Error("The project observation belongs to a different project.");
    return projectTrendsSchema.parse({
      ...data.summary,
      throughput: data.throughput,
    });
  }

  if (kind !== "work-map")
    throw Error(
      "Start the Hearth for this checkout to see recorded project history.",
    );
  // Without a live owner, the current tracker can still show status and delivery
  // but cannot establish an active agent turn. Membership-only reads never open the ledger.
  const snapshot = projectSnapshotReader(
    home,
    {
      root: checkout,
      workspace: resolveCheckout(checkout).workspace,
      ledgerPath: "",
      runBd: async () => {
        throw Error("This reader supports a complete tracker read only.");
      },
      completeTracker: ownTrackerReader(
        localStateRoot(checkout),
        trackerChild([trackerExecutable]),
      ),
    },
    { membershipOnly: true },
  );
  const { catalog, source } = await snapshot();
  const map = projectWorkMap(catalog, source, () => undefined);
  if (Buffer.byteLength(JSON.stringify(map)) > MAX_PROJECT_WORK_MAP_BYTES)
    throw Error("The Work Map exceeds the local read limit.");
  return projectWorkMapSchema.parse(map);
}
