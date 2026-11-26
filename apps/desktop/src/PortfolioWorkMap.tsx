import type { JSX } from "preact";
import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "preact/hooks";
import { Button } from "../../../docs/js/ds/Button";
import type { ProjectWorkMap } from "../../../types/project-work-map";
import {
  buildPortfolioGraph,
  buildPortfolioMap,
  filterPortfolioBeads,
  isPortfolioBead,
  OWNER_NODE,
  PORTFOLIO_PAGE_SIZE,
  type PortfolioFilter,
  type PortfolioGraph,
  type PortfolioNode,
  portfolioPath,
  portfolioRelations,
  projectNodeKey,
  type WorkMapState,
} from "./portfolio-work-map-model";
import {
  type GraphFrame,
  useCameraMotion,
  useGraphMotion,
  useReducedMotion,
} from "./portfolio-work-map-motion";
import "./portfolio-work-map.css";

type MapModel = ReturnType<typeof buildPortfolioMap>;
type Placement = PortfolioGraph["nodes"][number];

const states = {
  working: { label: "Working now", mark: "●" },
  in_progress: { label: "In progress", mark: "◐" },
  ready: { label: "Ready", mark: "◆" },
  not_started: { label: "Not started", mark: "○" },
  blocked: { label: "Blocked", mark: "▲" },
  completed: { label: "Completed", mark: "✓" },
  other: { label: "Other status", mark: "◇" },
} satisfies Record<WorkMapState, { label: string; mark: string }>;

const filters = ["all", ...Object.keys(states)] as readonly PortfolioFilter[];

export interface PortfolioWorkMapProps {
  defaultProjectId?: string | undefined;
  data: ProjectWorkMap | null;
  loading: boolean;
  error: string | null;
  onRefresh(): void;
  onOpenProject(projectId: string): void;
  onOpenBead(projectId: string, beadId: string): void;
}

export function PortfolioWorkMap({ data, ...props }: PortfolioWorkMapProps) {
  return (
    <section class="af-portfolio-map" aria-label="Work Map">
      {data ? (
        <PortfolioView data={data} {...props} />
      ) : (
        <>
          <header class="af-portfolio-heading">
            <h1>Work Map</h1>
          </header>
          <div class="af-portfolio-empty" role="status">
            <p>
              {props.error ??
                (props.loading
                  ? "Reading projects and beads…"
                  : "Work Map data is unavailable.")}
            </p>
            <Button onClick={props.onRefresh} disabled={props.loading}>
              Refresh Work Map
            </Button>
          </div>
        </>
      )}
    </section>
  );
}

