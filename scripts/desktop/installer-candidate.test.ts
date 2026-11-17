import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import {
  assertHostedInstallerBuild,
  planInstallerResources,
  verifyResourceSnapshot,
} from "./installer-candidate";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    if (
      dirname(resolve(root)) !== resolve(tmpdir()) ||
      !basename(root).startsWith("forge-installer-plan-")
    )
      throw Error("Unsafe installer fixture cleanup");
    rmSync(root, { recursive: true, force: true });
  }
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "forge-installer-plan-"));
  roots.push(root);
  const stage = join(root, "app/build/windows-x64");
  const backend = join(root, "app/src-tauri");
  mkdirSync(stage, { recursive: true });
  mkdirSync(backend, { recursive: true });
  for (const path of [
    "LICENSE",
    "NOTICE",
    "THIRD-PARTY-NOTICES.txt",
    "DISTRIBUTION-NOTICES.txt",
    "DISTRIBUTION-INVENTORY.json",
    "RUNTIME-DEPENDENCY-INVENTORY.json",
    "COMPILED-DEPENDENCY-INVENTORY.json",
    ".claude/skills/ATTRIBUTION.md",
    "docs/fonts/LICENSE-Inter.txt",
    "legal/cargo/example/LICENSE",
    "dashboard/index.html",
    "agent-forge-desktop.exe",
    "desktop-host.exe",
    "hearth.exe",
    "CANDIDATE.json",
    "MANUAL-TESTING.md",
  ]) {
    mkdirSync(dirname(join(stage, path)), { recursive: true });
    writeFileSync(join(stage, path), "exact fixture bytes\n");
  }
  return { root, stage, backend };
}

test("installer resource overlay includes staged original notices and retains dashboard resources", () => {
  const { stage, backend } = fixture();
  const plan = planInstallerResources(stage, backend);
  expect(plan.resources["../../../docs/dist/"]).toBe("dashboard/");
  expect(plan.resources["../build/windows-x64/LICENSE"]).toBe("LICENSE");
  expect(
    plan.resources["../build/windows-x64/legal/cargo/example/LICENSE"],
  ).toBe("legal/cargo/example/LICENSE");
  expect(plan.files).toHaveLength(10);
  expect(plan.files.find((file) => file.path === "LICENSE")).toMatchObject({
    bytes: 20,
    sha256: createHash("sha256").update("exact fixture bytes\n").digest("hex"),
  });
  expect(Object.values(plan.resources)).not.toContain("CANDIDATE.json");
  expect(Object.values(plan.resources)).not.toContain(
    "agent-forge-desktop.exe",
  );
});

test("unknown files, missing mandatory notices and a different input root refuse", () => {
  const { root, stage, backend } = fixture();
  writeFileSync(join(stage, ".env"), "private fixture content");
  expect(() => planInstallerResources(stage, backend)).toThrow(
    "Unexpected installer resource",
  );
  rmSync(join(stage, ".env"));
  rmSync(join(stage, "LICENSE"));
  expect(() => planInstallerResources(stage, backend)).toThrow(
    "Missing required installer notices",
  );
  expect(() => planInstallerResources(join(root, "other"), backend)).toThrow(
    "Unexpected installer input stage",
  );
});

test.skipIf(process.platform === "win32")(
  "linked input cannot introduce files from outside the stage",
  () => {
    const { root, stage, backend } = fixture();
    writeFileSync(join(root, "outside"), "outside fixture");
    symlinkSync(join(root, "outside"), join(stage, "legal/linked-LICENSE"));
    expect(() => planInstallerResources(stage, backend)).toThrow(
      "linked installer input",
    );
  },
);

test("installer resources must match the independently recorded portable file snapshot", () => {
  const file = {
    path: "LICENSE",
    source: "../build/windows-x64/LICENSE",
    bytes: 20,
    sha256: "a".repeat(64),
  };
  const snapshot = [{ path: "LICENSE", bytes: 20, sha256: "a".repeat(64) }];
  expect(() => verifyResourceSnapshot([file], snapshot)).not.toThrow();
  expect(() =>
    verifyResourceSnapshot([file], [{ ...snapshot[0], bytes: 21 }]),
  ).toThrow("differs");
  expect(() =>
    verifyResourceSnapshot(
      [file],
      [{ ...snapshot[0], sha256: "b".repeat(64) }],
    ),
  ).toThrow("differs");
  expect(() => verifyResourceSnapshot([file], [])).toThrow("differs");
  expect(() =>
    verifyResourceSnapshot([file], [{ ...snapshot[0], path: "../private" }]),
  ).toThrow("Invalid");
  expect(() =>
    verifyResourceSnapshot(
      [file],
      [{ ...snapshot[0], path: "legal/line\nLICENSE" }],
    ),
  ).toThrow("Invalid");
});

test("the bundling entry point refuses an operator machine before doing work", () => {
  expect(() => assertHostedInstallerBuild(undefined, "win32", "x64")).toThrow(
    "hosted Windows",
  );
  expect(() => assertHostedInstallerBuild("true", "linux", "x64")).toThrow(
    "hosted Windows",
  );
  expect(() => assertHostedInstallerBuild("true", "win32", "arm64")).toThrow(
    "hosted Windows",
  );
  expect(() =>
    assertHostedInstallerBuild("true", "win32", "x64"),
  ).not.toThrow();
});
