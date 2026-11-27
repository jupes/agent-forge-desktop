import { expect, test } from "@playwright/test";
import { buildProjectOverview } from "../../scripts/projects/overview";
import { providerReadinessFixture } from "../../scripts/providers/testing";
import type { BeadsIssue } from "../../types/beads";
import type { LedgerEvent } from "../../types/hearth";
import { readState, withStateLock, writeState } from "../e2e/bd-stand-in-state";
import { BD_STAND_IN_STATE } from "../e2e/servers";
import {
  alpha,
  beta,
  seedProjects,
  seedSessions,
  workspace,
} from "./project-fixtures";

test.beforeEach(seedProjects);

test("the closure chart preserves zero and proportional counts, and its daily readout follows the keyboard", async ({
  page,
}) => {
  const asOf = "2026-11-30T12:00:00.000Z";
  const issues: BeadsIssue[] = [
    {
      id: "alpha-epic",
      title: "Forge production",
      type: "epic",
      status: "open",
      createdAt: alpha.createdAt,
      updatedAt: asOf,
      labels: ["project:alpha"],
    },
  ];
  const events: LedgerEvent[] = [];
  const dailyCounts = [
    0, 3, 4, 8, 2, 0, 0, 2, 7, 10, 4, 2, 0, 0, 1, 11, 6, 4, 7, 3, 0, 0, 5, 8, 9,
    12, 8, 0, 12, 24,
  ];
  for (const [offset, count] of dailyCounts.entries()) {
    const date = `2026-11-${String(offset + 1).padStart(2, "0")}`;
    for (let index = 0; index < count; index++) {
      const id = events.length + 1;
      const beadId = `batch-${id}`;
      issues.push({
        id: beadId,
        title: `Batch ${id}`,
        type: "task",
        status: "closed",
        parent: "alpha-epic",
        labels: ["project:alpha"],
        createdAt: alpha.createdAt,
        updatedAt: asOf,
      });
      events.push({
        id,
        ulid: `event-${id}`,
        workspace,
        beadId,
        ts: `${date}T10:00:00.000Z`,
        kind: "bead.transitioned",
        payload: { action: "close" },
      });
    }
  }
  const data = buildProjectOverview(
    alpha,
    {
      workspace,
      asOf,
      issues,
      queue: [],
      sessions: [],
      sessionsComplete: true,
      problems: [],
    },
    { events, more: false, reservations: [], shifts: [] },
  );
  data.summary.runs.push({
    slug: "phase-fixture",
    phase: "plan",
    completed: ["research"],
    next: null,
    halted: { phase: "plan", reason: "Recorded hold" },
    reviewPending: null,
    revising: false,
    complete: false,
    mode: "gated",
    feature: null,
    epic: null,
    checkout: workspace,
    updatedAt: data.summary.asOf,
  });
  await page.route(`**/projects/${alpha.id}/overview`, (route) =>
    route.fulfill({ json: { ok: true, data, error: null } }),
  );
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto(`/index.html#/desktop/project/${alpha.id}/overview`);
  const chart = page.getByRole("figure", {
    name: "Recorded closures by UTC day",
  });
  const slider = chart.getByRole("slider", { name: "Inspect daily closures" });
  await expect(slider).toHaveAttribute(
    "aria-valuetext",
    "2026-11-30 UTC, 24 closures",
  );
  await slider.press("ArrowLeft");
  await expect(slider).toHaveAttribute(
    "aria-valuetext",
    "2026-11-29 UTC, 12 closures",
  );
  await page.getByRole("region", { name: "Recorded throughput" }).screenshot({
    path: ".tmp/screenshots/forge-desktop/overview.png",
  });
  await chart.getByText("Daily counts", { exact: true }).click();
  await expect(
    chart.getByRole("row", { name: "2026-11-29 12" }),
  ).toHaveAttribute("data-selected", "true");
  const bars = chart.locator(".af-forge-bin i");
  await expect(bars).toHaveCount(30);
  const heights = await bars.evaluateAll((nodes) =>
    nodes.map((node) => node.getBoundingClientRect().height),
  );
  expect(heights[0]).toBe(0);
  expect(heights[29]).toBeGreaterThan(0);
  expect(heights[28]! / heights[29]!).toBeCloseTo(0.5);
  await expect(bars.first()).toHaveCSS("transition-duration", "0s");
  const phases = page
    .getByRole("list", { name: "Recorded run phases" })
    .getByRole("listitem");
  await expect(phases.nth(0)).toHaveAttribute("data-state", "Complete");
  await expect(phases.nth(1)).toHaveAttribute("data-state", "Halted");
  await expect(phases.nth(2)).toHaveAttribute("data-state", "Upcoming");
  await page
    .getByRole("region", { name: "Forge run observations" })
    .screenshot({
      path: ".tmp/screenshots/forge-desktop/run-phases.png",
    });
});