function PortfolioView({
  data,
  defaultProjectId,
  loading,
  error,
  onRefresh,
  onOpenProject,
  onOpenBead,
}: Omit<PortfolioWorkMapProps, "data"> & { data: ProjectWorkMap }) {
  const [view, setView] = useState<"graph" | "list">("graph");
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<PortfolioFilter>("all");
  const [selectedKey, setSelectedKey] = useState(OWNER_NODE);
  const [expanded, setExpanded] = useState(new Map<string, number>());
  const [limit, setLimit] = useState(PORTFOLIO_PAGE_SIZE);
  const [fitRequest, requestFit] = useState(0);
  const detailPanel = useRef<HTMLElement>(null);
  const detailTitle = useRef<HTMLHeadingElement>(null);
  const searchId = useId();
  const model = useMemo(() => buildPortfolioMap(data), [data]);
  const owner = model.nodes.get(OWNER_NODE);
  const selected = model.nodes.get(selectedKey) ?? owner;
  const graph = useMemo(
    () => buildPortfolioGraph(model, expanded, selected?.key ?? OWNER_NODE),
    [model, expanded, selected],
  );
  const matches = useMemo(
    () => filterPortfolioBeads(model, query, filter),
    [model, query, filter],
  );
  const hasFilter = query.trim() !== "" || filter !== "all";
  const highlighted = useMemo(() => {
    if (!hasFilter) return null;
    const keys = new Set(
      matches.flatMap((node) =>
        portfolioPath(model, node.key).map((item) => item.key),
      ),
    );
    for (const project of data.projects) {
      if (
        query.trim() &&
        project.name
          .toLocaleLowerCase()
          .includes(query.trim().toLocaleLowerCase())
      ) {
        keys.add(projectNodeKey(project.id));
      }
    }
    return keys;
  }, [model, matches, data.projects, query, hasFilter]);

  if (!owner || !selected) return null;
  const hasMissingSources = data.projects.some(
    (project) => project.availability !== "available",
  );
  const closedCountsKnown = data.trackerAvailable && !hasMissingSources;
  const projects = model.children.get(OWNER_NODE) ?? [];
  const matchingIds = new Set(matches.map(({ bead }) => bead.id)).size;
  const updateExpanded = (key: string, count?: number) => {
    setExpanded((previous) => {
      const next = new Map(previous);
      if (count === undefined) {
        for (const open of previous.keys()) {
          if (portfolioPath(model, open).some((node) => node.key === key))
            next.delete(open);
        }
      } else next.set(key, count);
      return next;
    });
  };
  const select = (node: PortfolioNode, focusDetails = false) => {
    if (node.key !== selected.key && detailPanel.current)
      detailPanel.current.scrollTop = 0;
    setSelectedKey(node.key);
    if (node.kind === "owner") {
      setExpanded(new Map());
      requestFit((value) => value + 1);
    } else if (node.kind === "epic" || node.kind === "bead") {
      setExpanded((previous) => {
        const next = new Map(previous);
        for (const ancestor of portfolioPath(model, node.key)) {
          if (ancestor.kind === "epic" && !next.has(ancestor.key))
            next.set(ancestor.key, PORTFOLIO_PAGE_SIZE);
        }
        return next;
      });
    }
    if (focusDetails)
      requestAnimationFrame(() =>
        detailTitle.current?.focus({ preventScroll: true }),
      );
  };
  const relationSelection = (node: PortfolioNode) => select(node, true);
  const chooseFilter = (next: PortfolioFilter) => {
    setFilter(next);
    setLimit(PORTFOLIO_PAGE_SIZE);
  };
  const branch = model.children.get(selected.key) ?? [];
  const selectedAsOf = new Date(data.asOf);
  const readTime = Number.isFinite(selectedAsOf.getTime())
    ? selectedAsOf.toLocaleString([], {
        dateStyle: "medium",
        timeStyle: "short",
      })
    : null;

  return (
    <>
      <header class="af-portfolio-heading">
        <div>
          <h1>Work Map</h1>
          <p>
            {projects.length} {projects.length === 1 ? "project" : "projects"} ·{" "}
            {data.epics.length} {data.epics.length === 1 ? "epic" : "epics"} ·{" "}
            {owner.counts.total}{" "}
            {closedCountsKnown ? "beads" : "observed beads"}
          </p>
        </div>
        <div class="af-portfolio-heading-actions">
          {defaultProjectId && (
            <Button onClick={() => onOpenProject(defaultProjectId)}>
              Open Default workspace
            </Button>
          )}
          {readTime && (
            <span>
              Read <time dateTime={data.asOf}>{readTime}</time>
            </span>
          )}
          <Button onClick={onRefresh} disabled={loading}>
            Refresh
          </Button>
        </div>
      </header>
      {(error ||
        loading ||
        !data.trackerAvailable ||
        hasMissingSources ||
        !data.sessionsComplete) && (
        <div class="af-portfolio-notice" role="status">
          {error
            ? "Refresh failed; the previous tracker read remains visible."
            : loading
              ? "Refreshing; the previous tracker read remains visible."
              : null}
          {!data.trackerAvailable &&
            " Tracker data is unavailable. The project catalog is still shown."}
          {data.trackerAvailable &&
            hasMissingSources &&
            " Some project sources are unavailable. Counts cover observed work only."}
          {data.trackerAvailable &&
            !data.sessionsComplete &&
            " Session observations are incomplete. Working now displays confirmed live work only."}
        </div>
      )}
      {!projects.length ? (
        <div class="af-portfolio-empty">
          <h2>No projects in this catalog</h2>
          <p>
            Open Projects to set up the first project on this local tracker.
          </p>
          <Button href="#/desktop/projects">Open Projects</Button>
        </div>
      ) : (
        <>
          <div class="af-portfolio-toolbar">
            <label for={searchId} class="af-portfolio-search">
              <span>Search Work Map</span>
              <input
                id={searchId}
                type="search"
                value={query}
                placeholder="Find a bead or project"
                onInput={(event) => {
                  setQuery(event.currentTarget.value);
                  setLimit(PORTFOLIO_PAGE_SIZE);
                }}
              />
            </label>
            <div
              class="af-portfolio-segments"
              role="group"
              aria-label="Work Map presentation"
            >
              <button
                type="button"
                aria-pressed={view === "graph"}
                onClick={() => setView("graph")}
              >
                Graph
              </button>
              <button
                type="button"
                aria-pressed={view === "list"}
                onClick={() => setView("list")}
              >
                List
              </button>
            </div>
          </div>
          <div
            class="af-portfolio-filters"
            role="group"
            aria-label="Filter by work status"
          >
            {filters.map((state) => (
              <button
                key={state}
                type="button"
                aria-pressed={filter === state}
                onClick={() => chooseFilter(state)}
              >
                {state !== "all" && <StatusMark state={state} />}
                {state === "all" ? "All" : states[state].label}
                <span class="af-portfolio-filter-count" aria-hidden="true">
                  {data.trackerAvailable
                    ? owner.counts[state === "all" ? "total" : state]
                    : "–"}
                </span>
              </button>
            ))}
          </div>
          <div class="af-portfolio-body">
            <div class="af-portfolio-content">
              {view === "graph" ? (
                <PortfolioCanvas
                  graph={graph}
                  snapshot={data}
                  selected={selected}
                  expanded={expanded}
                  highlighted={highlighted}
                  fitRequest={fitRequest}
                  onSelect={select}
                />
              ) : (
                <section class="af-portfolio-list" aria-label="Beads list">
                  {!hasFilter && (
                    <ul class="af-portfolio-items" aria-label="Projects">
                      {projects.map((node) => (
                        <NodeRow
                          key={node.key}
                          node={node}
                          onSelect={relationSelection}
                        />
                      ))}
                    </ul>
                  )}
                  <MatchingBeads
                    model={model}
                    matches={matches}
                    limit={limit}
                    onMore={() =>
                      setLimit((value) => value + PORTFOLIO_PAGE_SIZE)
                    }
                    onSelect={relationSelection}
                  />
                </section>
              )}
              <footer class="af-portfolio-footer">
                {view === "graph" && (
                  <ul
                    class="af-portfolio-legend"
                    aria-label="Graph connections"
                  >
                    <li>
                      <i data-edge="belongs" /> Belongs to
                    </li>
                    <li>
                      <i data-edge="blocks" /> Blocks →
                    </li>
                    <li>
                      <i data-edge="requires" /> Requires →
                    </li>
                    <li>
                      <i data-edge="relates" /> Related
                    </li>
                  </ul>
                )}
                <span role="status">
                  {matchingIds} {hasFilter ? "matching " : ""}
                  {matchingIds === 1 ? "bead" : "beads"}
                  {!closedCountsKnown ? " in this read" : ""}
                </span>
              </footer>
            </div>
            <aside
              ref={detailPanel}
              class="af-portfolio-details"
              aria-label="Work Map details"
            >
              <div class="af-portfolio-path">
                {portfolioPath(model, selected.key)
                  .slice(0, -1)
                  .map((node) => (
                    <button
                      key={node.key}
                      type="button"
                      onClick={() => relationSelection(node)}
                    >
                      {node.title}
                    </button>
                  ))}
              </div>
              <h2 ref={detailTitle} tabIndex={-1}>
                <span key={selected.key}>{selected.title}</span>
              </h2>
              {isPortfolioBead(selected) && (
                <div class="af-portfolio-detail-state">
                  <code>{selected.bead.id}</code>{" "}
                  <StatusLabel state={selected.bead.workState} />
                  {selected.bead.queue && (
                    <span>
                      Queue {selected.bead.queue.replaceAll("_", " ")}
                    </span>
                  )}
                </div>
              )}
              {selected.kind === "owner" ? (
                <>
                  <CountLabel node={selected} partial={!closedCountsKnown} />
                  <h3>Projects</h3>
                  <ul class="af-portfolio-items" aria-label="Projects">
                    {projects.map((node) => (
                      <NodeRow
                        key={node.key}
                        node={node}
                        onSelect={relationSelection}
                      />
                    ))}
                  </ul>
                </>
              ) : (
                <>
                  {selected.kind === "project" && (
                    <div class="af-portfolio-detail-actions">
                      <Button onClick={() => onOpenProject(selected.projectId)}>
                        Open project
                      </Button>
                      {selected.project.availability !== "available" && (
                        <span>
                          {availabilityLabel(selected.project.availability)}
                        </span>
                      )}
                    </div>
                  )}
                  {selected.kind !== "bead" && (
                    <CountLabel
                      node={selected}
                      partial={data.projects.some(
                        (project) =>
                          project.id === selected.projectId &&
                          project.availability !== "available",
                      )}
                    />
                  )}
                  {isPortfolioBead(selected) && (
                    <Button
                      class="af-portfolio-open-bead"
                      onClick={() =>
                        onOpenBead(selected.projectId, selected.bead.id)
                      }
                    >
                      Open bead
                    </Button>
                  )}
                  <DeliverySummary node={selected} />
                  {isPortfolioBead(selected) && (
                    <BeadRelations
                      model={model}
                      node={selected}
                      onSelect={relationSelection}
                    />
                  )}
                  {selected.kind !== "bead" && branch.length > 0 && (
                    <BranchList
                      node={selected}
                      branch={branch}
                      count={expanded.get(selected.key)}
                      onSelect={relationSelection}
                      onChange={(count) => updateExpanded(selected.key, count)}
                    />
                  )}
                </>
              )}
              {view === "graph" && hasFilter && (
                <MatchingBeads
                  model={model}
                  matches={matches}
                  limit={limit}
                  onMore={() =>
                    setLimit((value) => value + PORTFOLIO_PAGE_SIZE)
                  }
                  onSelect={relationSelection}
                />
              )}
            </aside>
          </div>
        </>
      )}
    </>
  );
}

