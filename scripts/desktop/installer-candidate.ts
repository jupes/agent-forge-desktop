import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import {
  nsisNoticePath,
  nsisNotices,
  verifyNsisNoticePayloads,
} from "../distribution/nsis-notices";
import { isMain } from "../is-main";

export interface InstallerResource {
  path: string;
  source: string;
  bytes: number;
  sha256: string;
}

export const witnessToolPaths = [
  "installer-tools/WitnessedRc2Upgrade.psm1",
  "installer-tools/Rc2ResourceWitness.cs",
] as const;
const priorDashboardAsset = "dashboard/assets/index-iTXU0aPJ.js";
const maxToolBytes = 128 * 1024;

const required = [
  "LICENSE",
  "NOTICE",
  "THIRD-PARTY-NOTICES.txt",
  "DISTRIBUTION-NOTICES.txt",
  "DISTRIBUTION-INVENTORY.json",
  "RUNTIME-DEPENDENCY-INVENTORY.json",
  "COMPILED-DEPENDENCY-INVENTORY.json",
  ".claude/skills/ATTRIBUTION.md",
  "docs/fonts/LICENSE-Inter.txt",
  ...witnessToolPaths,
];
const excluded = new Set([
  "agent-forge-desktop.exe",
  "desktop-host.exe",
  "hearth.exe",
  "CANDIDATE.json",
  "MANUAL-TESTING.md",
]);
const digest = (file: string) =>
  createHash("sha256").update(readFileSync(file)).digest("hex");

export function installerMainBinaryIdentity(
  portable: Uint8Array,
  packaged: Uint8Array,
): { mainBinarySha256: string; portableMainBinarySha256: string } {
  if (
    portable.length === 0 ||
    portable.length > 64 * 1024 * 1024 ||
    packaged.length !== portable.length
  )
    throw Error("Invalid installer executable size");
  const original = Buffer.from(portable);
  const marker = Buffer.from("__TAURI_BUNDLE_TYPE_VAR_UNK");
  const offset = original.indexOf(marker);
  if (
    offset < 0 ||
    original.indexOf(marker, offset + 1) !== -1 ||
    original.includes(Buffer.from("__TAURI_BUNDLE_TYPE_VAR_NSS"))
  )
    throw Error("Unverified portable executable bundle marker");
  // Pinned Tauri 2.12.3 patches this marker for NSIS, then restores its input.
  const expected = Buffer.from(original);
  Buffer.from("__TAURI_BUNDLE_TYPE_VAR_NSS").copy(expected, offset);
  if (!expected.equals(packaged))
    throw Error("NSIS payload differs beyond the verified bundle marker");
  return {
    mainBinarySha256: createHash("sha256").update(packaged).digest("hex"),
    portableMainBinarySha256: createHash("sha256")
      .update(original)
      .digest("hex"),
  };
}

