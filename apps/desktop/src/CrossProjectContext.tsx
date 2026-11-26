import { useId, useMemo, useState } from "preact/hooks";
import { Button } from "../../../docs/js/ds/Button";
import { workspaceKey } from "../../../scripts/projects/scope";
import type {
  ProjectWorkMap,
  WorkMapState,
} from "../../../types/project-work-map";
import type { ProjectRecord } from "../../../types/projects";
import { BeadsExportContext } from "./BeadsExportContext";
import {
  buildLocalTrackerContext,
  LocalTrackerReference,
} from "./LocalTrackerReference";
import "./project-settings.css";

const PAGE_SIZE = 20;
const DRAFT_LIMIT = 12_000;

export interface CrossProjectContextProps {
  project: ProjectRecord;
  catalog: readonly ProjectRecord[];
  map: ProjectWorkMap | null;
  error: string | null;
  loading: boolean;
  canPrepare: boolean;
  workspace: string;
  onRefresh(): void;
  onPrepare(text: string): string | null;
}

interface BeadReference {
  key: string;
  bead: ProjectWorkMap["beads"][number];
  owners: ProjectRecord[];
}

interface ProjectFacts {
  memberCount: number;
  states: Map<WorkMapState, number>;
  rootCount: number;
  titles: string[];
  partial: boolean;
  sessionsComplete: boolean;
}

const stateNames: Record<WorkMapState, string> = {
  working: "working now",
  in_progress: "in progress",
  ready: "ready",
  not_started: "not started",
  blocked: "blocked",
  completed: "completed",
  other: "other status",
};

function workspaceScope(project: ProjectRecord, workspace: string) {
  if (!workspace) return undefined;
  return project.workspaces.find(
    (scope) => workspaceKey(scope.root) === workspaceKey(workspace),
  );
}

function sourceBeads(map: ProjectWorkMap, projects: readonly ProjectRecord[]) {
  const available = new Set(
    map.projects
      .filter((project) => project.availability !== "unavailable")
      .map((project) => project.id),
  );
  const projectById = new Map(
    projects
      .filter((project) => available.has(project.id))
      .map((project) => [project.id, project]),
  );
  const references: BeadReference[] = [];
  for (const bead of new Map(map.beads.map((row) => [row.id, row])).values()) {
    const ids = [
      ...new Set(bead.memberships.map((membership) => membership.projectId)),
    ].sort();
    const owners = ids.flatMap((id) => {
      const project = projectById.get(id);
      return project ? [project] : [];
    });
    if (owners.length)
      references.push({
        key: JSON.stringify([bead.id, ...owners.map(({ id }) => id)]),
        bead,
        owners,
      });
  }
  return references.sort((a, b) =>
    a.bead.id.localeCompare(b.bead.id, undefined, { numeric: true }),
  );
}

function projectFacts(
  map: ProjectWorkMap | null,
  chosenProjects: ReadonlySet<string>,
  beads: readonly BeadReference[],
) {
  const sources = new Map<string, ProjectFacts>();
  if (!map || !chosenProjects.size) return sources;
  for (const project of map.projects) {
    if (
      chosenProjects.has(project.id) &&
      project.availability !== "unavailable"
    )
      sources.set(project.id, {
        memberCount: 0,
        states: new Map(),
        rootCount: 0,
        titles: [],
        partial: project.availability === "partial",
        sessionsComplete: map.sessionsComplete,
      });
  }
  for (const { bead, owners } of beads) {
    for (const owner of owners) {
      const source = sources.get(owner.id);
      if (!source) continue;
      source.memberCount++;
      source.states.set(
        bead.workState,
        (source.states.get(bead.workState) ?? 0) + 1,
      );
    }
  }
  for (const epic of map.epics) {
    const source = sources.get(epic.projectId);
    if (!source || epic.parentId !== null) continue;
    source.rootCount++;
    if (source.titles.length < 3)
      source.titles.push(
        epic.title.length > 160 ? `${epic.title.slice(0, 159)}…` : epic.title,
      );
  }
  return sources;
}

