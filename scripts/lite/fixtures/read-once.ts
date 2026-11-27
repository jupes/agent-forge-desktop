import { readLite } from "../reader";

// The packaged entry suppresses error details. This fixture retains the
// reader's reason so source tests can distinguish refused identity from a crash.
try {
  process.stdout.write(JSON.stringify(await readLite(process.argv.slice(2))));
} catch (error) {
  process.stderr.write(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
