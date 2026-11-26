import { expect, test } from "bun:test";
import {
  buildBeadsExportContext,
  MAX_BEADS_EXPORT_BYTES,
  readBeadsExportSources,
} from "../../apps/desktop/src/BeadsExportContext";

const exportFile = (name: string, ...rows: unknown[]) =>
  new File([rows.map((row) => JSON.stringify(row)).join("\r\n")], name);

test("imported context keeps same bead id in two sources distinct and projects only selected metadata", async () => {
  const sources = await readBeadsExportSources([
    exportFile(
      "issues.jsonl",
      { _type: "memory", id: "old-note", title: "Private memory" },
      {
        _type: "issue",
        id: "af-101",
        title: "Keyboard navigation\nwith a second line",
        status: "open",
        labels: ["repo:desktop", "unrelated"],
        description: "PRIVATE DESCRIPTION",
        notes: "PRIVATE NOTES",
      },
      { id: "af-102", title: "Unselected issue", status: "closed" },
    ),
    exportFile("issues.jsonl", {
      id: "af-101",
      title: "Other local tracker",
      status: "closed",
      labels: ["repo:harness"],
    }),
  ]);
  const keys = sources.flatMap((source) =>
    source.beads.filter((bead) => bead.id === "af-101").map((bead) => bead.key),
  );
  expect(new Set(keys).size).toBe(2);
  expect(buildBeadsExportContext(sources, new Set())).toBe("");
  const context = buildBeadsExportContext(sources, new Set(keys));
  expect(context).toContain("issues.jsonl (1)");
  expect(context).toContain("issues.jsonl (2)");
  expect(context).toContain("desktop");
  expect(context).toContain("harness");
  expect(context).toContain("Keyboard navigation with a second line");
  expect(context).toContain("Other local tracker");
  expect(context).not.toContain("PRIVATE");
  expect(context).not.toContain("Private memory");
  expect(context).not.toContain("Unselected issue");
  expect(
    buildBeadsExportContext(sources.slice(1), new Set(keys)),
  ).not.toContain("Keyboard navigation");
});

test("replacement rejects incomplete, empty, duplicate and oversized exports", async () => {
  const issue = { id: "af-102", title: "Work", status: "open" };
  expect(await readBeadsExportSources([])).toEqual([]);
  for (const file of [
    new File([], "empty.jsonl"),
    new File([JSON.stringify(issue), "\n{bad"], "invalid.jsonl"),
    new File([new Uint8Array([0xff, 0xfe])], "encoding.jsonl"),
    exportFile("duplicate.jsonl", issue, issue),
    exportFile("malformed.jsonl", { ...issue, id: "-unsafe" }),
    new File(["a".repeat(MAX_BEADS_EXPORT_BYTES + 1)], "large.jsonl"),
  ]) {
    await expect(readBeadsExportSources([file])).rejects.toThrow();
  }
});
