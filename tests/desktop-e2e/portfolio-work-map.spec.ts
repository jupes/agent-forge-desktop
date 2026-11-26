import { writeFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { projectWorkMapSchema } from "../../scripts/projects/project-work-map-protocol";
import {
  readState,
  type StandInIssue,
  withStateLock,
  writeState,
} from "../e2e/bd-stand-in-state";
import { openSettled } from "../e2e/fixtures";
import { BD_STAND_IN_STATE } from "../e2e/servers";
import {
  alpha,
  beta,
  catalog,
  catalogFile,
  seedProjects,
  workspace,
} from "./project-fixtures";

const mapPath = "/__agent-forge/projects/work-map";
const result = "Verified that uninstall removes the app's own files.";

function seedWorkMap(): void {
  seedProjects();
  const bead = (
    id: string,
    title: string,
    project: typeof alpha,
    extra: Partial<StandInIssue> & { notes?: string } = {},
  ) => ({
    id,
    title,
    issue_type: "task",
    status: "open",
    priority: 2,
    created_at: project.createdAt,
    updated_at: project.updatedAt,
    labels: [`project:${project.slug}`],
    dependencies: [
      {
        issue_id: id,
        depends_on_id: `${project.slug}-epic`,
        type: "parent-child",
      },
    ],
    ...extra,
  });

  withStateLock(BD_STAND_IN_STATE, () => {
    const state = readState(BD_STAND_IN_STATE);
    // Existing fixture projects and their saved epic anchors are retained.
    state["alpha-epic"]!.title = "Release fixes";
    state["beta-epic"]!.title = "Runtime packaging";
    const installer = bead("map-installer", "Map installer acceptance", alpha);
    installer.dependencies.push({
      issue_id: installer.id,
      depends_on_id: "map-runtime",
      type: "blocks",
    });
    const cleanup = bead("map-cleanup", "Map installer cleanup", alpha, {
      status: "closed",
      notes: `Unrelated private drafting note.\nDelivered: ${result}`,
    });
    const runtime = bead("map-runtime", "Map runtime metadata", beta, {
      status: "in_progress",
    });
    const notes = bead("map-notes", "Draft release notes", beta, {
      status: "in_progress",
    });
    writeState(BD_STAND_IN_STATE, {
      ...state,
      [installer.id]: installer,
      [cleanup.id]: cleanup,
      [runtime.id]: runtime,
      [notes.id]: notes,
    });
  });
}

test("the protected Work Map starts at the portfolio and follows epic delivery and cross-project dependencies", async ({
  page,
}) => {
  seedWorkMap();
  await page.emulateMedia({ reducedMotion: "reduce" });
  const mapResponse = page.waitForResponse(
    (response) => new URL(response.url()).pathname === mapPath,
  );
  await openSettled(page, "/index.html#/desktop/work-map");
  const response = await mapResponse;
  expect(response.status()).toBe(200);
  expect(response.request().method()).toBe("GET");
  const body: unknown = await response.json();
  expect(body).toMatchObject({ ok: true, error: null });
  expect(JSON.stringify(body)).not.toContain("Unrelated private drafting note");

  const refusal = await page.evaluate(async (path) => {
    const response = await fetch(path, { cache: "no-store" });
    return response.status;
  }, mapPath);
  expect(refusal).toBe(403);

  await expect(page).toHaveURL(/#\/desktop\/work-map$/);
  await expect(page.getByRole("heading", { name: "Work Map" })).toBeVisible();
  const graph = page.getByRole("group", { name: "Portfolio graph" });
  const you = graph.getByRole("button", { name: "You", exact: true });
  const release = graph.getByRole("button", { name: "Release fixes, epic" });
  const packaging = graph.getByRole("button", {
    name: "Runtime packaging, epic",
  });
  const installer = graph.getByRole("button", {
    name: /^map-installer, Map installer acceptance/,
  });
  const runtime = graph.getByRole("button", {
    name: /^map-runtime, Map runtime metadata/,
  });
  await expect(you).toBeVisible();
  for (const name of [alpha.name, beta.name]) {
    await expect(
      graph.getByRole("button", { name, exact: true }),
    ).toBeVisible();
  }
  await expect(release).toHaveAttribute("aria-expanded", "false");
  await expect(packaging).toHaveAttribute("aria-expanded", "false");
  await expect(graph.locator('[data-kind="bead"]')).toHaveCount(0);

  await release.press("Enter");
  await expect(release).toHaveAttribute("aria-expanded", "true");
  const details = page.getByRole("complementary", { name: "Work Map details" });
  await expect(details.getByText(result, { exact: true })).toBeVisible();
  await expect(installer).toBeVisible();
  await expect(runtime).toHaveCount(0);
  await installer.click();
  await expect(details).toContainText(/blocked/i);
  await details
    .getByRole("button", {
      name: "map-runtime, Map runtime metadata, Blocked by",
    })
    .click();
  await expect(runtime).toBeVisible();
  await expect(packaging).toHaveAttribute("aria-expanded", "true");

  await details.getByText("Open bead", { exact: true }).click();
  await expect(page).toHaveURL(
    new RegExp(`#\\/desktop\\/project\\/${beta.id}\\/beads\\?`),
  );
  expect(
    new URLSearchParams(new URL(page.url()).hash.split("?")[1]).get(
      "selectionId",
    ),
  ).toBe("map-runtime");
  const beadPage = page.getByRole("region", { name: "Bead map-runtime" });
  await expect(
    beadPage.getByRole("heading", {
      name: "Map runtime metadata",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    beadPage.getByRole("tabpanel", { name: "Details for map-runtime" }),
  ).toBeVisible();

  await openSettled(page, "/index.html#/desktop/work-map");
  await expect(you).toBeVisible();
  await release.press("Enter");
  await expect(release).toHaveAttribute("aria-expanded", "true");
  await expect(installer).toBeVisible();
  await you.press("Enter");
  await expect(release).toHaveAttribute("aria-expanded", "false");
  await expect(packaging).toHaveAttribute("aria-expanded", "false");
  await expect(graph.locator('[data-kind="bead"]')).toHaveCount(0);
});

test("epic expansion keeps lines attached, reverses in place and honors reduced motion", async ({
  page,
}) => {
  seedWorkMap();
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.clock.install();
  await openSettled(page, "/index.html#/desktop/work-map");
  const graph = page.getByRole("group", { name: "Portfolio graph" });
  const you = graph.getByRole("button", { name: "You", exact: true });
  const epic = graph.getByRole("button", { name: "Release fixes, epic" });
  const cleanup = graph.getByRole("button", { name: /^map-cleanup,/ });
  await expect(epic).toBeInViewport();
  await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1000));

  const branch = () =>
    graph.evaluate((viewport) => {
      const epic = viewport.querySelector('[aria-label="Release fixes, epic"]');
      const bead = viewport.querySelector('[aria-label^="map-cleanup,"]');
      const canvas = viewport.parentElement?.querySelector("canvas");
      const ctx = canvas?.getContext("2d");
      if (!epic || !bead || !canvas || !ctx)
        throw Error("Expected a rendered epic, bead and connection canvas");
      const bounds = canvas.getBoundingClientRect();
      const center = (el: Element) => {
        const box = el.getBoundingClientRect();
        return {
          x: box.x + box.width / 2 - bounds.x,
          y: box.y + box.height / 2 - bounds.y,
        };
      };
      const from = center(epic);
      const to = center(bead);
      const dx = to.x - from.x;
      const dy = to.y - from.y;
      // Read the rendered membership line near both ends at this exact frame.
      const connected = [0.25, 0.75].every((part) => {
        const x = Math.round(
          ((from.x + dx * part) * canvas.width) / bounds.width,
        );
        const y = Math.round(
          ((from.y + dy * part) * canvas.height) / bounds.height,
        );
        return ctx
          .getImageData(x - 1, y - 1, 3, 3)
          .data.some((value, i) => i % 4 === 3 && value > 0);
      });
      return { distance: Math.hypot(dx, dy), connected };
    });

  try {
    await epic.press("Enter");
    await page.clock.runFor(64);
    const opening = await branch();
    expect(opening.connected).toBe(true);
    expect(opening.distance).toBeGreaterThan(1);
    await page.clock.runFor(500);
    const expanded = await branch();
    expect(expanded.connected).toBe(true);
    expect(expanded.distance).toBeGreaterThan(opening.distance + 1);

    await you.press("Enter");
    await page.clock.runFor(64);
    await expect(cleanup).toHaveCount(0);
    const closing = await branch();
    expect(closing.distance).toBeGreaterThan(1);
    expect(closing.distance).toBeLessThan(expanded.distance - 1);
    await epic.press("Enter");
    expect((await branch()).distance).toBeCloseTo(closing.distance, 0);
    await page.clock.runFor(500);
    expect((await branch()).distance).toBeCloseTo(expanded.distance, 0);
    await expect(cleanup).toHaveCount(1);

    const scale = page.getByRole("group", { name: "Graph scale" });
    const zoomIn = scale.getByRole("button", { name: "Zoom in" });
    const ownerWidth = () =>
      you.evaluate((button) => button.getBoundingClientRect().width);
    const fitted = await ownerWidth();
    await zoomIn.press("Enter");
    await page.clock.runFor(64);
    const midZoom = await ownerWidth();
    expect(midZoom).toBeGreaterThan(fitted);
    await scale
      .getByRole("button", { name: "Fit", exact: true })
      .press("Enter");
    await page.clock.runFor(500);
    expect(await ownerWidth()).toBeCloseTo(fitted, 1);

    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.clock.runFor(32);
    await you.press("Enter");
    await page.clock.runFor(16);
    await expect(graph.locator('[data-kind="bead"]')).toHaveCount(0);
    await epic.press("Enter");
    await page.clock.runFor(16);
    const reduced = await branch();
    expect(reduced.distance).toBeCloseTo(expanded.distance, 0);
    expect(reduced.connected).toBe(true);
    await zoomIn.press("Enter");
    await page.clock.runFor(16);
    const reducedZoom = await ownerWidth();
    expect(reducedZoom).toBeGreaterThan(midZoom);
    await page.clock.runFor(500);
    expect(await ownerWidth()).toBeCloseTo(reducedZoom, 1);
  } finally {
    await page.clock.resume();
  }
});

test("live work is visible on the collapsed map and honors reduced motion", async ({
  page,
}) => {
  seedWorkMap();
  await page.emulateMedia({ reducedMotion: "no-preference" });
  const authorizedRead = page.waitForResponse(
    (response) => new URL(response.url()).pathname === mapPath,
  );
  await openSettled(page, "/index.html#/desktop/work-map");
  const response = await authorizedRead;
  expect(response.status()).toBe(200);
  const envelope = await response.json();
  expect(envelope).toMatchObject({ ok: true, error: null });
  const data = projectWorkMapSchema.parse(envelope.data);
  const observed = data.beads.find((bead) => bead.id === "map-runtime");
  if (observed?.workState !== "in_progress")
    throw Error("Expected the admitted in-progress runtime bead");
  observed.workState = "working";
  let unavailable = false;
  // Only the owned-turn observation changes on the first refresh. The final
  // refresh goes back through the browser's normal protected read.
  const fixtureRoute = `**${mapPath}`;
  await page.route(fixtureRoute, async (route) => {
    if (unavailable)
      return route.fulfill({
        status: 503,
        json: { ok: false, data: null, error: "Fixture read unavailable" },
      });
    await route.fulfill({ json: { ok: true, data, error: null } });
  });
  const refresh = page.getByRole("button", { name: "Refresh", exact: true });
  await refresh.click();
  const graph = page.getByRole("group", { name: "Portfolio graph" });
  const live = graph.getByRole("button", {
    name: "map-runtime, Map runtime metadata, Working now",
  });
  const epic = graph.getByRole("button", { name: "Runtime packaging, epic" });
  const trackerOnly = graph.getByRole("button", { name: /^map-notes,/ });
  const hammer = live.locator(".af-portfolio-forge-hammer");
  const hammerLoops = () =>
    hammer.evaluate((part) =>
      part
        .getAnimations()
        .some(
          (animation) =>
            animation.playState === "running" &&
            animation.effect?.getTiming().iterations === Infinity,
        ),
    );
  await expect(epic).toHaveAttribute("aria-expanded", "false");
  await expect(live).toBeInViewport();
  await expect(trackerOnly).toHaveCount(0);
  await expect(graph.locator('[data-forging="true"]')).toHaveCount(1);
  await expect.poll(hammerLoops).toBe(true);
  await live.click();
  await expect(epic).toHaveAttribute("aria-expanded", "true");
  await expect(
    page.getByRole("heading", { name: "Map runtime metadata" }),
  ).toBeVisible();
  await expect(trackerOnly).toHaveAccessibleName(/In progress/);
  await expect(trackerOnly.locator(".af-portfolio-forge")).toHaveCount(0);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect.poll(hammerLoops).toBe(false);
  await expect(hammer).toBeVisible();

  await graph.getByRole("button", { name: "You", exact: true }).press("Enter");
  const workingNow = page.getByRole("region", {
    name: "Working now",
    exact: true,
  });
  await workingNow
    .getByRole("button", { name: /^map-runtime, Map runtime metadata, Beta$/ })
    .press("Enter");
  await expect(live).toHaveAttribute("aria-pressed", "true");
  await expect
    .poll(async () => {
      const [bead, viewport] = await Promise.all([
        live.boundingBox(),
        graph.boundingBox(),
      ]);
      if (!bead || !viewport) return Infinity;
      return Math.hypot(
        bead.x - viewport.x + (bead.width - viewport.width) / 2,
        bead.y - viewport.y + (bead.height - viewport.height) / 2,
      );
    })
    .toBeLessThan(2);
  await page.emulateMedia({ reducedMotion: "no-preference" });
  unavailable = true;
  await refresh.click();
  await expect(
    graph.getByRole("button", { name: /^map-runtime,/ }),
  ).toHaveAccessibleName(/Last seen working/);
  await expect(graph.locator('[data-forging="true"]')).toHaveCount(0);
  await page.unroute(fixtureRoute);
  await refresh.click();
  await expect(
    graph.getByRole("button", { name: /^map-runtime,/ }),
  ).toHaveAccessibleName(/In progress/);
  await expect(graph.locator(".af-portfolio-forge")).toHaveCount(0);
});

test("left-click drag pans the Work Map and Back to center preserves the focused branch", async ({
  page,
}) => {
  seedWorkMap();
  await page.emulateMedia({ reducedMotion: "reduce" });
  await openSettled(page, "/index.html#/desktop/work-map");
  const graph = page.getByRole("group", { name: "Portfolio graph" });
  const you = graph.getByRole("button", { name: "You", exact: true });
  const release = graph.getByRole("button", { name: "Release fixes, epic" });
  const scale = page.getByRole("group", { name: "Graph scale" });
  const center = page.getByRole("button", { name: "Back to center" });
  await expect(you).toBeInViewport();
  await expect(center).toBeInViewport();

  const position = async (node: typeof you) => {
    const box = await node.boundingBox();
    if (!box) throw Error("Expected a visible graph element");
    return box;
  };
  const drag = async (x: number, y: number, dx: number, dy: number) => {
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + dx, y + dy, { steps: 5 });
    await page.mouse.up();
  };
  const ownerPosition = async () => {
    const [box, viewport] = await Promise.all([position(you), position(graph)]);
    return {
      x: box.x - viewport.x,
      y: box.y - viewport.y,
      width: box.width,
      height: box.height,
    };
  };
  const expectMoved = async (
    before: { x: number; y: number },
    dx: number,
    dy: number,
  ) => {
    await expect
      .poll(async () => {
        const after = await ownerPosition();
        return Math.max(
          Math.abs(after.x - before.x - dx),
          Math.abs(after.y - before.y - dy),
        );
      })
      .toBeLessThan(2);
  };
  const centerOffset = async () => {
    const [owner, viewport] = await Promise.all([
      position(you),
      position(graph),
    ]);
    return {
      x: owner.x - viewport.x + (owner.width - viewport.width) / 2,
      y: owner.y - viewport.y + (owner.height - viewport.height) / 2,
      width: owner.width,
    };
  };
  const expectAnchorAcrossSizes = async () => {
    const desktop = page.viewportSize();
    if (!desktop) throw Error("Expected a controlled desktop viewport");
    const before = await centerOffset();
    for (const size of [{ width: 390, height: 844 }, desktop]) {
      await page.setViewportSize(size);
      // Observe the map after its ResizeObserver has had a full rendering turn.
      await page.evaluate(
        () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          ),
      );
      await expect
        .poll(async () => {
          const after = await centerOffset();
          // A fixed point in the graph moves in CSS pixels in proportion to scale.
          const ratio = after.width / before.width;
          return Math.hypot(
            after.x - before.x * ratio,
            after.y - before.y * ratio,
          );
        })
        .toBeLessThan(3);
    }
    expect((await centerOffset()).width).toBeCloseTo(before.width, 1);
  };

  const fitted = await ownerPosition();
  const canvas = await position(graph);
  const docked = await position(center);
  // Stay in the visible canvas below the floating control. The graph can extend
  // past the bottom of the browser when the toolbar and header are present.
  const start = { x: canvas.x + 24, y: docked.y + docked.height + 18 };
  expect(
    await graph.evaluate(
      (viewport, point) =>
        viewport.contains(document.elementFromPoint(point.x, point.y)),
      start,
    ),
  ).toBe(true);
  await drag(start.x, start.y, 60, 36);
  await expectMoved(fitted, 60, 36);
  expect(await position(center)).toEqual(docked);
  await page.mouse.move(canvas.x + 150, canvas.y + 120);
  await expectMoved(fitted, 60, 36);
  await expectAnchorAcrossSizes();

  await scale.getByRole("button", { name: "Fit", exact: true }).click();
  await expectMoved(fitted, 0, 0);
  await expectAnchorAcrossSizes();
  await scale.getByRole("button", { name: "Zoom in" }).click();
  await expect
    .poll(async () => (await position(you)).width)
    .toBeGreaterThan(fitted.width);
  await expect(release).toBeInViewport();
  const zoomed = await ownerPosition();
  const epic = await position(release);
  await drag(epic.x + epic.width / 2, epic.y + epic.height / 2, 22, 16);
  await expectMoved(zoomed, 22, 16);
  await expect(release).toHaveAttribute("aria-expanded", "false");
  await expect(release).toHaveAttribute("aria-pressed", "false");
  expect((await position(you)).width).toBeCloseTo(zoomed.width);

  const shiftedEpic = await position(release);
  const epicX = shiftedEpic.x + shiftedEpic.width / 2;
  const epicY = shiftedEpic.y + shiftedEpic.height / 2;
  await page.mouse.move(epicX, epicY);
  await page.mouse.down();
  await page.mouse.move(epicX + 1, epicY + 1);
  await expectMoved(zoomed, 22, 16);
  await page.mouse.up();
  await expect(release).toHaveAttribute("aria-expanded", "true");
  await expect(release).toHaveAttribute("aria-pressed", "true");
  const completed = page
    .getByRole("group", { name: "Filter by work status" })
    .getByRole("button", { name: "Completed", exact: true });
  await completed.click();
  await scale.getByRole("button", { name: "Focus selection" }).click();
  const distanceToCenter = async () => {
    const offset = await centerOffset();
    return Math.hypot(offset.x, offset.y);
  };
  await expect.poll(distanceToCenter).toBeGreaterThan(20);
  const focusedWidth = (await ownerPosition()).width;
  await center.press("Enter");
  await expect.poll(distanceToCenter).toBeLessThan(2);
  expect((await ownerPosition()).width).toBeCloseTo(focusedWidth, 1);
  await expect(release).toHaveAttribute("aria-expanded", "true");
  await expect(release).toHaveAttribute("aria-pressed", "true");
  await expect(completed).toHaveAttribute("aria-pressed", "true");
});