function observedProjectContext(facts: ProjectFacts | undefined) {
  if (!facts) return "";
  const states = Object.entries(stateNames).flatMap(([state, label]) => {
    const count = facts.states.get(state as WorkMapState);
    return count ? [`${count} ${label}`] : [];
  });
  const remaining = facts.rootCount - facts.titles.length;
  return [
    `${facts.memberCount} observed ${facts.memberCount === 1 ? "bead" : "beads"}${states.length ? ` (${states.join(", ")})` : ""}`,
    facts.partial ? "partial tracker coverage" : "",
    facts.sessionsComplete ? "" : "incomplete session observations",
    facts.titles.length
      ? `root epics ${facts.titles.map((title) => JSON.stringify(title)).join(", ")}${remaining ? ` and ${remaining} more` : ""}`
      : "",
  ]
    .filter(Boolean)
    .join(" · ");
}

const chosen = <T,>(
  items: readonly T[],
  selected: ReadonlySet<string>,
  key: (item: T) => string,
) => items.filter((item) => selected.has(key(item)));

const toggle = (values: ReadonlySet<string>, item: string) => {
  const next = new Set(values);
  if (next.has(item)) next.delete(item);
  else next.add(item);
  return next;
};

const projectReference = (project: ProjectRecord) =>
  `${JSON.stringify(project.name)} (project ${JSON.stringify(project.id)}, slug ${JSON.stringify(project.slug)})`;

function buildDraft(
  target: ProjectRecord,
  workspace: string,
  readAt: string | undefined,
  projects: ProjectRecord[],
  facts: ReadonlyMap<string, ProjectFacts>,
  beads: BeadReference[],
  repositories: string[],
  exportContext: string,
) {
  if (
    !projects.length &&
    !beads.length &&
    !repositories.length &&
    !exportContext.trim()
  )
    return "";
  return [
    `Cross-project context for ${projectReference(target)}`,
    workspace && (projects.length || beads.length || repositories.length)
      ? `Served local tracker workspace: ${workspace}`
      : "",
    projects.length
      ? [
          facts.size && readAt
            ? `Selected saved projects (local read ${readAt})`
            : "Selected saved projects",
          ...projects.map((project) => {
            const observed = observedProjectContext(facts.get(project.id));
            return `- ${projectReference(project)}${observed ? ` · ${observed}` : ""}`;
          }),
        ].join("\n")
      : "",
    beads.length
      ? [
          readAt
            ? `Selected local beads (read ${readAt})`
            : "Selected local beads",
          ...beads.map(
            ({ bead, owners }) =>
              `- ${bead.id} [${bead.status}] ${JSON.stringify(bead.title)} · saved projects ${owners.map(projectReference).join(", ")}`,
          ),
        ].join("\n")
      : "",
    buildLocalTrackerContext(repositories),
    exportContext.trim(),
  ]
    .filter(Boolean)
    .join("\n\n");
}

export function CrossProjectContext(props: CrossProjectContextProps) {
  return (
    <ContextDraft
      key={JSON.stringify([props.project.id, workspaceKey(props.workspace)])}
      {...props}
    />
  );
}

