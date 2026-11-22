import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readBoundedNoticeFile } from "./native-notices";

// Original regular members of tauri-apps/binary-releases release nsis-3.13,
// nsis-3.13.zip (SHA-256 ba63dffc4410ee89193e1cb5a41989991bd77c61068da17e3156d136b7b0b3d8).
// Member names are relative to the archive's nsis-3.13/ directory.
export const nsisNotices = [
  {
    name: "COPYING",
    bytes: 15632,
    sha256: "388357c1215ff403c5ebde3a5ecd273e68f8b79a579996775245d1ee65442aba",
  },
  {
    name: "Docs/NSISdl/License.txt",
    bytes: 943,
    sha256: "326e587f36ca58e14bd09cca153f9e69f1c5ed701189aa47d2d0627af7e16280",
  },
  {
    name: "Docs/Modern UI 2/License.txt",
    bytes: 840,
    sha256: "36608f72902ac188e45eab9bf6f673df72dd76f871f61d0c6d60592dfc15461c",
  },
] as const;

type NsisNotice = (typeof nsisNotices)[number];
export const nsisNoticePath = (notice: NsisNotice) =>
  `legal/nsis/3.13/${notice.name}`;

function verifyNsisNotice(notice: NsisNotice, contents: Uint8Array) {
  if (
    contents.byteLength !== notice.bytes ||
    createHash("sha256").update(contents).digest("hex") !== notice.sha256
  )
    throw Error(`NSIS notice differs from original: ${notice.name}`);
}

function noticeFile(root: string, path: string, createParents: boolean) {
  let directory = root;
  for (const part of [".", ...path.split("/").slice(0, -1)]) {
    directory = join(directory, part);
    if (createParents && !lstatSync(directory, { throwIfNoEntry: false }))
      mkdirSync(directory);
    const stat = lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw Error("Linked NSIS notice directory");
  }
  return join(root, path);
}

export function readNsisNotices(root: string) {
  return nsisNotices.map((notice) => {
    const path = noticeFile(
      root,
      `third-party/nsis-3.13/${notice.name}`,
      false,
    );
    const contents = readBoundedNoticeFile(path, notice.bytes);
    verifyNsisNotice(notice, contents);
    return { notice, contents };
  });
}

export function writeNsisNotices(
  stage: string,
  originals: ReturnType<typeof readNsisNotices>,
) {
  for (const { notice, contents } of originals) {
    const target = noticeFile(stage, nsisNoticePath(notice), true);
    writeFileSync(target, contents, { flag: "wx" });
    verifyNsisNotice(notice, readBoundedNoticeFile(target, notice.bytes));
  }
}

export function verifyNsisNoticePayloads(
  readMember: (path: string, maxBytes: number) => Uint8Array,
) {
  for (const notice of nsisNotices)
    verifyNsisNotice(notice, readMember(nsisNoticePath(notice), notice.bytes));
}