function availabilityLabel(
  state: ProjectWorkMap["projects"][number]["availability"],
) {
  return state === "partial" ? "Partial tracker read" : "Tracker unavailable";
}

function StatusMark({ state }: { state: WorkMapState }) {
  return (
    <span class="af-portfolio-mark" data-work-state={state} aria-hidden="true">
      {states[state].mark}
    </span>
  );
}

function StatusLabel({ state }: { state: WorkMapState }) {
  return (
    <span class="af-portfolio-status">
      <StatusMark state={state} /> {states[state].label}
    </span>
  );
}

function CountLabel({
  node,
  partial,
}: {
  node: PortfolioNode;
  partial: boolean;
}) {
  if (node.kind === "project" && node.project.availability === "unavailable")
    return null;
  return (
    <p class="af-portfolio-count">
      {node.counts.completed} of {node.counts.total}{" "}
      {partial ? "observed " : ""}beads completed
    </p>
  );
}

function DeliverySummary({ node }: { node: PortfolioNode }) {
  if (node.kind === "project" && node.project.availability === "unavailable")
    return null;
  const recorded = node.outcomes.filter((bead) => bead.delivery !== null);
  const completed = node.outcomes.filter((bead) => bead.delivery === null);
  if (node.kind === "bead" && recorded.length === 0) return null;
  return (
    <section class="af-portfolio-delivery" aria-label="Delivery summary">
      {recorded.length > 0 && (
        <>
          <h3>Recorded delivery</h3>
          <ul>
            {recorded.map((bead) => (
              <li key={bead.id}>{bead.delivery}</li>
            ))}
          </ul>
        </>
      )}
      {completed.length > 0 ? (
        <>
          <h3>Completed work</h3>
          <p>Tracker completion</p>
          <ul>
            {completed.map((bead) => (
              <li key={bead.id}>{bead.title}</li>
            ))}
          </ul>
        </>
      ) : (
        recorded.length === 0 && <p>No delivery recorded yet.</p>
      )}
    </section>
  );
}

