import { expect, test } from "bun:test";
import {
  beadNodeKey,
  buildPortfolioGraph,
  buildPortfolioMap,
  epicNodeKey,
  filterPortfolioBeads,
  OWNER_NODE,
  projectNodeKey,
} from "../../apps/desktop/src/portfolio-work-map-model";
import type { ProjectWorkMap } from "../../types/project-work-map";

const asOf = "2026-11-25T18:00:00.000Z";
const bead = (
  id: string,
  title: string,
  projectId: string,
  epicId: string,
  workState: ProjectWorkMap["beads"][number]["workState"],
): ProjectWorkMap["beads"][number] => ({
  id,
  title,
  type: "task",
  status: workState === "completed" ? "closed" : "open",
  workState,
  memberships: [{ projectId, epicId }],
  parentId: epicId,
  updatedAt: asOf,
  delivery: workState === "completed" ? "Verified the delivered result." : null,
  queue: null,
});

const snapshot: ProjectWorkMap = {
  asOf,
  trackerAvailable: true,
  sessionsComplete: true,
  projects: [
    {
      id: "desktop",
      name: "Desktop",
      archived: false,
      availability: "available",
    },
    {
      id: "engine",
      name: "Engine",
      archived: false,
      availability: "available",
    },
    {
      id: "paused",
      name: "Paused",
      archived: true,
      availability: "unavailable",
    },
  ],
  epics: [
    {
      id: "desktop-root",
      projectId: "desktop",
      title: "Release",
      parentId: null,
    },
    {
      id: "desktop-nested",
      projectId: "desktop",
      title: "Installer",
      parentId: "desktop-root",
    },
    {
      id: "engine-root",
      projectId: "engine",
      title: "Runtime",
      parentId: null,
    },
  ],
  beads: [
    bead(
      "desktop-issue",
      "Verify installer",
      "desktop",
      "desktop-nested",
      "blocked",
    ),
    bead(
      "desktop-done",
      "Write instructions",
      "desktop",
      "desktop-root",
      "completed",
    ),
    bead(
      "engine-issue",
      "Record runtime identity",
      "engine",
      "engine-root",
      "working",
    ),
  ],
  dependencies: [{ from: "desktop-issue", to: "engine-issue", type: "blocks" }],
};

test("overview roots every project to You and connects the live bead to its cluster and its dependent", () => {
  const model = buildPortfolioMap(snapshot);
  const graph = buildPortfolioGraph(model, new Map(), OWNER_NODE);
  const live = beadNodeKey("engine", "engine-issue");
  expect(
    graph.nodes
      .filter(({ node }) => node.kind === "bead")
      .map(({ node }) => node.key),
  ).toEqual([live]);
  expect(
    graph.nodes.filter(({ node }) => node.kind === "project"),
  ).toHaveLength(3);
  expect(graph.edges).toContainEqual({
    from: OWNER_NODE,
    to: projectNodeKey("paused"),
    type: "belongs",
    count: 1,
  });
  expect(graph.edges).toContainEqual({
    from: epicNodeKey("engine", "engine-root"),
    to: live,
    type: "belongs",
    count: 1,
  });
  expect(graph.edges).toContainEqual({
    from: live,
    to: epicNodeKey("desktop", "desktop-root"),
    type: "blocks",
    count: 1,
  });
  expect(
    model.nodes.get(epicNodeKey("desktop", "desktop-root"))?.counts,
  ).toMatchObject({ total: 2, completed: 1, blocked: 1 });
});

test("opening a nested epic admits its beads and keeps other project branches connected", () => {
  const model = buildPortfolioMap(snapshot);
  const selected = beadNodeKey("desktop", "desktop-issue");
  const graph = buildPortfolioGraph(
    model,
    new Map([[epicNodeKey("desktop", "desktop-nested"), 20]]),
    selected,
  );
  expect(graph.nodes.some(({ node }) => node.key === selected)).toBe(true);
  expect(
    graph.nodes.filter(({ node }) => node.kind === "project"),
  ).toHaveLength(3);
  expect(graph.edges).toContainEqual({
    from: beadNodeKey("engine", "engine-issue"),
    to: selected,
    type: "blocks",
    count: 1,
  });
  expect(
    filterPortfolioBeads(model, "installer", "blocked").map(({ key }) => key),
  ).toEqual([selected]);
});

