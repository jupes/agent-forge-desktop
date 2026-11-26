import type { BeadsDependency } from "../../../types/beads";
import type { ProjectWorkMap } from "../../../types/project-work-map";

type Project = ProjectWorkMap["projects"][number];
type Bead = ProjectWorkMap["beads"][number];
export type WorkMapState = Bead["workState"];
export type PortfolioFilter = "all" | WorkMapState;

export const OWNER_NODE = "you";
export const PORTFOLIO_PAGE_SIZE = 20;
export const projectNodeKey = (id: string) => `project:${id}`;
export const epicNodeKey = (projectId: string, id: string) =>
  `epic:${JSON.stringify([projectId, id])}`;
export const beadNodeKey = (projectId: string, id: string) =>
  `bead:${JSON.stringify([projectId, id])}`;

interface Counts extends Record<WorkMapState, number> {
  total: number;
}

const emptyCounts = (): Counts => ({
  total: 0,
  working: 0,
  in_progress: 0,
  ready: 0,
  not_started: 0,
  blocked: 0,
  completed: 0,
  other: 0,
});

interface PortfolioNodeBase {
  key: string;
  parentKey: string | null;
  title: string;
  counts: Counts;
  /** Recent evidence is bounded independently of the progress counts. */
  outcomes: Bead[];
}

export type PortfolioNode = PortfolioNodeBase &
  (
    | { kind: "owner" }
    | { kind: "project"; projectId: string; project: Project }
    | { kind: "epic"; projectId: string; bead: Bead | null }
    | { kind: "bead"; projectId: string; bead: Bead }
  );
type BeadNode = PortfolioNode & { projectId: string; bead: Bead };

interface PortfolioModel {
  nodes: Map<string, PortfolioNode>;
  children: Map<string, PortfolioNode[]>;
  placements: Map<string, BeadNode[]>;
  workingNow: BeadNode[];
  dependencies: readonly BeadsDependency[];
}

interface Edge {
  from: string;
  to: string;
  type: BeadsDependency["type"] | "belongs";
  count: number;
}

