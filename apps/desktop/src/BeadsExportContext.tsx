import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { BEADS_ISSUE_ID } from "../../../scripts/run-correlation";
import { redactShown } from "../../../scripts/secret-patterns";

export const MAX_BEADS_EXPORT_BYTES = 4 * 1024 * 1024;
const MAX_FILES = 4;
const MAX_ROWS = 12_000;
const MAX_SELECTION = 6;
const MAX_CONTEXT_CHARS = 3_500;
const PAGE_SIZE = 20;

interface ExportBead {
  key: string;
  id: string;
  title: string;
  status: string;
  repo: string | null;
}

interface ExportSource {
  key: string;
  label: string;
  beads: ExportBead[];
}

function show(value: string, maximum: number): string {
  const cleaned = redactShown(value).text.replace(/\s+/gu, " ").trim();
  if (cleaned.length <= maximum) return cleaned;
  return `${cleaned.slice(0, maximum - 1).replace(/[\uD800-\uDBFF]$/u, "")}…`;
}

function sourceName(file: File): string {
  return show(file.name.split(/[\\/]/).at(-1) ?? "", 80) || "Beads export";
}

function repoLabel(labels: unknown): string | null {
  if (!Array.isArray(labels)) return null;
  const repos = new Set<string>();
  for (const label of labels) {
    if (typeof label !== "string") continue;
    const match = /^repo:([a-z0-9_.-]+(?:\/[a-z0-9_.-]+)?)$/iu.exec(label);
    if (match?.[1]) repos.add(show(match[1], 64));
  }
  return repos.size === 1 ? ([...repos][0] ?? null) : null;
}

function readIssue(
  value: unknown,
  source: string,
  line: number,
): ExportBead | null {
  const invalid = () =>
    Error(`The export has an invalid Beads record on line ${line}.`);
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw invalid();
  const row = value as Record<string, unknown>;
  if (row._type !== undefined && row._type !== "issue") return null;
  const { id, title, status } = row;
  if (
    typeof id !== "string" ||
    !BEADS_ISSUE_ID.test(id) ||
    redactShown(id).redactions.length > 0 ||
    typeof title !== "string" ||
    typeof status !== "string" ||
    !title.trim() ||
    !status.trim()
  )
    throw invalid();
  return {
    key: `${source}:${id}`,
    id,
    title: show(title, 180) || "Untitled bead",
    status: show(status, 48) || "Unknown status",
    repo: repoLabel(row.labels),
  };
}

/** A replacement is all-or-nothing. Keep private columns in the user's file. */
export async function readBeadsExportSources(
  files: readonly File[],
): Promise<ExportSource[]> {
  if (
    files.length > MAX_FILES ||
    files.reduce((size, file) => size + file.size, 0) > MAX_BEADS_EXPORT_BYTES
  )
    throw Error(`Choose up to ${MAX_FILES} exports totalling at most 4 MiB.`);

  const names = files.map(sourceName);
  const totals = new Map<string, number>();
  for (const name of names) totals.set(name, (totals.get(name) ?? 0) + 1);
  const seen = new Map<string, number>();
  const sources: ExportSource[] = [];
  let total = 0;
  for (const [index, file] of files.entries()) {
    const key = `export-${index + 1}`;
    const name = names[index] ?? "Beads export";
    const ordinal = (seen.get(name) ?? 0) + 1;
    seen.set(name, ordinal);
    const label = (totals.get(name) ?? 0) > 1 ? `${name} (${ordinal})` : name;
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(
        await file.arrayBuffer(),
      );
    } catch {
      throw Error("The selected export could not be read as UTF-8 JSONL.");
    }
    const ids = new Set<string>();
    const beads: ExportBead[] = [];
    for (const [index, line] of text.split(/\r?\n/u).entries()) {
      if (!line.trim()) continue;
      let raw: unknown;
      try {
        raw = JSON.parse(line);
      } catch {
        throw Error(`The export is not valid JSONL on line ${index + 1}.`);
      }
      const bead = readIssue(raw, key, index + 1);
      if (!bead) continue;
      if (ids.has(bead.id))
        throw Error(
          "A Beads export repeats an issue ID within the same source.",
        );
      if (++total > MAX_ROWS)
        throw Error(
          `Choose exports with at most ${MAX_ROWS.toLocaleString()} beads in total.`,
        );
      ids.add(bead.id);
      beads.push(bead);
    }
    if (!beads.length)
      throw Error("A selected export contains no Beads issue records.");
    sources.push({ key, label, beads });
  }
  return sources;
}

export function buildBeadsExportContext(
  sources: readonly ExportSource[],
  selected: ReadonlySet<string>,
): string {
  const references: string[] = [];
  for (const source of sources) {
    for (const bead of source.beads) {
      if (!selected.has(bead.key)) continue;
      references.push(
        `- source ${JSON.stringify(source.label)}${bead.repo ? `, repository label ${JSON.stringify(bead.repo)}` : ""}: ${bead.id}, status ${JSON.stringify(bead.status)}, title ${JSON.stringify(bead.title)}`,
      );
    }
  }
  if (!references.length) return "";
  const context = `Beads references from user-selected export snapshots:\n${references.join("\n")}`;
  if (references.length > MAX_SELECTION || context.length > MAX_CONTEXT_CHARS)
    throw Error(
      `Choose up to ${MAX_SELECTION} beads within ${MAX_CONTEXT_CHARS.toLocaleString()} context characters.`,
    );
  return context;
}