test("Default prepares a session with references across projects and an explicit Beads export", async ({
  page,
}) => {
  seedWorkMap();
  const defaultProject = {
    ...alpha,
    id: "project-6f45aa26-3f21-42d6-978d-1fa0d14ee8fb",
    slug: "default",
    name: "Default",
    workspaces: [
      { root: workspace, repositories: [workspace], epicIds: ["default-epic"] },
    ],
  };
  writeFileSync(
    catalogFile,
    JSON.stringify({
      ...catalog,
      projects: [...catalog.projects, defaultProject],
    }),
  );
  withStateLock(BD_STAND_IN_STATE, () => {
    const state = readState(BD_STAND_IN_STATE);
    writeState(BD_STAND_IN_STATE, {
      ...state,
      "default-epic": {
        ...state["alpha-epic"]!,
        id: "default-epic",
        title: "Cross-project work",
        labels: ["project:default"],
      },
    });
  });
  const trackerBefore = readState(BD_STAND_IN_STATE);
  const projectPath = `/index.html#/desktop/project/${defaultProject.id}`;
  await openSettled(page, `${projectPath}/sessions`);
  const writes: string[] = [];
  page.on("request", (request) => {
    if (request.method() === "POST")
      writes.push(new URL(request.url()).pathname);
  });
  await page.getByRole("button", { name: "New session", exact: true }).click();
  const composer = page.getByRole("dialog", { name: "New session · Default" });
  const prompt = composer.getByRole("textbox", { name: "Session prompt" });
  const ownPrompt = "Keep this existing user prompt.";
  await prompt.fill(ownPrompt);
  await composer.getByRole("button", { name: "Cancel", exact: true }).click();

  await openSettled(page, `${projectPath}/overview`);
  const context = page.getByRole("region", { name: "Cross-project context" });
  const savedProjects = context.getByRole("group", { name: "Saved projects" });
  await savedProjects.getByRole("checkbox", { name: /^Alpha\b/ }).check();
  await savedProjects.getByRole("checkbox", { name: /^Beta\b/ }).check();
  const beads = context.getByRole("group", { name: "Local beads" });
  await beads.getByRole("checkbox", { name: /^map-installer\b/ }).check();
  await beads.getByRole("checkbox", { name: /^map-runtime\b/ }).check();
  await context
    .getByRole("group", { name: "Repository references" })
    .getByRole("checkbox", { name: workspace, exact: true })
    .check();

  const privateBody = "Private imported body stays in the export.";
  await context.getByLabel("Choose Beads JSONL exports").setInputFiles({
    name: "other-tracker.jsonl",
    mimeType: "application/jsonl",
    buffer: Buffer.from(
      `${JSON.stringify({
        id: "external-17",
        title: "Imported follow-up",
        status: "open",
        description: privateBody,
      })}\n`,
    ),
  });
  await context.getByRole("checkbox", { name: /^external-17\b/ }).check();
  const draft = await context
    .getByRole("textbox", { name: "Draft context" })
    .inputValue();
  for (const reference of [
    defaultProject.id,
    alpha.id,
    beta.id,
    "map-installer",
    "map-runtime",
    workspace,
    "external-17",
    "other-tracker.jsonl",
  ]) {
    expect(draft).toContain(reference);
  }
  expect(draft).not.toContain(privateBody);

  await context
    .getByRole("button", { name: "Prepare session", exact: true })
    .click();
  await expect(page).toHaveURL(
    new RegExp(`/desktop/project/${defaultProject.id}/overview$`),
  );
  await expect(composer).toBeVisible();
  const prepared = await prompt.inputValue();
  expect(prepared).toContain(ownPrompt);
  expect(prepared).toContain(draft);
  expect(writes).toEqual([]);
  expect(readState(BD_STAND_IN_STATE)).toEqual(trackerBefore);
});
