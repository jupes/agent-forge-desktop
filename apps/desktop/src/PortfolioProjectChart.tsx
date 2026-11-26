import { useMemo } from "preact/hooks";
import type { ProjectWorkMap } from "../../../types/project-work-map";
import type { WorkMapState } from "./portfolio-work-map-model";

export const portfolioStates = {
  working: { label: "Working now", mark: "●" },
  in_progress: { label: "In progress", mark: "◐" },
  ready: { label: "Ready", mark: "◆" },
  not_started: { label: "Not started", mark: "○" },
  blocked: { label: "Blocked", mark: "▲" },
  completed: { label: "Completed", mark: "✓" },
  other: { label: "Other status", mark: "◇" },
} satisfies Record<WorkMapState, { label: string; mark: string }>;

const stateOrder = Object.keys(portfolioStates) as WorkMapState[];

interface Props {
  projects: ProjectWorkMap["projects"];
  matches: readonly { projectId: string; bead: { workState: WorkMapState } }[];
  selectedId: string | null;
  trackerAvailable: boolean;
  filtered: boolean;
  stale: boolean;
  onSelect(projectId: string): void;
}

export function PortfolioProjectChart({
  projects,
  matches,
  selectedId,
  trackerAvailable,
  filtered,
  stale,
  onSelect,
}: Props) {
  const { rows, max } = useMemo(() => {
    const rows = projects
      .map((project) => ({
        project,
        counts: new Map<WorkMapState, number>(),
        total: 0,
      }))
      .sort((a, b) => a.project.name.localeCompare(b.project.name));
    const byId = new Map(rows.map((row) => [row.project.id, row]));
    let max = 0;
    // The map model supplies one placement per bead per project, including shared beads.
    for (const { projectId, bead } of matches) {
      const row = byId.get(projectId);
      if (!row) continue;
      row.counts.set(bead.workState, (row.counts.get(bead.workState) ?? 0) + 1);
      max = Math.max(max, ++row.total);
    }
    return { rows, max };
  }, [projects, matches]);

  return (
    <section class="af-project-chart" aria-label="Project status comparison">
      <h2>Beads by project</h2>
      <p>
        Bars share a bead-count scale. Shared beads count once in each project.
      </p>
      {max > 0 && (
        <div class="af-project-chart-axis" aria-hidden="true">
          <span>0</span>
          <span>
            {max} {max === 1 ? "bead" : "beads"}
          </span>
        </div>
      )}
      <ul>
        {rows.map(({ project, counts, total }) => {
          const available =
            trackerAvailable && project.availability !== "unavailable";
          const partial = project.availability === "partial";
          const groups = stateOrder.filter((state) => counts.has(state));
          return (
            <li key={project.id}>
              <button
                type="button"
                class="af-project-chart-row"
                aria-pressed={project.id === selectedId}
                onClick={() => onSelect(project.id)}
              >
                <span class="af-project-chart-title">
                  <strong>{project.name}</strong>
                  <span>
                    {available
                      ? `${total} ${filtered ? "matching " : partial ? "observed " : ""}${total === 1 ? "bead" : "beads"}`
                      : "Source unavailable"}
                  </span>
                </span>
                {available && (
                  <>
                    <span class="af-project-chart-track" aria-hidden="true">
                      {stateOrder.map((state) => (
                        <span
                          key={state}
                          data-work-state={state}
                          style={{
                            width: `${max ? (100 * (counts.get(state) ?? 0)) / max : 0}%`,
                          }}
                        />
                      ))}
                    </span>
                    <span class="af-project-chart-values">
                      {groups.map((state) => (
                        <span key={state} data-work-state={state}>
                          <i aria-hidden="true">
                            {portfolioStates[state].mark}
                          </i>
                          {state === "working" && stale
                            ? "Last seen working"
                            : portfolioStates[state].label}{" "}
                          {counts.get(state)}
                        </span>
                      ))}
                      {partial && <small>Partial source</small>}
                    </span>
                  </>
                )}
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
