import { readLite } from "./reader";

try {
  process.stdout.write(JSON.stringify(await readLite(process.argv.slice(2))));
} catch {
  // Only trusted data crosses the IPC boundary, never raw tracker rows, secrets
  // or a validation exception containing incidentally captured source text.
  process.exitCode = 1;
}
