import { writeFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
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
    const runtime = bead("map-runtime", "Map runtime metadata", beta);
    writeState(BD_STAND_IN_STATE, {
      ...state,
      [installer.id]: installer,
      [cleanup.id]: cleanup,
      [runtime.id]: runtime,
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

test("left-click drag pans the Work Map without opening a node", async ({
  page,
}) => {
  seedWorkMap();
  await openSettled(page, "/index.html#/desktop/work-map");
  const graph = page.getByRole("group", { name: "Portfolio graph" });
  const you = graph.getByRole("button", { name: "You", exact: true });
  const release = graph.getByRole("button", { name: "Release fixes, epic" });
  const scale = page.getByRole("group", { name: "Graph scale" });
  await expect(you).toBeInViewport();

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
    return { x: box.x - viewport.x, y: box.y - viewport.y, width: box.width };
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

  const fitted = await ownerPosition();
  const canvas = await position(graph);
  await drag(canvas.x + 24, canvas.y + 24, 60, 36);
  await expectMoved(fitted, 60, 36);
  await page.mouse.move(canvas.x + 150, canvas.y + 120);
  await expectMoved(fitted, 60, 36);

  await scale.getByRole("button", { name: "Fit", exact: true }).click();
  await expectMoved(fitted, 0, 0);
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
