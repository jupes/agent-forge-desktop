import { createHash } from "node:crypto";
import { cp, lstat, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";

const root = resolve(import.meta.dir, "..");
const engine = join(root, "engine");
export const workspace = join(root, ".work", "desktop");

async function json(file: string): Promise<Record<string, unknown>> {
  try {
    const value: unknown = JSON.parse(await readFile(file, "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw Error();
    return value as Record<string, unknown>;
  } catch {
    throw Error(`Cannot read valid metadata: ${relative(root, file)}`);
  }
}

export async function command(argv: string[], cwd = root, timeout = 60_000) {
  const child = Bun.spawn(argv, {
    cwd,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "Never" },
    windowsHide: true,
  });
  const output = new Response(child.stdout).text();
  const errors = new Response(child.stderr).text();
  const timer = setTimeout(() => child.kill(), timeout);
  try {
    const code = await child.exited;
    const [stdout, stderr] = await Promise.all([output, errors]);
    if (code !== 0) throw Error(`${argv[0]} ${argv[1]} failed (${code}): ${stderr.slice(-4000)}`);
    return stdout;
  } finally {
    clearTimeout(timer);
  }
}

const git = (args: string[], cwd = root) => command([
  "git", "-c", `safe.directory=${root}`, "-c", `safe.directory=${engine}`,
  "-c", `safe.directory=${workspace}`, "-c", "maintenance.auto=false", "-c", "gc.auto=0", ...args,
], cwd);

function safe(file: string): string {
  if (!file || file.includes("\\") || file.includes("\0") || file.startsWith("/") || file.split("/").includes("..")) {
    throw Error("Invalid source path");
  }
  const target = resolve(workspace, file);
  if (!target.startsWith(workspace + sep)) throw Error("Source path escapes build workspace");
  return target;
}

export async function prepare(): Promise<string> {
  const lock = await json(join(root, "engine.lock.json"));
  if (lock.repository !== "https://github.com/jupes/agent-forge-harness.git" ||
      typeof lock.commit !== "string" || !/^[0-9a-f]{40}$/.test(lock.commit)) {
    throw Error("Invalid immutable engine pin");
  }
  const actualEngine = (await git(["rev-parse", "HEAD"], engine)).trim();
  if (actualEngine !== lock.commit) throw Error("Engine checkout differs from engine.lock.json; initialize the pinned submodule");
  if ((await git(["status", "--porcelain", "--untracked-files=no"], engine)).trim()) {
    throw Error("Engine has tracked edits; commit and update its pin explicitly");
  }
  const owned = await json(join(root, "product.json"));
  if (!Array.isArray(owned.paths) || !owned.paths.every((p) => typeof p === "string")) throw Error("Invalid desktop ownership manifest");
  const desktopCommit = (await git(["rev-parse", "HEAD"])).trim();
  const desktopPackage = await json(join(root, "package.json"));
  const desktopVersion = desktopPackage.version;
  const tauri = await json(join(root, "apps/desktop/src-tauri/tauri.conf.json"));
  const cargo = await readFile(join(root, "apps/desktop/src-tauri/Cargo.toml"), "utf8");
  const cargoVersion = /^version\s*=\s*"([^"\r\n]+)"/m.exec(cargo)?.[1];
  if (typeof desktopVersion !== "string" || desktopVersion.length > 128 || desktopVersion !== tauri.version || desktopVersion !== cargoVersion) {
    throw Error("Desktop package, Tauri and Cargo versions must agree");
  }
  const files: { path: string; sha256: string }[] = [];
  for (const file of owned.paths as string[]) {
    safe(file);
    const source = join(root, file);
    const stat = await lstat(source);
    if (!stat.isFile() || stat.isSymbolicLink()) throw Error(`Not a regular owned source: ${file}`);
    files.push({ path: file, sha256: createHash("sha256").update(await readFile(source)).digest("hex") });
  }
  const sourceDigest = createHash("sha256").update(JSON.stringify(files)).update(desktopVersion).update(await readFile(join(root, "overlays/docs-main.tsx"))).update(await readFile(join(root, "build-scripts.json"))).digest("hex");
  try {
    const existing = await json(join(workspace, ".forge-desktop-source.json"));
    if (existing.engineCommit === actualEngine && existing.desktopCommit === desktopCommit && existing.sourceDigest === sourceDigest) {
      if ((await git(["status", "--porcelain", "--untracked-files=no"], workspace)).trim()) throw Error("Generated workspace has edits; preserve them before preparing again");
      return workspace;
    }
    if ((await git(["status", "--porcelain", "--untracked-files=no"], workspace)).trim()) throw Error("Generated workspace has edits; preserve them before preparing again");
    const archive = join(root, ".work", `previous-${Date.now()}`);
    await rename(workspace, archive);
  } catch (error) {
    if (await lstat(workspace).catch(() => null)) throw error;
  }
  await mkdir(dirname(workspace), { recursive: true });
  await git(["clone", "--no-hardlinks", "--no-checkout", "--", engine, workspace]);
  await git(["checkout", "--detach", actualEngine], workspace);
  for (const file of owned.paths as string[]) {
    const target = safe(file);
    await mkdir(dirname(target), { recursive: true });
    await cp(join(root, file), target, { dereference: false });
  }
  const entry = safe("docs/js/main.tsx");
  await cp(join(root, "overlays/docs-main.tsx"), entry);
  const build = await json(join(root, "build-scripts.json"));
  const pkg = await json(join(workspace, "package.json"));
  const engineVersion = pkg.version;
  pkg.version = desktopVersion;
  pkg.scripts = { ...(pkg.scripts as Record<string, string>), ...build };
  await writeFile(join(workspace, "package.json"), JSON.stringify(pkg, null, 2) + "\n");
  const source = { schemaVersion: 1, desktopCommit, desktopVersion, engineCommit: actualEngine, engineVersion, sourceDigest, files };
  await writeFile(join(workspace, ".forge-desktop-source.json"), JSON.stringify(source, null, 2) + "\n");
  await git(["add", "--all"], workspace);
  await git(["-c", "user.name=Forge build assembly", "-c", "user.email=build@agentforge.invalid", "-c", "core.hooksPath=", "commit", "--no-gpg-sign", "-m", `build: assemble desktop ${desktopCommit} with engine ${actualEngine}`], workspace);
  return workspace;
}

if (import.meta.main) {
  try {
    console.log(JSON.stringify({ ok: true, data: { workspace: await prepare() }, error: null }));
  } catch (error) {
    console.error(JSON.stringify({ ok: false, data: null, error: error instanceof Error ? error.message : String(error) }));
    process.exitCode = 1;
  }
}