function NodeRow({
  node,
  onSelect,
  prefix,
}: {
  node: PortfolioNode;
  onSelect(node: PortfolioNode): void;
  prefix?: string;
}) {
  const bead = isPortfolioBead(node) ? node.bead : null;
  return (
    <li>
      <button
        type="button"
        class="af-portfolio-row"
        onClick={() => onSelect(node)}
        aria-label={
          bead
            ? `${bead.id}, ${node.title}${prefix ? `, ${prefix}` : ""}`
            : undefined
        }
      >
        <span>
          {prefix && <small>{prefix}</small>}
          <strong>{node.title}</strong>
          {bead && (
            <small>
              <code>{bead.id}</code>
            </small>
          )}
        </span>
        {bead ? (
          <StatusLabel state={bead.workState} />
        ) : node.kind === "project" &&
          node.project.availability !== "available" ? (
          <small>{availabilityLabel(node.project.availability)}</small>
        ) : (
          <small>
            {node.counts.completed}/{node.counts.total} done
          </small>
        )}
      </button>
    </li>
  );
}

function BranchList({
  node,
  branch,
  count,
  onSelect,
  onChange,
}: {
  node: PortfolioNode;
  branch: PortfolioNode[];
  count: number | undefined;
  onSelect(node: PortfolioNode): void;
  onChange(count?: number): void;
}) {
  const clusters = branch.filter((item) => item.kind === "epic");
  const leaves = branch.filter((item) => item.kind === "bead");
  return (
    <section class="af-portfolio-branch" aria-label={`Work in ${node.title}`}>
      {clusters.length > 0 && (
        <>
          <h3>Epics</h3>
          <ul class="af-portfolio-items">
            {clusters.map((item) => (
              <NodeRow key={item.key} node={item} onSelect={onSelect} />
            ))}
          </ul>
        </>
      )}
      {(leaves.length > 0 || (node.kind === "epic" && clusters.length > 0)) && (
        <Button
          aria-expanded={count !== undefined}
          onClick={() =>
            onChange(count === undefined ? PORTFOLIO_PAGE_SIZE : undefined)
          }
        >
          {count !== undefined ? "Collapse beads" : "Show beads"}
        </Button>
      )}
      {count !== undefined && leaves.length > 0 && (
        <>
          <h3>Beads</h3>
          <ul class="af-portfolio-items" aria-label={`Beads in ${node.title}`}>
            {leaves.slice(0, count).map((item) => (
              <NodeRow key={item.key} node={item} onSelect={onSelect} />
            ))}
          </ul>
          {leaves.length > count && (
            <Button onClick={() => onChange(count + PORTFOLIO_PAGE_SIZE)}>
              Show more beads
            </Button>
          )}
        </>
      )}
    </section>
  );
}

