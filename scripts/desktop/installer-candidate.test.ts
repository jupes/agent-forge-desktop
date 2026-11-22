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
  installerMainBinaryIdentity,
  planInstallerResources,
  verifyResourceSnapshot,
  verifyWitnessPayloads,
  witnessToolPaths,
} from "./installer-candidate";

const roots: string[] = [];

test("installer identity records the packaged NSIS bytes separately from the portable executable", () => {
  const portable = Buffer.from("MZ fixture\0__TAURI_BUNDLE_TYPE_VAR_UNK\0end");
  const packaged = Buffer.from("MZ fixture\0__TAURI_BUNDLE_TYPE_VAR_NSS\0end");
  const original = Buffer.from(portable);
  expect(installerMainBinaryIdentity(portable, packaged)).toEqual({
    mainBinarySha256: createHash("sha256").update(packaged).digest("hex"),
    portableMainBinarySha256: createHash("sha256")
      .update(portable)
      .digest("hex"),
  });
  expect(portable).toEqual(original);
});

test("installer identity refuses missing or ambiguous markers and other payload changes", () => {
  const portable = Buffer.from("MZ fixture\0__TAURI_BUNDLE_TYPE_VAR_UNK\0end");
  for (const packaged of [
    portable,
    Buffer.from("MZ fixture\0__TAURI_BUNDLE_TYPE_VAR_NSS\0bad"),
    Buffer.from("short"),
  ])
    expect(() => installerMainBinaryIdentity(portable, packaged)).toThrow();
  for (const original of [
    Buffer.from("no marker"),
    Buffer.from("__TAURI_BUNDLE_TYPE_VAR_UNK__TAURI_BUNDLE_TYPE_VAR_UNK"),
    Buffer.from("__TAURI_BUNDLE_TYPE_VAR_UNK__TAURI_BUNDLE_TYPE_VAR_NSS"),
  ])
    expect(() => installerMainBinaryIdentity(original, original)).toThrow();
});
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
  const stage = join(root, "apps/desktop/build/windows-x64");
  const backend = join(root, "apps/desktop/src-tauri");
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
    ...witnessToolPaths,
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
  expect(plan.files).toHaveLength(12);
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

test("both witnessed tools must match the source and actual NSIS payload", () => {
  const { stage, backend } = fixture();
  const files = planInstallerResources(stage, backend).files;
  const bytes = Buffer.from("exact fixture bytes\n");
  const owned = witnessToolPaths.map((path) => ({
    path: `apps/desktop/${path}`,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  }));
  const read: string[] = [];
  verifyWitnessPayloads(files, owned, (path) => {
    read.push(path);
    return bytes;
  });
  expect(read).toEqual([...witnessToolPaths]);
  for (const path of witnessToolPaths) {
    const remaining = owned.filter(
      (row) => row.path !== `apps/desktop/${path}`,
    );
    expect(() => verifyWitnessPayloads(files, remaining, () => bytes)).toThrow(
      "source",
    );
    expect(() =>
      verifyWitnessPayloads(files, owned, (member) =>
        member === path ? Buffer.alloc(bytes.length) : bytes,
      ),
    ).toThrow("NSIS payload");
    rmSync(join(stage, path));
    expect(() => planInstallerResources(stage, backend)).toThrow(
      "Missing required",
    );
    writeFileSync(join(stage, path), bytes);
  }
});

test("the corrected RC2 leaf is reserved in the portable and compiler dashboards", () => {
  const { root, stage, backend } = fixture();
  for (const directory of [join(stage, "dashboard"), join(root, "docs/dist")]) {
    const leaf = join(directory, "assets/index-iTXU0aPJ.js");
    mkdirSync(dirname(leaf), { recursive: true });
    writeFileSync(leaf, "incoming fixture");
    expect(() => planInstallerResources(stage, backend)).toThrow("overlaps");
    rmSync(leaf);
  }
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