function safe(path: string): boolean {
  return (
    path.length > 0 &&
    path.length <= 512 &&
    !path.startsWith("/") &&
    !/[\\:<>?"*|]/.test(path) &&
    [...path].every((char) => char.charCodeAt(0) >= 32) &&
    path
      .split("/")
      .every(
        (part) =>
          part &&
          part !== "." &&
          part !== ".." &&
          !part.endsWith(".") &&
          part.trimEnd() === part,
      )
  );
}

export function planInstallerResources(
  stage: string,
  backend: string,
): {
  resources: Record<string, string>;
  files: InstallerResource[];
} {
  if (resolve(stage) !== resolve(backend, "../build/windows-x64"))
    throw Error("Unexpected installer input stage");
  for (const directory of [
    stage,
    dirname(stage),
    dirname(dirname(stage)),
    backend,
  ]) {
    const stat = lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw Error("Linked installer input directory");
  }
  const resources: Record<string, string> = {
    "../../../docs/dist/": "dashboard/",
  };
  const reserved = priorDashboardAsset.slice("dashboard/".length);
  for (const path of [
    join(stage, priorDashboardAsset),
    resolve(backend, "../../../docs/dist", reserved),
  ]) {
    if (lstatSync(path, { throwIfNoEntry: false }))
      throw Error("Incoming dashboard overlaps the witnessed RC2 asset");
  }
  const files: InstallerResource[] = [];
  const names = new Set<string>();
  let count = 0,
    bytes = 0;
  const walk = (directory: string) => {
    for (const name of readdirSync(directory).sort()) {
      const file = join(directory, name),
        stat = lstatSync(file);
      if (++count > 10000 || stat.isSymbolicLink())
        throw Error("Unbounded or linked installer input");
      if (stat.isDirectory()) {
        walk(file);
        continue;
      }
      if (!stat.isFile()) throw Error("Non-regular installer input");
      bytes += stat.size;
      if (bytes > 1073741824) throw Error("Installer input exceeds one GiB");
      const path = relative(stage, file).replaceAll("\\", "/");
      if (!safe(path) || names.has(path.toLowerCase()))
        throw Error("Unsafe or duplicate installer output");
      names.add(path.toLowerCase());
      if (excluded.has(path) || path.startsWith("dashboard/")) continue;
      if (!required.includes(path) && !path.startsWith("legal/"))
        throw Error("Unexpected installer resource: " + path);
      if (stat.size === 0 || stat.size > 16 * 1024 * 1024)
        throw Error("Invalid installer resource size");
      const source = relative(backend, file).replaceAll("\\", "/");
      resources[source] = path;
      files.push({ path, source, bytes: stat.size, sha256: digest(file) });
    }
  };
  walk(stage);
  for (const notice of nsisNotices) {
    const file = files.find((row) => row.path === nsisNoticePath(notice));
    if (file?.bytes !== notice.bytes || file.sha256 !== notice.sha256)
      throw Error(`Missing or altered NSIS notice: ${notice.name}`);
  }
  if (
    required.some((path) => !files.some((file) => file.path === path)) ||
    !files.some(
      (file) =>
        file.path.startsWith("legal/") &&
        !nsisNotices.some((notice) => nsisNoticePath(notice) === file.path),
    )
  )
    throw Error("Missing required installer notices");
  return { resources, files };
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw Error("Invalid candidate object");
  return value as Record<string, unknown>;
}
function json(path: string): Record<string, unknown> {
  try {
    return object(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    throw Error(
      "Cannot read candidate metadata: " +
        relative(resolve(import.meta.dir, "../.."), path),
    );
  }
}

export function verifyResourceSnapshot(
  files: InstallerResource[],
  raw: unknown,
): void {
  if (!Array.isArray(raw) || raw.length > 10000)
    throw Error("Invalid candidate file snapshot");
  const index = new Map<
    string,
    { path: string; bytes: number; sha256: string }
  >();
  for (const item of raw) {
    const row = object(item),
      path = row.path,
      bytes = row.bytes,
      sha256 = row.sha256;
    if (
      typeof path !== "string" ||
      !safe(path) ||
      typeof bytes !== "number" ||
      !Number.isSafeInteger(bytes) ||
      bytes < 0 ||
      typeof sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(sha256) ||
      index.has(path.toLowerCase())
    )
      throw Error("Invalid candidate file snapshot");
    index.set(path.toLowerCase(), { path, bytes, sha256 });
  }
  for (const file of files) {
    const original = index.get(file.path.toLowerCase());
    if (
      !original ||
      original.path !== file.path ||
      original.bytes !== file.bytes ||
      original.sha256 !== file.sha256
    )
      throw Error("Installer resource differs from verified portable snapshot");
  }
}

export function assertHostedInstallerBuild(
  actions: string | undefined,
  platform: string,
  arch: string,
): void {
  if (actions !== "true" || platform !== "win32" || arch !== "x64")
    throw Error("Installer compilation is restricted to hosted Windows x64 CI");
}

export function verifyWitnessPayloads(
  resources: InstallerResource[],
  sourceFiles: unknown,
  readMember: (path: string) => Buffer,
): void {
  if (!Array.isArray(sourceFiles)) throw Error("Missing desktop source files");
  for (const path of witnessToolPaths) {
    const staged = resources.find((row) => row.path === path);
    const owned = sourceFiles.filter(
      (row) => object(row).path === `apps/desktop/${path}`,
    );
    if (
      !staged ||
      staged.bytes < 1 ||
      staged.bytes > maxToolBytes ||
      owned.length !== 1 ||
      object(owned[0]).sha256 !== staged.sha256
    )
      throw Error("Witness tool differs from assembled source");
    const packed = readMember(path);
    if (
      packed.length !== staged.bytes ||
      createHash("sha256").update(packed).digest("hex") !== staged.sha256
    )
      throw Error("Witness tool differs in the NSIS payload");
  }
}

function readInstallerMember(
  installer: string,
  path: string,
  maxBuffer: number,
  matchCase = false,
) {
  const options = ["e", "-so", "-bd", "-bso0", "-bse1", "-bsp0"];
  if (matchCase) options.push("-ssc");
  return execFileSync("7z", [...options, installer, path], {
    timeout: 15_000,
    maxBuffer,
    windowsHide: true,
  });
}

async function main(): Promise<void> {
  assertHostedInstallerBuild(
    process.env.GITHUB_ACTIONS,
    process.platform,
    process.arch,
  );
  const root = resolve(import.meta.dir, "../.."),
    app = join(root, "apps/desktop"),
    backend = join(app, "src-tauri");
  const stage = join(app, "build/windows-x64"),
    out = join(app, "build/installer-candidate");
  const source = json(join(root, ".forge-desktop-source.json")),
    candidate = json(join(stage, "CANDIDATE.json"));
  const head = source.desktopCommit,
    version = source.desktopVersion;
  if (
    typeof head !== "string" ||
    !/^[a-f0-9]{40}$/.test(head) ||
    head !== process.env.CANDIDATE_SOURCE_SHA ||
    candidate.sourceCommit !== head ||
    candidate.engineCommit !== source.engineCommit ||
    candidate.desktopSourceDigest !== source.sourceDigest ||
    typeof candidate.sourceTree !== "string" ||
    !/^[a-f0-9]{40}$/.test(candidate.sourceTree) ||
    typeof version !== "string" ||
    !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)
  )
    throw Error("Installer source identity mismatch");
  const config = json(join(backend, "tauri.conf.json"));
  const bundle = object(config.bundle),
    resources = object(bundle.resources),
    build = object(config.build);
  if (
    Object.keys(resources).length !== 1 ||
    resources["../../../docs/dist/"] !== "dashboard/" ||
    build.beforeBundleCommand !== undefined
  )
    throw Error("Unreviewed base bundle resources or hook");
  if (
    json(join(root, "node_modules/@tauri-apps/cli/package.json")).version !==
    "2.12.3"
  )
    throw Error("Unexpected Tauri CLI");
  const plan = planInstallerResources(stage, backend);
  verifyResourceSnapshot(plan.files, candidate.files);
  mkdirSync(out);
  const overlay = join(out, "bundle-config.json");
  writeFileSync(
    overlay,
    JSON.stringify({ bundle: { resources: plan.resources } }, null, 2) + "\n",
    { flag: "wx" },
  );
  // The workflow bounds this complete process tree to eight minutes. No product executable is launched.
  const child = Bun.spawn(
    [
      process.execPath,
      "tauri",
      "bundle",
      "--bundles",
      "nsis",
      "--no-sign",
      "--ci",
      "--config",
      overlay,
    ],
    {
      cwd: app,
      stdin: "ignore",
      stdout: "inherit",
      stderr: "inherit",
      windowsHide: true,
    },
  );
  const code = await child.exited;
  if (code !== 0) throw Error("NSIS candidate bundling failed: " + code);
  const target = resolve(
    process.env.CARGO_TARGET_DIR ?? join(backend, "target"),
  );
  const installers = readdirSync(join(target, "release/bundle/nsis")).filter(
    (name) => name.endsWith("-setup.exe"),
  );
  if (installers.length !== 1) throw Error("Ambiguous installer output");
  const installer = join(target, "release/bundle/nsis", installers[0]!);
  const stat = lstatSync(installer);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.size < 1024 * 1024 ||
    stat.size > 1073741824
  )
    throw Error("Invalid installer output");
  const rendered = join(target, "release/nsis/x64/installer.nsi");
  const portableMainPath = join(target, "release/agent-forge-desktop.exe");
  const mainStat = lstatSync(portableMainPath);
  if (
    !mainStat.isFile() ||
    mainStat.isSymbolicLink() ||
    mainStat.size < 1 ||
    mainStat.size > 64 * 1024 * 1024
  )
    throw Error("Invalid portable executable input");
  const portableMain = readFileSync(portableMainPath);
  // Read the actual payload without executing it. Refuse extraction or byte drift.
  const packagedMain = readInstallerMember(
    installer,
    "agent-forge-desktop.exe",
    64 * 1024 * 1024,
  );
  verifyWitnessPayloads(plan.files, source.files, (path) =>
    readInstallerMember(installer, path, maxToolBytes),
  );
  verifyNsisNoticePayloads((path, limit) =>
    readInstallerMember(installer, path, limit, true),
  );
  const mainIdentity = installerMainBinaryIdentity(portableMain, packagedMain);
  verifyResourceSnapshot(
    [
      {
        path: "agent-forge-desktop.exe",
        source: relative(backend, portableMainPath).replaceAll("\\", "/"),
        bytes: portableMain.length,
        sha256: mainIdentity.portableMainBinarySha256,
      },
    ],
    candidate.files,
  );
  const outputName = `Agent-Forge-Harness-${version}-windows-x64-setup.exe`;
  copyFileSync(installer, join(out, outputName));
  copyFileSync(rendered, join(out, "installer.nsi"));
  copyFileSync(
    join(backend, "installer/SOURCE.json"),
    join(out, "INSTALLER-SOURCE.json"),
  );
  copyFileSync(
    join(root, "apps/desktop/docs/manual-installer-candidate.md"),
    join(out, "INSTALLER-TESTING.md"),
  );
  const includes = readdirSync(dirname(rendered))
    .filter((name) => name.endsWith(".nsh"))
    .sort();
  if (includes.length === 0 || includes.length > 32)
    throw Error("Unexpected compiler includes");
  mkdirSync(join(out, "compiler-inputs"));
  const compilerInputs = includes.map((name) => {
    const file = join(dirname(rendered), name),
      stat = lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 512 * 1024)
      throw Error("Invalid compiler include");
    copyFileSync(file, join(out, "compiler-inputs", name));
    return {
      path: "compiler-inputs/" + name,
      bytes: stat.size,
      sha256: digest(file),
    };
  });
  const manifest = {
    schemaVersion: 2,
    kind: "unsigned-nsis-engineering-candidate",
    productVersion: version,
    sourceCommit: head,
    sourceTree: candidate.sourceTree,
    engineCommit: source.engineCommit,
    desktopSourceDigest: source.sourceDigest,
    runId: process.env.GITHUB_RUN_ID,
    runAttempt: process.env.GITHUB_RUN_ATTEMPT,
    installerBuilt: true,
    installerExecuted: false,
    nativeAppLaunched: false,
    signed: false,
    manualAcceptance: "pending",
    releaseDisposition: "hold",
    installer: {
      path: outputName,
      bytes: stat.size,
      sha256: digest(installer),
    },
    templateSha256: digest(join(backend, "installer/installer.nsi")),
    ...mainIdentity,
    mainBinaryVerification: "extracted-nsis-payload-v1",
    sidecars: ["desktop-host", "hearth"].map((name) => ({
      path: name + ".exe",
      sha256: digest(
        join(backend, "binaries", name + "-x86_64-pc-windows-msvc.exe"),
      ),
    })),
    compilerInputs,
    renderedScriptSha256: digest(rendered),
    overlaySha256: digest(overlay),
    portableSnapshotSha256: digest(join(stage, "CANDIDATE.json")),
    resourceFiles: plan.files,
    holds: [
      "Unsigned review candidate; publisher key/channel and release signing remain pending.",
      "Installer runtime, startup/retirement, upgrade/uninstall and human acceptance remain pending.",
      "Runtime source/relink and current installer redistribution obligations remain open; included inventories retain their holds.",
    ],
  };
  writeFileSync(
    join(out, "INSTALLER-CANDIDATE.json"),
    JSON.stringify(manifest, null, 2) + "\n",
    { flag: "wx" },
  );
  console.log(
    JSON.stringify({
      ok: true,
      data: {
        directory: relative(root, out).replaceAll("\\", "/"),
        installerBuilt: true,
        installerExecuted: false,
      },
      error: null,
    }),
  );
}

if (isMain(import.meta)) {
  main().catch((error: unknown) => {
    console.error(
      JSON.stringify({
        ok: false,
        data: null,
        error:
          error instanceof Error ? error.message : "Installer candidate failed",
      }),
    );
    process.exitCode = 1;
  });
}