export function BeadsExportContext({
  onChange,
}: {
  onChange(text: string): void;
}) {
  const [sources, setSources] = useState<ExportSource[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState("");
  const [limit, setLimit] = useState(PAGE_SIZE);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const version = useRef(0);
  const publish = useRef(onChange);
  publish.current = onChange;
  useEffect(() => {
    publish.current("");
    return () => {
      version.current++;
      publish.current("");
    };
  }, []);

  const options = useMemo(() => {
    const term = query.trim().toLocaleLowerCase();
    return sources.flatMap((source) =>
      source.beads
        .filter(
          (bead) =>
            !term ||
            `${source.label} ${bead.repo ?? ""} ${bead.id} ${bead.title} ${bead.status}`
              .toLocaleLowerCase()
              .includes(term),
        )
        .map((bead) => ({ source, bead })),
    );
  }, [sources, query]);

  const replace = async (files: File[]) => {
    const current = ++version.current;
    publish.current("");
    setSources([]);
    setSelected(new Set());
    setQuery("");
    setLimit(PAGE_SIZE);
    setError("");
    setLoading(files.length > 0);
    if (files.length === 0) return;
    try {
      const next = await readBeadsExportSources(files);
      if (current === version.current) setSources(next);
    } catch (cause) {
      if (current === version.current)
        setError(
          cause instanceof Error
            ? cause.message
            : "The Beads export could not be read.",
        );
    } finally {
      if (current === version.current) setLoading(false);
    }
  };

  const choose = (key: string, checked: boolean) => {
    const next = new Set(selected);
    if (checked) next.add(key);
    else next.delete(key);
    try {
      const text = buildBeadsExportContext(sources, next);
      setSelected(next);
      setError("");
      publish.current(text);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "This reference could not be selected.",
      );
    }
  };

  const remove = (key: string) => {
    const source = sources.find((item) => item.key === key);
    if (!source) return;
    const remaining = sources.filter((item) => item.key !== key);
    const next = new Set(selected);
    for (const bead of source.beads) next.delete(bead.key);
    setSources(remaining);
    setSelected(next);
    setError("");
    publish.current(buildBeadsExportContext(remaining, next));
  };

  return (
    <fieldset>
      <legend>Beads exports</legend>
      <label>
        Choose Beads JSONL exports
        <input
          type="file"
          multiple
          accept=".jsonl,.ndjson,application/jsonl,application/x-ndjson"
          onChange={(event) => {
            const files = Array.from(event.currentTarget.files ?? []);
            event.currentTarget.value = "";
            void replace(files);
          }}
        />
      </label>
      <p>
        Choose up to {MAX_FILES} files. Selected titles and statuses become
        prompt references.
      </p>
      {loading && <p role="status">Reading Beads exports…</p>}
      {error && <p role="alert">{error}</p>}
      {sources.length > 0 && (
        <>
          <ul aria-label="Imported Beads sources">
            {sources.map((source) => (
              <li key={source.key}>
                <span>
                  {source.label} · {source.beads.length} beads
                </span>{" "}
                <button
                  type="button"
                  aria-label={`Remove ${source.label}`}
                  onClick={() => remove(source.key)}
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
          <label>
            Search imported beads
            <input
              type="search"
              value={query}
              onInput={(event) => {
                setQuery(event.currentTarget.value);
                setLimit(PAGE_SIZE);
              }}
            />
          </label>
          <p role="status">
            {selected.size} of {MAX_SELECTION} references selected
          </p>
          {options.length > 0 ? (
            <ul aria-label="Imported beads">
              {options.slice(0, limit).map(({ source, bead }) => (
                <li key={bead.key}>
                  <label>
                    <input
                      type="checkbox"
                      checked={selected.has(bead.key)}
                      disabled={
                        selected.size >= MAX_SELECTION &&
                        !selected.has(bead.key)
                      }
                      onChange={(event) =>
                        choose(bead.key, event.currentTarget.checked)
                      }
                    />{" "}
                    <span>
                      {bead.id} · {bead.title} · {bead.status} · {source.label}
                      {bead.repo && ` · ${bead.repo}`}
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          ) : (
            <p>No imported beads match your search.</p>
          )}
          {options.length > limit && (
            <button
              type="button"
              onClick={() => setLimit((current) => current + PAGE_SIZE)}
            >
              Show more imported beads
            </button>
          )}
          {selected.size > 0 && (
            <button
              type="button"
              onClick={() => {
                setSelected(new Set());
                setError("");
                publish.current("");
              }}
            >
              Clear imported references
            </button>
          )}
        </>
      )}
    </fieldset>
  );
}
