import { useEffect, useRef, useState } from "preact/hooks";
import { workspaceKey } from "../../../scripts/projects/scope";

function absoluteCheckout(value: string): string | null {
  const path = value.trim();
  if (path.includes("\0") || /[\r\n]/u.test(path)) return null;
  return path.startsWith("/") ||
    /^[a-z]:[\\/]/iu.test(path) ||
    /^\\\\[^\\/]+[\\/][^\\/]+/u.test(path)
    ? path
    : null;
}

export function buildLocalTrackerContext(paths: readonly string[]): string {
  const checkouts = new Map<string, string>();
  for (const value of paths) {
    const path = absoluteCheckout(value);
    if (path && !checkouts.has(workspaceKey(path)))
      checkouts.set(workspaceKey(path), path);
  }
  if (!checkouts.size) return "";
  return [
    "Local Beads trackers selected by the user",
    "Use these read-only argument arrays for live Beads lookup. Check the database reported by info against the checkout or its configured tracker redirect before listing issues. Use show for details about an individual bead.",
    ...[...checkouts.values()].map((path) => {
      const base = ["bd", "--readonly", "--sandbox", "-C", path];
      return [
        `Checkout ${JSON.stringify(path)}`,
        JSON.stringify([...base, "info"]),
        JSON.stringify([...base, "list", "--all", "--limit", "50", "--json"]),
      ].join("\n");
    }),
  ].join("\n\n");
}

export function LocalTrackerReference({
  onChange,
}: {
  onChange(paths: string[]): void;
}) {
  const [paths, setPaths] = useState<string[]>([]);
  const [input, setInput] = useState("");
  const [error, setError] = useState("");
  const publish = useRef(onChange);
  publish.current = onChange;
  useEffect(() => () => publish.current([]), []);

  const update = (next: string[]) => {
    setPaths(next);
    setError("");
    publish.current(next);
  };
  const add = () => {
    const path = absoluteCheckout(input);
    if (!path) {
      setError("Enter an absolute local checkout path.");
      return;
    }
    if (paths.some((item) => workspaceKey(item) === workspaceKey(path))) {
      setError("This checkout is already selected.");
      return;
    }
    update([...paths, path]);
    setInput("");
  };

  return (
    <fieldset class="af-project-settings-review">
      <legend>Local tracker checkouts</legend>
      <p>Add a local checkout for the session to read with Beads.</p>
      <label>
        Absolute checkout path
        <input
          type="text"
          value={input}
          onInput={(event) => {
            setInput(event.currentTarget.value);
            setError("");
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              if (input.trim()) add();
            }
          }}
        />
      </label>
      <button type="button" disabled={!input.trim()} onClick={add}>
        Add checkout
      </button>
      {error && <p role="alert">{error}</p>}
      {paths.length > 0 && (
        <ul
          class="af-project-repositories-members"
          aria-label="Local tracker checkouts"
        >
          {paths.map((path) => (
            <li class="af-project-repositories-member" key={workspaceKey(path)}>
              <code>{path}</code>{" "}
              <button
                type="button"
                aria-label={`Remove ${path}`}
                onClick={() => update(paths.filter((item) => item !== path))}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
    </fieldset>
  );
}