function MatchingBeads({
  model,
  matches,
  limit,
  onMore,
  onSelect,
}: {
  model: MapModel;
  matches: ReturnType<typeof filterPortfolioBeads>;
  limit: number;
  onMore(): void;
  onSelect(node: PortfolioNode): void;
}) {
  return (
    <section class="af-portfolio-match-list" aria-label="Matching beads">
      <h3>Matching beads</h3>
      {matches.length ? (
        <ul class="af-portfolio-items">
          {matches.slice(0, limit).map((node) => (
            <NodeRow
              key={node.key}
              node={node}
              prefix={portfolioPath(model, node.key)
                .slice(1, -1)
                .map((item) => item.title)
                .join(" › ")}
              onSelect={onSelect}
            />
          ))}
        </ul>
      ) : (
        <p>No matching beads in this read.</p>
      )}
      {matches.length > limit && (
        <Button onClick={onMore}>Show more results</Button>
      )}
    </section>
  );
}

function BeadRelations({
  model,
  node,
  onSelect,
}: {
  model: MapModel;
  node: Parameters<typeof portfolioRelations>[1];
  onSelect(node: PortfolioNode): void;
}) {
  const relations = portfolioRelations(model, node);
  if (relations.length === 0) return null;
  return (
    <section class="af-portfolio-relations">
      <h3>Relationships</h3>
      <ul class="af-portfolio-items">
        {relations.map(({ node: relation, label }) => (
          <NodeRow
            key={`${label}:${relation.key}`}
            node={relation}
            prefix={label}
            onSelect={onSelect}
          />
        ))}
      </ul>
    </section>
  );
}

function graphNodeLabel(node: PortfolioNode) {
  if (node.kind === "epic") return `${node.title}, epic`;
  if (node.kind === "bead")
    return `${node.bead.id}, ${node.title}, ${states[node.bead.workState].label}`;
  return node.title;
}