interface PositionedNode {
  node: PortfolioNode;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PortfolioGraph {
  nodes: PositionedNode[];
  edges: Edge[];
  width: number;
  height: number;
}

const byTitle = (a: PortfolioNode, b: PortfolioNode) =>
  a.title.localeCompare(b.title) || a.key.localeCompare(b.key);

const nodeBase = (key: string, title: string, parentKey: string | null) => ({
  key,
  title,
  parentKey,
  counts: emptyCounts(),
  outcomes: [],
});

export function isPortfolioBead(node: PortfolioNode): node is BeadNode {
  return (node.kind === "bead" || node.kind === "epic") && node.bead !== null;
}

export function isWorkingBead(node: PortfolioNode): boolean {
  return isPortfolioBead(node) && node.bead.workState === "working";
}

function rememberCounts(node: PortfolioNode, bead: Bead) {
  node.counts.total++;
  node.counts[bead.workState]++;
  if (bead.workState === "completed") node.outcomes.push(bead);
}

/** Keep hierarchy navigable when a damaged tracker contains cyclic epic ancestry. */
function settleParents(nodes: Map<string, PortfolioNode>) {
  const settled = new Set<string>();
  for (const start of nodes.values()) {
    if (start.kind !== "epic" || settled.has(start.key)) continue;
    const visited = new Set<string>();
    let node: PortfolioNode | undefined = start;
    while (node?.kind === "epic" && !settled.has(node.key)) {
      if (visited.has(node.key) || !nodes.has(node.parentKey ?? "")) {
        node.parentKey = projectNodeKey(node.projectId);
        break;
      }
      visited.add(node.key);
      node = nodes.get(node.parentKey ?? "");
    }
    for (const key of visited) settled.add(key);
  }
}

export function buildPortfolioMap(data: ProjectWorkMap): PortfolioModel {
  const owner: PortfolioNode = {
    ...nodeBase(OWNER_NODE, "You", null),
    kind: "owner",
  };
  const nodes = new Map<string, PortfolioNode>([[owner.key, owner]]);
  const children = new Map<string, PortfolioNode[]>();
  const placements = new Map<string, BeadNode[]>();
  const workingByProject = new Map<string, BeadNode>();
  const beads = new Map(data.beads.map((bead) => [bead.id, bead]));

  for (const project of data.projects) {
    const key = projectNodeKey(project.id);
    nodes.set(key, {
      ...nodeBase(key, project.name, OWNER_NODE),
      kind: "project",
      project,
      projectId: project.id,
    });
  }
  for (const epic of data.epics) {
    if (!nodes.has(projectNodeKey(epic.projectId))) continue;
    const key = epicNodeKey(epic.projectId, epic.id);
    const bead = beads.get(epic.id);
    nodes.set(key, {
      ...nodeBase(
        key,
        epic.title,
        epic.parentId
          ? epicNodeKey(epic.projectId, epic.parentId)
          : projectNodeKey(epic.projectId),
      ),
      kind: "epic",
      projectId: epic.projectId,
      bead: bead?.memberships.some((item) => item.projectId === epic.projectId)
        ? bead
        : null,
    });
  }
  settleParents(nodes);

  for (const bead of data.beads) {
    for (const { projectId, epicId } of bead.memberships) {
      const projectKey = projectNodeKey(projectId);
      if (!nodes.has(projectKey)) continue;
      if (bead.type === "epic" && nodes.has(epicNodeKey(projectId, bead.id)))
        continue;
      const parent = epicId ? epicNodeKey(projectId, epicId) : projectKey;
      const key = beadNodeKey(projectId, bead.id);
      nodes.set(key, {
        ...nodeBase(key, bead.title, nodes.has(parent) ? parent : projectKey),
        kind: "bead",
        projectId,
        bead,
      });
    }
  }

  for (const node of nodes.values()) {
    const parent = node.parentKey;
    if (parent) {
      const branch = children.get(parent) ?? [];
      branch.push(node);
      children.set(parent, branch);
    }
    if (!isPortfolioBead(node)) continue;
    if (isWorkingBead(node)) {
      // Keep the overview small and stable. Prefer an individual task to its epic.
      const current = workingByProject.get(node.projectId);
      if (
        !current ||
        (current.kind === "epic" && node.kind === "bead") ||
        (node.kind === current.kind && byTitle(node, current) < 0)
      )
        workingByProject.set(node.projectId, node);
    }
    const assigned = placements.get(node.bead.id) ?? [];
    assigned.push(node);
    placements.set(node.bead.id, assigned);
    let ancestor: PortfolioNode | undefined = node;
    while (ancestor && ancestor.kind !== "owner") {
      rememberCounts(ancestor, node.bead);
      ancestor = nodes.get(ancestor.parentKey ?? "");
    }
  }
  for (const [id, assigned] of placements) {
    const bead = beads.get(id);
    if (bead) rememberCounts(owner, bead);
    assigned.sort(byTitle);
  }
  for (const branch of children.values()) branch.sort(byTitle);
  for (const node of nodes.values()) {
    node.outcomes.sort(
      (a, b) =>
        Number(Boolean(b.delivery)) - Number(Boolean(a.delivery)) ||
        b.updatedAt.localeCompare(a.updatedAt) ||
        a.id.localeCompare(b.id),
    );
    node.outcomes = node.outcomes.slice(0, 3);
  }
  return {
    nodes,
    children,
    placements,
    workingNow: [...workingByProject.values()].sort(byTitle),
    dependencies: data.dependencies,
  };
}

export function portfolioPath(model: PortfolioModel, key: string) {
  const path: PortfolioNode[] = [];
  let item = model.nodes.get(key);
  while (item) {
    path.push(item);
    item = model.nodes.get(item.parentKey ?? "");
  }
  return path.reverse();
}

export function filterPortfolioBeads(
  model: PortfolioModel,
  query: string,
  state: PortfolioFilter,
): BeadNode[] {
  const search = query.trim().toLocaleLowerCase();
  return [...model.placements.values()]
    .flat()
    .filter(
      (node) =>
        (state === "all" || node.bead.workState === state) &&
        (!search ||
          `${node.bead.id} ${portfolioPath(model, node.key)
            .slice(1)
            .map((item) => item.title)
            .join(" ")}`
            .toLocaleLowerCase()
            .includes(search)),
    )
    .sort(byTitle);
}

/** Project membership is never inferred from the currently selected canvas node. */
function dependencyPlacements(
  model: PortfolioModel,
  edge: BeadsDependency,
  projectId?: string,
) {
  const upstream = model.placements.get(edge.to) ?? [];
  const downstream = model.placements.get(edge.from) ?? [];
  const withProject = (items: BeadNode[], id: string | undefined) =>
    items.find((item) => item.projectId === id);
  const from = withProject(upstream, projectId);
  const to = withProject(downstream, projectId);
  if (from || to) return [from ?? upstream[0], to ?? downstream[0]] as const;
  const shared = upstream.find((item) =>
    withProject(downstream, item.projectId),
  );
  return [
    shared ?? upstream[0],
    withProject(downstream, shared?.projectId) ?? downstream[0],
  ] as const;
}

export function portfolioRelations(model: PortfolioModel, node: BeadNode) {
  const result: { node: BeadNode; label: string }[] = [];
  for (const edge of model.dependencies) {
    if (edge.from !== node.bead.id && edge.to !== node.bead.id) continue;
    const [from, to] = dependencyPlacements(model, edge, node.projectId);
    if (!from || !to) continue;
    const isDependent = edge.from === node.bead.id;
    const other = isDependent ? from : to;
    if (other.key === node.key) continue;
    const label =
      edge.type === "relates"
        ? "Related"
        : isDependent
          ? edge.type === "requires"
            ? "Requires"
            : "Blocked by"
          : edge.type === "requires"
            ? "Required by"
            : "Blocks";
    result.push({ node: other, label });
  }
  return result;
}

const footprint = {
  owner: [66, 66],
  project: [140, 52],
  epic: [146, 65],
  bead: [36, 36],
} as const;

function positionGraph(
  visible: Map<string, PortfolioNode>,
  model: PortfolioModel,
) {
  const rows: { node: PortfolioNode; angle: number }[][] = [];
  const stack = [
    { key: OWNER_NODE, depth: 0, start: -Math.PI / 2, end: Math.PI * 1.5 },
  ];
  while (stack.length) {
    const item = stack.pop();
    if (!item) break;
    const node = visible.get(item.key);
    if (!node) continue;
    const row = rows[item.depth] ?? [];
    row.push({ node, angle: (item.start + item.end) / 2 });
    rows[item.depth] = row;
    const branches = (model.children.get(node.key) ?? []).filter(
      (child) => child.kind !== "bead" && visible.has(child.key),
    );
    const weights = branches.map((branch) =>
      branch.kind === "project"
        ? Math.max(
            2,
            (model.children.get(branch.key) ?? []).filter(
              (child) => child.kind === "epic",
            ).length,
          )
        : 1,
    );
    const total = weights.reduce((sum, weight) => sum + weight, 0);
    let start = item.start;
    for (const [index, child] of branches.entries()) {
      const end =
        start + ((item.end - item.start) * (weights[index] ?? 1)) / total;
      stack.push({ key: child.key, depth: item.depth + 1, start, end });
      start = end;
    }
  }

  const positioned: PositionedNode[] = [];
  // Leave a visible edge even when cards on adjacent rings face corner to corner.
  const branchRingSpacing =
    Math.max(Math.hypot(...footprint.project), Math.hypot(...footprint.epic)) +
    12;
  let radius = 0;
  let previousRingReach = 0;
  for (const [depth, row] of rows.entries()) {
    row.sort((a, b) => a.angle - b.angle);
    if (depth > 0)
      radius += Math.max(
        depth === 1 ? 158 : branchRingSpacing,
        previousRingReach + 115,
      );
    for (const [index, entry] of row.entries()) {
      const next = row[(index + 1) % row.length];
      if (!next || next === entry) continue;
      const first = footprint[entry.node.kind],
        second = footprint[next.node.kind];
      const gap =
        (next.angle - entry.angle + Math.PI * 2) % (Math.PI * 2) || Math.PI * 2;
      const clearance = (Math.hypot(...first) + Math.hypot(...second)) / 2 + 12;
      radius = Math.max(radius, clearance / (2 * Math.sin(gap / 2)));
    }
    previousRingReach = 0;
    for (const { node, angle } of row) {
      const [width, height] = footprint[node.kind];
      const dx = Math.cos(angle),
        dy = Math.sin(angle);
      const x = radius * dx,
        y = radius * dy;
      positioned.push({
        node,
        x,
        y,
        width,
        height,
      });

      // A leaf cloud stays near its own cluster instead of setting the radius
      // of the entire outer ring when one epic has many direct members.
      const leaves = (model.children.get(node.key) ?? []).filter(
        (child) => child.kind === "bead" && visible.has(child.key),
      );
      const columns = Math.min(4, Math.ceil(Math.sqrt(leaves.length)));
      for (const [index, leaf] of leaves.entries()) {
        const leafRow = Math.floor(index / columns);
        const widthInRows = Math.min(
          columns,
          leaves.length - leafRow * columns,
        );
        const tangent = ((index % columns) - (widthInRows - 1) / 2) * 53;
        const outward = 110 + leafRow * 53;
        previousRingReach = Math.max(previousRingReach, outward);
        positioned.push({
          node: leaf,
          x: x + outward * dx - tangent * dy,
          y: y + outward * dy + tangent * dx,
          width: footprint.bead[0],
          height: footprint.bead[1],
        });
      }
    }
  }
  let boundX = 190,
    boundY = 146;
  for (const { x, y, width, height } of positioned) {
    boundX = Math.max(boundX, Math.abs(x) + width / 2 + 26);
    boundY = Math.max(boundY, Math.abs(y) + height / 2 + 26);
  }
  return {
    nodes: positioned.map((item) => ({
      ...item,
      x: item.x + boundX,
      y: item.y + boundY,
    })),
    width: boundX * 2,
    height: boundY * 2,
  };
}

export function buildPortfolioGraph(
  model: PortfolioModel,
  expanded: ReadonlyMap<string, number>,
  selectedKey: string,
): PortfolioGraph {
  const demanded = new Set(
    [
      ...expanded.keys(),
      selectedKey,
      ...model.workingNow.map((node) => node.key),
    ].flatMap((key) => portfolioPath(model, key).map((node) => node.key)),
  );
  const visible = new Map<string, PortfolioNode>();
  const queue = [OWNER_NODE];
  for (const key of queue) {
    const node = model.nodes.get(key);
    if (!node) continue;
    visible.set(key, node);
    const branch = model.children.get(key) ?? [];
    const firstRows = branch
      .filter((child) => child.kind === "bead")
      .slice(0, Math.min(expanded.get(key) ?? 0, PORTFOLIO_PAGE_SIZE));
    const selectedRows = new Set(firstRows.map((child) => child.key));
    for (const child of branch) {
      const reopen =
        child.kind === "project" ||
        (child.kind === "epic" &&
          (node.kind === "project" || expanded.has(key)));
      if (reopen || selectedRows.has(child.key) || demanded.has(child.key))
        queue.push(child.key);
    }
  }
  const edges: Edge[] = [];
  for (const node of visible.values()) {
    if (node.parentKey)
      edges.push({
        from: node.parentKey,
        to: node.key,
        type: "belongs",
        count: 1,
      });
  }
  const anchorCache = new Map<string, string>();
  const anchor = (node: PortfolioNode) => {
    const stored = anchorCache.get(node.key);
    if (stored) return stored;
    let current = node.key;
    while (!visible.has(current))
      current = model.nodes.get(current)?.parentKey ?? OWNER_NODE;
    anchorCache.set(node.key, current);
    return current;
  };
  const selected = model.nodes.get(selectedKey);
  const projectId =
    selected && selected.kind !== "owner" ? selected.projectId : undefined;
  const rolled = new Map<string, Edge>();
  for (const dependency of model.dependencies) {
    const [upstream, downstream] = dependencyPlacements(
      model,
      dependency,
      projectId,
    );
    if (!upstream || !downstream) continue;
    const from = anchor(upstream),
      to = anchor(downstream);
    if (from === to) continue;
    const endpoints =
      dependency.type === "relates" ? [from, to].sort() : [from, to];
    const key = JSON.stringify([dependency.type, ...endpoints]);
    const match = rolled.get(key);
    if (match) match.count++;
    else rolled.set(key, { from, to, type: dependency.type, count: 1 });
  }
  return {
    ...positionGraph(visible, model),
    edges: [...edges, ...rolled.values()],
  };
}
