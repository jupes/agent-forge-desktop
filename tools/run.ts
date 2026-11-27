import { spawn } from "bun";
import { prepare } from "./workspace";

const allowed = new Set([
  "typecheck", "lint", "test", "desktop:build", "desktop:smoke", "dashboard",
  "dashboard:build", "verify:ui", "verify:desktop", "verify:desktop-worktrees",
  "verify:desktop-shifts", "verify:desktop-restart", "lite:build", "lite:dev", "lite:web:build", "verify:lite",
]);
const [name, ...args] = process.argv.slice(2);
if (!name || !allowed.has(name)) throw Error("Choose a documented desktop build or verification command");
const child = spawn([process.execPath, "run", name, ...args], {
  cwd: await prepare(), stdin: "inherit", stdout: "inherit", stderr: "inherit",
  windowsHide: true,
});
const timer = setTimeout(() => child.kill(), 30 * 60_000);
try { process.exitCode = await child.exited; } finally { clearTimeout(timer); }