function PortfolioCanvas({
  graph,
  snapshot,
  selected,
  expanded,
  highlighted,
  fitRequest,
  onSelect,
}: {
  graph: PortfolioGraph;
  snapshot: ProjectWorkMap;
  selected: PortfolioNode;
  expanded: ReadonlyMap<string, number>;
  highlighted: ReadonlySet<string> | null;
  fitRequest: number;
  onSelect(node: PortfolioNode): void;
}) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const previousMargins = useRef({ x: 0, y: 0 });
  const [size, setSize] = useState({ width: 0, height: 0 });
  const reducedMotion = useReducedMotion();
  const frame = useGraphMotion(graph, snapshot, reducedMotion);
  const { camera, requestedZoom, fly, interrupt } =
    useCameraMotion(reducedMotion);
  const lastCamera = useRef(camera);
  const lastFitRequest = useRef(fitRequest);
  const redraw = useRef<() => void>(() => {});
  const [panning, setPanning] = useState(false);
  const drag = useRef<{
    pointerId: number;
    x: number;
    y: number;
    left: number;
    top: number;
    moved: boolean;
  } | null>(null);
  const fitScale = Math.min(
    size.width / frame.width,
    size.height / frame.height,
    1,
  );
  const scale = fitScale * camera.zoom;
  const targetFit = Math.min(
    size.width / graph.width,
    size.height / graph.height,
    1,
  );
  const nativeZoom = targetFit ? 1 / targetFit : 1;
  const maxZoom = Math.max(4, nativeZoom * 1.5);
  const stageWidth = Math.max(size.width, Math.ceil(scale * frame.width));
  const stageHeight = Math.max(size.height, Math.ceil(scale * frame.height));
  // Leave scroll room on both sides even when the whole graph fits.
  const marginX = Math.floor(size.width / 2);
  const marginY = Math.floor(size.height / 2);
  const originX = marginX + (stageWidth - scale * frame.width) / 2;
  const originY = marginY + (stageHeight - scale * frame.height) / 2;
  const layout = useMemo(
    () => new Map(frame.nodes.map((entry) => [entry.node.key, entry])),
    [frame],
  );

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const update = () =>
      setSize({ width: viewport.clientWidth, height: viewport.clientHeight });
    update();
    const observer = new ResizeObserver(update);
    observer.observe(viewport);
    return () => observer.disconnect();
  }, []);

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const previous = previousMargins.current;
    viewport.scrollTo(
      viewport.scrollLeft + marginX - previous.x,
      viewport.scrollTop + marginY - previous.y,
    );
    previousMargins.current = { x: marginX, y: marginY };
  }, [marginX, marginY]);

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    const canvas = canvasRef.current;
    if (!viewport || !canvas || !scale) return;
    if (camera !== lastCamera.current) {
      lastCamera.current = camera;
      viewport.scrollTo(
        originX + camera.x * frame.width * scale - size.width / 2,
        originY + camera.y * frame.height * scale - size.height / 2,
      );
    }
    redraw.current = () =>
      drawConnections(
        canvas,
        frame,
        layout,
        selected.key,
        scale,
        originX - viewport.scrollLeft,
        originY - viewport.scrollTop,
      );
    // Lines and buttons consume the same frame before the browser paints.
    redraw.current();
  }, [frame, layout, camera, size, selected.key, scale, originX, originY]);

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const draw = () => redraw.current();
    viewport.addEventListener("scroll", draw, { passive: true });
    const theme = new MutationObserver(draw);
    theme.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-af-theme", "class"],
    });
    return () => {
      viewport.removeEventListener("scroll", draw);
      theme.disconnect();
    };
  }, []);

  const changeZoom = (next: number, point?: { x: number; y: number }) => {
    const viewport = viewportRef.current;
    if (!viewport || !scale) return;
    const x =
      (viewport.scrollLeft + size.width / 2 - originX) / (scale * frame.width);
    const y =
      (viewport.scrollTop + size.height / 2 - originY) / (scale * frame.height);
    fly(
      { zoom: camera.zoom, x, y },
      { zoom: next, x: point?.x ?? x, y: point?.y ?? y },
    );
  };
  useLayoutEffect(() => {
    if (fitRequest === lastFitRequest.current) return;
    lastFitRequest.current = fitRequest;
    changeZoom(1, { x: 0.5, y: 0.5 });
  });
  const onPointerDown = (event: JSX.TargetedPointerEvent<HTMLDivElement>) => {
    interrupt();
    if (event.pointerType !== "mouse" || event.button !== 0) return;
    const viewport = event.currentTarget;
    drag.current = {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      left: viewport.scrollLeft,
      top: viewport.scrollTop,
      moved: false,
    };
  };
  const endDrag = (event: JSX.TargetedPointerEvent<HTMLDivElement>) => {
    if (drag.current?.pointerId !== event.pointerId) return;
    drag.current = null;
    setPanning(false);
  };
  const onPointerMove = (event: JSX.TargetedPointerEvent<HTMLDivElement>) => {
    const press = drag.current;
    if (press?.pointerId !== event.pointerId) return;
    if (!(event.buttons & 1)) {
      endDrag(event);
      return;
    }
    const dx = event.clientX - press.x;
    const dy = event.clientY - press.y;
    const viewport = event.currentTarget;
    if (!press.moved) {
      if (Math.hypot(dx, dy) < 5) return;
      // Capture only after a drag starts so a stationary click stays on its node.
      viewport.setPointerCapture(event.pointerId);
      press.moved = true;
      setPanning(true);
    }
    viewport.scrollTo(press.left - dx, press.top - dy);
  };

  return (
    <div class="af-portfolio-canvas">
      <div class="af-portfolio-connections" aria-hidden="true">
        <canvas ref={canvasRef} />
      </div>
      <div
        class="af-portfolio-viewport"
        ref={viewportRef}
        role="group"
        aria-label="Portfolio graph"
        data-panning={panning}
        onPointerDown={onPointerDown}
        onWheel={interrupt}
        onKeyDown={interrupt}
        onPointerMove={onPointerMove}
        onPointerLeave={(event) => {
          if (!drag.current?.moved) endDrag(event);
        }}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onLostPointerCapture={endDrag}
      >
        <div
          class="af-portfolio-stage"
          style={{
            width: stageWidth + 2 * marginX,
            height: stageHeight + 2 * marginY,
          }}
        >
          <div
            class="af-portfolio-plot"
            style={{
              width: frame.width,
              height: frame.height,
              transform: `translate(${originX}px, ${originY}px) scale(${scale})`,
            }}
          >
            {frame.nodes.map(
              ({ node, x, y, width, height, opacity, exiting }) => (
                <button
                  key={node.key}
                  type="button"
                  class="af-portfolio-node"
                  disabled={exiting}
                  aria-hidden={exiting || undefined}
                  data-kind={node.kind}
                  data-dim={Boolean(
                    highlighted &&
                      !highlighted.has(node.key) &&
                      node.key !== selected.key &&
                      node.kind !== "owner",
                  )}
                  aria-label={graphNodeLabel(node)}
                  aria-pressed={selected.key === node.key}
                  aria-expanded={
                    node.kind === "epic" ? expanded.has(node.key) : undefined
                  }
                  title={graphNodeLabel(node)}
                  style={{
                    left: 0,
                    top: 0,
                    translate: `${x - width / 2}px ${y - height / 2}px`,
                    "--af-node-presence":
                      opacity < 1 ? String(opacity) : undefined,
                    pointerEvents: exiting ? "none" : undefined,
                    width,
                    height,
                  }}
                  onClick={() => onSelect(node)}
                >
                  {node.kind === "bead" ? (
                    <StatusMark state={node.bead.workState} />
                  ) : (
                    <>
                      <strong>{node.title}</strong>
                      {node.kind === "project" &&
                      node.project.availability !== "available" ? (
                        <small>
                          {availabilityLabel(node.project.availability)}
                        </small>
                      ) : (
                        (node.kind === "epic" || node.kind === "project") && (
                          <small>
                            {node.counts.completed}/{node.counts.total} done
                            {node.counts.working > 0 && (
                              <span data-work-state="working">
                                {" "}
                                <StatusMark state="working" />
                                {node.counts.working}
                              </span>
                            )}
                            {node.counts.blocked > 0 && (
                              <span data-work-state="blocked">
                                {" "}
                                <StatusMark state="blocked" />
                                {node.counts.blocked}
                              </span>
                            )}
                          </small>
                        )
                      )}
                    </>
                  )}
                </button>
              ),
            )}
          </div>
        </div>
      </div>
      <div class="af-portfolio-zoom" role="group" aria-label="Graph scale">
        <Button
          aria-label="Zoom out"
          disabled={requestedZoom <= 1}
          onClick={() => changeZoom(Math.max(1, requestedZoom / 1.35))}
        >
          −
        </Button>
        <Button
          aria-label="Zoom in"
          disabled={requestedZoom >= maxZoom}
          onClick={() => changeZoom(Math.min(maxZoom, requestedZoom * 1.35))}
        >
          +
        </Button>
        {selected.kind !== "owner" && (
          <Button
            onClick={() => {
              const target = graph.nodes.find(
                ({ node }) => node.key === selected.key,
              );
              if (target)
                changeZoom(nativeZoom, {
                  x: target.x / graph.width,
                  y: target.y / graph.height,
                });
            }}
          >
            Focus selection
          </Button>
        )}
        <Button onClick={() => changeZoom(1, { x: 0.5, y: 0.5 })}>Fit</Button>
      </div>
    </div>
  );
}