function ContextDraft({
  project,
  catalog,
  map,
  error,
  loading,
  workspace,
  canPrepare,
  onRefresh,
  onPrepare,
}: CrossProjectContextProps) {
  const heading = useId();
  const [projects, setProjects] = useState(new Set<string>());
  const [beads, setBeads] = useState(new Set<string>());
  const [repositories, setRepositories] = useState(new Set<string>());
  const [otherRepositories, setOtherRepositories] = useState<string[]>([]);
  const [exportContext, setExportContext] = useState("");
  const [query, setQuery] = useState("");
  const [projectLimit, setProjectLimit] = useState(PAGE_SIZE);
  const [beadLimit, setBeadLimit] = useState(PAGE_SIZE);
  const [repoLimit, setRepoLimit] = useState(PAGE_SIZE);
  const [actionStatus, setActionStatus] = useState("");

  const localScope = workspaceScope(project, workspace);
  const projectOptions = useMemo(
    () =>
      catalog
        .filter(
          (item) => item.id !== project.id && workspaceScope(item, workspace),
        )
        .sort(
          (a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id),
        ),
    [catalog, project.id, workspace],
  );
  const repositoryOptions = [
    ...new Map(
      (localScope?.repositories ?? []).map((path) => [
        workspaceKey(path),
        path,
      ]),
    ).values(),
  ];
  const currentMap = localScope && map?.trackerAvailable && !error ? map : null;
  const beadOptions = useMemo(
    () => (currentMap ? sourceBeads(currentMap, projectOptions) : []),
    [currentMap, projectOptions],
  );
  const lowerQuery = query.trim().toLocaleLowerCase();
  const matching = useMemo(
    () =>
      lowerQuery
        ? beadOptions.filter(({ bead, owners }) =>
            [
              bead.id,
              bead.title,
              bead.status,
              ...owners.flatMap(({ name, slug }) => [name, slug]),
            ].some((value) => value.toLocaleLowerCase().includes(lowerQuery)),
          )
        : beadOptions,
    [beadOptions, lowerQuery],
  );

  const chosenProjects = chosen(
    projectOptions,
    projects,
    (option) => option.id,
  );
  const chosenBeads = chosen(beadOptions, beads, (option) => option.key);
  const facts = useMemo(
    () => projectFacts(loading ? null : currentMap, projects, beadOptions),
    [loading, currentMap, projects, beadOptions],
  );
  const chosenRepositories = chosen(
    repositoryOptions,
    repositories,
    workspaceKey,
  );
  const outdatedCount =
    projects.size +
    beads.size +
    repositories.size -
    chosenProjects.length -
    chosenBeads.length -
    chosenRepositories.length;
  const draft = buildDraft(
    project,
    workspace,
    currentMap?.asOf,
    chosenProjects,
    facts,
    chosenBeads,
    [...chosenRepositories, ...otherRepositories],
    exportContext,
  );
  const tooLong = draft.length > DRAFT_LIMIT;
  const canReview =
    Boolean(draft) &&
    !tooLong &&
    outdatedCount === 0 &&
    !(loading && beads.size);
  const draftStatus = tooLong
    ? `The draft exceeds ${DRAFT_LIMIT.toLocaleString()} characters. Remove references to shorten it.`
    : outdatedCount
      ? "Some selections no longer match the current source read."
      : null;

  const removeOutdated = () => {
    setProjects(new Set(chosenProjects.map((item) => item.id)));
    setBeads(new Set(chosenBeads.map((item) => item.key)));
    setRepositories(new Set(chosenRepositories.map(workspaceKey)));
  };
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(draft);
      setActionStatus("Context copied.");
    } catch {
      setActionStatus("Clipboard unavailable. Select and copy the draft text.");
    }
  };

  return (
    <section class="af-project-settings" aria-labelledby={heading}>
      <header class="af-project-settings-heading">
        <h2 id={heading}>Cross-project context</h2>
        <p>
          Choose project, bead, and repository references for this session
          draft.
        </p>
        <Button href="#/desktop/work-map">Open Work Map</Button>
      </header>
      <fieldset class="af-project-settings-review">
        <legend>Saved projects</legend>
        {projectOptions.length ? (
          <ul class="af-project-repositories-members">
            {projectOptions.slice(0, projectLimit).map((item) => (
              <li class="af-project-repositories-member" key={item.id}>
                <label>
                  <input
                    type="checkbox"
                    checked={projects.has(item.id)}
                    onChange={() =>
                      setProjects((values) => toggle(values, item.id))
                    }
                  />{" "}
                  {item.name}{" "}
                  <small>
                    ({item.slug}
                    {item.archived ? " · archived" : ""})
                  </small>
                </label>
              </li>
            ))}
          </ul>
        ) : (
          <p>No other saved projects are in the served workspace.</p>
        )}
        {projectOptions.length > projectLimit && (
          <Button onClick={() => setProjectLimit((limit) => limit + PAGE_SIZE)}>
            Show more projects
          </Button>
        )}
      </fieldset>
      <fieldset class="af-project-settings-review">
        <legend>Local beads</legend>
        <div class="af-project-settings-actions">
          <Button onClick={onRefresh} disabled={loading}>
            Refresh local beads
          </Button>
          {loading && <span role="status">Reading local beads…</span>}
        </div>
        {!currentMap && !loading && (
          <p role="status">
            The local bead read is unavailable. Other reference sources are
            ready to use.
          </p>
        )}
        {currentMap && (
          <>
            <div class="af-project-settings-form">
              <label>
                Find beads
                <input
                  type="search"
                  value={query}
                  onInput={(event) => {
                    setQuery(event.currentTarget.value);
                    setBeadLimit(PAGE_SIZE);
                  }}
                />
              </label>
            </div>
            <p role="status">
              {matching.length} matching{" "}
              {matching.length === 1 ? "bead" : "beads"} · {chosenBeads.length}{" "}
              selected
            </p>
            {matching.length > 0 && (
              <ul class="af-project-repositories-members">
                {matching.slice(0, beadLimit).map(({ key, bead, owners }) => (
                  <li class="af-project-repositories-member" key={key}>
                    <label>
                      <input
                        type="checkbox"
                        checked={beads.has(key)}
                        onChange={() =>
                          setBeads((values) => toggle(values, key))
                        }
                      />{" "}
                      <code>{bead.id}</code> · {bead.title} ·{" "}
                      {bead.status.replaceAll("_", " ")} ·{" "}
                      {owners.map(({ name }) => name).join(", ")}
                    </label>
                  </li>
                ))}
              </ul>
            )}
            {matching.length > beadLimit && (
              <Button
                onClick={() => setBeadLimit((limit) => limit + PAGE_SIZE)}
              >
                Show more beads
              </Button>
            )}
          </>
        )}
      </fieldset>
      <fieldset class="af-project-settings-review">
        <legend>Repository references</legend>
        {repositoryOptions.length ? (
          <ul class="af-project-repositories-members">
            {repositoryOptions.slice(0, repoLimit).map((path) => {
              const key = workspaceKey(path);
              return (
                <li class="af-project-repositories-member" key={key}>
                  <label>
                    <input
                      type="checkbox"
                      checked={repositories.has(key)}
                      onChange={() =>
                        setRepositories((values) => toggle(values, key))
                      }
                    />{" "}
                    <code>{path}</code>
                  </label>
                </li>
              );
            })}
          </ul>
        ) : (
          <p>
            No repositories are attached to this project in the served
            workspace.
          </p>
        )}
        {repositoryOptions.length > repoLimit && (
          <Button onClick={() => setRepoLimit((limit) => limit + PAGE_SIZE)}>
            Show more repositories
          </Button>
        )}
      </fieldset>
      <LocalTrackerReference onChange={setOtherRepositories} />
      <BeadsExportContext onChange={setExportContext} />
      <div class="af-project-settings-form">
        <label>
          Draft context
          <textarea readOnly rows={8} value={tooLong ? "" : draft} />
        </label>
        {draftStatus && <p role="status">{draftStatus}</p>}
        {outdatedCount > 0 && !loading && (
          <Button onClick={removeOutdated}>
            Remove unavailable references
          </Button>
        )}
        <div class="af-project-settings-actions">
          <Button
            variant="primary"
            onClick={() => setActionStatus(onPrepare(draft) ?? "")}
            disabled={!canReview || !canPrepare}
          >
            Prepare session
          </Button>
          <Button onClick={() => void copy()} disabled={!canReview}>
            Copy context
          </Button>
        </div>
        {actionStatus && <p role="status">{actionStatus}</p>}
      </div>
    </section>
  );
}
