import { expect, test } from "bun:test";
import { buildLocalTrackerContext } from "../../apps/desktop/src/LocalTrackerReference";

test("builds a read-only argv for each distinct absolute checkout reference", () => {
  const windowsPath = String.raw`C:\Repos\Team A & (next)`;
  const unixPath = "/repos/Team B";
  const context = buildLocalTrackerContext([
    windowsPath,
    "c:/repos/team a & (next)/",
    unixPath,
    "relative/path",
    "/repo\nextra line",
  ]);

  for (const path of [windowsPath, unixPath]) {
    const base = ["bd", "--readonly", "--sandbox", "-C", path];
    expect(context).toContain(JSON.stringify([...base, "info"]));
    expect(context).toContain(
      JSON.stringify([...base, "list", "--all", "--limit", "50", "--json"]),
    );
  }
  expect(context).toContain("argument arrays");
  expect(context).not.toContain("c:/repos/team a");
  expect(context).not.toContain("relative/path");
  expect(context).not.toContain("extra line");
  expect(buildLocalTrackerContext(["C:relative", "~/repos/personal"])).toBe("");
});