function boundaryPoint(
  from: { x: number; y: number },
  node: Placement,
  inset: number,
) {
  const angle = Math.atan2(node.y - from.y, node.x - from.x);
  const dx = Math.cos(angle),
    dy = Math.sin(angle);
  const distance =
    Math.min(
      node.width / 2 / Math.max(Math.abs(dx), 0.001),
      node.height / 2 / Math.max(Math.abs(dy), 0.001),
    ) + inset;
  return { x: node.x - dx * distance, y: node.y - dy * distance, angle };
}

function drawConnections(
  canvas: HTMLCanvasElement,
  graph: GraphFrame,
  layout: ReadonlyMap<string, Placement>,
  selected: string,
  scale: number,
  offsetX: number,
  offsetY: number,
) {
  const context = canvas.getContext("2d");
  if (!context) return;
  const ratio = Math.min(window.devicePixelRatio || 1, 2);
  const width = Math.round(canvas.clientWidth * ratio);
  const height = Math.round(canvas.clientHeight * ratio);
  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;
  context.setTransform(1, 0, 0, 1, 0, 0);
  context.clearRect(0, 0, width, height);
  context.setTransform(
    scale * ratio,
    0,
    0,
    scale * ratio,
    offsetX * ratio,
    offsetY * ratio,
  );
  const css = getComputedStyle(canvas);
  const colors = {
    belongs: css.getPropertyValue("--portfolio-muted").trim(),
    blocks: css.getPropertyValue("--portfolio-warning").trim(),
    requires: css.getPropertyValue("--portfolio-info").trim(),
    relates: css.getPropertyValue("--portfolio-accent").trim(),
  };
  for (const edge of graph.edges) {
    const from = layout.get(edge.from),
      to = layout.get(edge.to);
    if (!from || !to) continue;
    const isMembership = edge.type === "belongs";
    const showArrow = !isMembership && edge.type !== "relates";
    const bend = Math.min(Math.hypot(to.x - from.x, to.y - from.y) * 0.15, 74);
    const control = { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 - bend };
    const end = showArrow
      ? boundaryPoint(control, to, 5)
      : { x: to.x, y: to.y, angle: 0 };
    const active = edge.from === selected || edge.to === selected;
    context.globalAlpha =
      edge.opacity * (active ? 0.95 : isMembership ? 0.58 : 0.64);
    context.strokeStyle = colors[edge.type];
    context.lineWidth =
      (active ? 1.8 : 1.2) / Math.max(scale, 0.5) +
      Math.min(edge.count - 1, 4) * 0.18;
    context.setLineDash(
      isMembership
        ? []
        : edge.type === "relates"
          ? [1.4, 5]
          : edge.type === "blocks"
            ? [8, 5]
            : [4, 4],
    );
    context.beginPath();
    context.moveTo(from.x, from.y);
    if (isMembership) context.lineTo(end.x, end.y);
    else context.quadraticCurveTo(control.x, control.y, end.x, end.y);
    context.stroke();
    if (showArrow) {
      const arrow = 7 / Math.max(scale, 0.6);
      context.beginPath();
      context.moveTo(end.x, end.y);
      context.lineTo(
        end.x - arrow * Math.cos(end.angle - 0.45),
        end.y - arrow * Math.sin(end.angle - 0.45),
      );
      context.lineTo(
        end.x - arrow * Math.cos(end.angle + 0.45),
        end.y - arrow * Math.sin(end.angle + 0.45),
      );
      context.fillStyle = colors[edge.type];
      context.fill();
    }
  }
}