test("a live nested bead reveals its ancestry and an ended turn rolls the dependency back up", () => {
  const states = (workState: "working" | "in_progress") =>
    buildPortfolioGraph(
      buildPortfolioMap({
        ...snapshot,
        beads: snapshot.beads.map((item) => {
          if (item.id === "desktop-issue")
            return { ...item, status: "in_progress", workState };
          if (item.id === "engine-issue")
            return { ...item, status: "closed", workState: "completed" };
          return item;
        }),
      }),
      new Map(),
      OWNER_NODE,
    );
  const active = states("working");
  const live = beadNodeKey("desktop", "desktop-issue");
  const root = epicNodeKey("desktop", "desktop-root");
  const nested = epicNodeKey("desktop", "desktop-nested");
  expect(active.edges).toContainEqual({
    from: root,
    to: nested,
    type: "belongs",
    count: 1,
  });
  expect(active.edges).toContainEqual({
    from: nested,
    to: live,
    type: "belongs",
    count: 1,
  });
  const stopped = states("in_progress");
  expect(
    stopped.nodes.some(
      ({ node }) => node.kind === "bead" || node.key === nested,
    ),
  ).toBe(false);
  expect(stopped.edges).toContainEqual({
    from: epicNodeKey("engine", "engine-root"),
    to: root,
    type: "blocks",
    count: 1,
  });
});

test("the overview shows one active bead per project and its branch reveals other live peers", () => {
  const model = buildPortfolioMap({
    ...snapshot,
    beads: [
      ...snapshot.beads,
      bead("engine-extra", "Verify runtime", "engine", "engine-root", "working"),
      bead("desktop-extra", "Write release notes", "desktop", "desktop-root", "working"),
    ],
  });
  const overview = buildPortfolioGraph(model, new Map(), OWNER_NODE);
  const leaves = (graph: typeof overview) =>
    graph.nodes.filter(({ node }) => node.kind === "bead").map(({ node }) => node.key).sort();
  expect(leaves(overview)).toEqual([
    beadNodeKey("desktop", "desktop-extra"),
    beadNodeKey("engine", "engine-issue"),
  ]);
  const epic = epicNodeKey("engine", "engine-root");
  const expanded = buildPortfolioGraph(model, new Map([[epic, 20]]), epic);
  expect(leaves(expanded)).toContain(beadNodeKey("engine", "engine-extra"));
});

test("a dense epic keeps its revealed beads near the cluster instead of enlarging the entire map ring", () => {
  const projectId = "desktop";
  const epics = Array.from({ length: 15 }, (_, index) => ({
    id: `epic-${index}`,
    title: `Epic ${index}`,
    parentId: null,
    projectId,
  }));
  const model = buildPortfolioMap({
    ...snapshot,
    projects: snapshot.projects.filter((project) => project.id === projectId),
    epics,
    beads: Array.from({ length: 20 }, (_, index) =>
      bead(`work-${index}`, `Work ${index}`, projectId, "epic-1", "ready"),
    ),
    dependencies: [],
  });
  const key = epicNodeKey(projectId, "epic-1");
  const graph = buildPortfolioGraph(model, new Map([[key, 20]]), key);
  const epic = graph.nodes.find(({ node }) => node.key === key);
  if (!epic) throw Error("Expected the expanded epic in the overview");
  const leaves = graph.nodes.filter(({ node }) => node.kind === "bead");
  expect(leaves).toHaveLength(20);
  expect(
    Math.max(...leaves.map(({ x, y }) => Math.hypot(x - epic.x, y - epic.y))),
  ).toBeLessThan(480);
});