test("Overview shows three of four scoped needs-you items and linked sections", async ({
  page,
}) => {
  const readiness = providerReadinessFixture(workspace, alpha.id);
  readiness.localUsage.projects = [
    { projectId: alpha.id, name: alpha.name, providers: [] },
  ];
  await page.route("**/providers/readiness", (route) =>
    route.fulfill({ json: { ok: true, data: readiness, error: null } }),
  );
  withStateLock(BD_STAND_IN_STATE, () => {
    const state = readState(BD_STAND_IN_STATE);
    for (const [index, queue] of [
      "proposed",
      "review",
      "halted",
      "proposed",
    ].entries()) {
      const id = `alpha-child-${index}`;
      const row = {
        id,
        title: `Scoped task ${index}`,
        issue_type: "task",
        status: "open",
        priority: 2,
        created_at: alpha.createdAt,
        updated_at: alpha.updatedAt,
        labels: ["project:alpha", `queue:${queue}`],
        metadata: { queue_state: queue },
        dependencies: [
          { issue_id: id, depends_on_id: "alpha-epic", type: "parent-child" },
        ],
      };
      state[id] = row;
    }
    writeState(BD_STAND_IN_STATE, state);
  });
  await page.goto(`/index.html#/desktop/project/${alpha.id}/overview`);
  const needs = page.getByRole("region", { name: "Needs you", exact: true });
  await expect(
    needs.getByRole("heading", { name: "Needs you · 4" }),
  ).toBeVisible();
  await expect(needs.getByRole("listitem")).toHaveCount(3);
  await expect(
    needs.getByRole("link", { name: "See all 4 queue items" }),
  ).toBeVisible();
  await expect(
    page.getByRole("region", { name: "Reported project usage" }),
  ).toContainText("no project session totals were reported in this read");
  await expect(
    page.getByRole("region", { name: "Scoped bead counts" }),
  ).toContainText("5Open");
  await expect(
    page.getByRole("region", { name: "Epics", exact: true }),
  ).toContainText("Alpha epic");
  await page.screenshot({
    path: test.info().outputPath("project-overview.png"),
  });
  await needs.getByRole("link", { name: /alpha-child-0/ }).click();
  await expect(page).toHaveURL(
    /workbench\?selectionKind=bead&selectionId=alpha-child-0$/,
  );
});

test("unavailable project attribution stays distinct from a verified empty report", async ({
  page,
}) => {
  const readiness = providerReadinessFixture(workspace, alpha.id);
  readiness.localUsage.projects = null;
  await page.route("**/providers/readiness", (route) =>
    route.fulfill({ json: { ok: true, data: readiness, error: null } }),
  );
  let providerActionPosts = 0;
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (request.method() === "POST" && url.pathname.includes("/providers/"))
      providerActionPosts++;
  });

  await page.goto(`/index.html#/desktop/project/${alpha.id}/overview`);
  const usage = page.getByRole("region", {
    name: "Reported project usage",
    exact: true,
  });
  await expect(usage).toContainText("Project usage attribution unavailable.");
  await expect(usage).not.toContainText(
    "Usage — no project session totals were reported in this read.",
  );
  expect(providerActionPosts).toBe(0);
});

