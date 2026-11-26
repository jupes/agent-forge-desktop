import { expect, test } from "@playwright/test";
import {
  readState,
  type StandInIssue,
  withStateLock,
  writeState,
} from "../e2e/bd-stand-in-state";
import { openSettled } from "../e2e/fixtures";
import { BD_STAND_IN_STATE } from "../e2e/servers";
import { alpha, beta, seedProjects } from "./project-fixtures";

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