test("a delayed previous-project read cannot paint the next project, and Back restores scope", async ({
  page,
}) => {
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let first = true;
  await page.route(`**/projects/${alpha.id}/overview`, async (route) => {
    if (first) {
      first = false;
      await held;
    }
    await route.continue();
  });
  await page.goto(`/index.html#/desktop/project/${alpha.id}/overview`);
  await expect(
    page.getByText("Loading project overview…", { exact: true }),
  ).toBeVisible();
  await page.getByRole("link", { name: "Projects", exact: true }).click();
  await page.getByRole("link", { name: "Open Beta", exact: true }).click();
  await expect(
    page.getByRole("region", { name: "Epics", exact: true }),
  ).toContainText("Beta epic");
  const oldRead = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/projects/${alpha.id}/overview`) &&
      response.status() === 200,
  );
  release();
  await oldRead;
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
  );
  await expect(
    page.getByRole("region", { name: "Epics", exact: true }),
  ).not.toContainText("Alpha epic");
  await expect(page.locator(".af-desktop-project-name")).toHaveText("Beta");
  await page.goBack();
  await page.goBack();
  await expect(
    page.getByRole("region", { name: "Epics", exact: true }),
  ).toContainText("Alpha epic");
  await expect(page.locator(".af-desktop-project-name")).toHaveText("Alpha");
});

test("session list and sidebar share scope, filtering and inspector; switching rejects foreign selection", async ({
  page,
}) => {
  seedSessions();
  await page.goto(`/index.html#/desktop/project/${alpha.id}/sessions`);
  // Other cases record legitimate observations in the same isolated ledger.
  // Select this fixture's identities through the actual list filter.
  await page.getByLabel("Find sessions").fill("e2e-alpha-");
  const observed = page.getByRole("region", { name: "Observed", exact: true });
  await expect(observed.getByRole("row")).toHaveCount(3);
  await expect(observed).toContainText("e2e-alpha-parent");
  await expect(observed).toContainText("e2e-alpha-child");
  await expect(observed).not.toContainText("e2e-beta-own");
  const indent = await page
    .locator('.af-desktop-sidebar a[href*="selectionId=e2e-alpha-child"]')
    .evaluate((element) =>
      Number.parseFloat(getComputedStyle(element).paddingLeft),
    );
  const parentIndent = await page
    .locator('.af-desktop-sidebar a[href*="selectionId=e2e-alpha-parent"]')
    .evaluate((element) =>
      Number.parseFloat(getComputedStyle(element).paddingLeft),
    );
  expect(indent).toBeGreaterThan(parentIndent);
  await page
    .getByRole("link", { name: "Open e2e-alpha-child", exact: true })
    .click();
  await expect(
    page.getByRole("region", { name: "Selected session" }),
  ).toContainText("e2e-alpha-child");
  await page.screenshot({
    path: test.info().outputPath("project-sessions.png"),
  });
  await page.getByRole("link", { name: "All sessions", exact: true }).click();
  await page.getByLabel("Find sessions").fill("no match");
  await expect(
    page.getByText("No matching sessions", { exact: true }),
  ).toBeVisible();
  await page.getByLabel("Find sessions").fill("");
  await page.getByLabel("Select e2e-alpha-child", { exact: true }).check();
  await expect(
    page.getByRole("button", { name: "Stop selected", exact: true }),
  ).toBeDisabled();
  await page.goto(
    `/index.html#/desktop/project/${beta.id}/sessions?selectionKind=session&selectionId=e2e-alpha-child`,
  );
  await expect(
    page.getByText("Session unavailable in this project", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("region", { name: "Session metadata details", exact: true }),
  ).toContainText("not in this project's verified metadata");
  await page.getByRole("link", { name: "All sessions", exact: true }).click();
  await expect(
    page.getByRole("region", { name: "Observed", exact: true }),
  ).toContainText("e2e-beta-own");
  await expect(
    page.getByRole("region", { name: "Observed", exact: true }),
  ).not.toContainText("e2e-alpha-child");
  await page.setViewportSize({ width: 1100, height: 700 });
  const keeper = page.getByRole("link", { name: "Forge Keeper", exact: true });
  await keeper.focus();
  await expect(keeper).toBeFocused();
  await page.screenshot({
    path: test.info().outputPath("project-sessions-1100.png"),
  });
});
