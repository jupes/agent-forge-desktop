import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import type { ProjectOverview } from "../../types/project-overview";
import type { ProjectWorkMap } from "../../types/project-work-map";

const asOf = "2026-11-26T12:15:00.000Z";
const projects = [
  {
    id: "project-93f58924-6a35-46e2-a190-914b4ce82322",
    name: "Foundry tools",
    archived: false,
    availability: "available",
  },
  {
    id: "project-b780e0cd-fc2e-49f1-ae81-3248ed8f698e",
    name: "Atlas library",
    archived: false,
    availability: "available",
  },
] satisfies ProjectWorkMap["projects"];
const epics = [
  {
    id: "forge-layout",
    projectId: projects[0]!.id,
    title: "Workshop layout",
    parentId: null,
  },
  {
    id: "atlas-index",
    projectId: projects[1]!.id,
    title: "Field index",
    parentId: null,
  },
];

function bead(
  id: string,
  title: string,
  epic: (typeof epics)[number],
  workState: ProjectWorkMap["beads"][number]["workState"],
  status: string,
  delivery: string | null = null,
): ProjectWorkMap["beads"][number] {
  return {
    id,
    title,
    type: "task",
    status,
    workState,
    delivery,
    memberships: [{ projectId: epic.projectId, epicId: epic.id }],
    parentId: epic.id,
    queue: null,
    updatedAt: asOf,
  };
}

const snapshot: ProjectWorkMap = {
  asOf,
  trackerAvailable: true,
  sessionsComplete: true,
  projects,
  epics,
  beads: [
    bead(
      "forge-12",
      "Arrange the workstations",
      epics[0]!,
      "working",
      "in_progress",
    ),
    bead("forge-18", "Mark the delivery lanes", epics[0]!, "blocked", "open"),
    bead("forge-20", "Measure the tool bays", epics[0]!, "ready", "open"),
    bead(
      "atlas-2",
      "Publish the shelf index",
      epics[1]!,
      "completed",
      "closed",
      "Published the workshop shelf index.",
    ),
    bead("atlas-6", "Review the field notes", epics[1]!, "not_started", "open"),
  ],
  dependencies: [{ from: "forge-18", to: "atlas-2", type: "blocks" }],
};

async function installReader(
  page: Page,
  responses: (ProjectWorkMap | string)[],
) {
  const history: ProjectOverview["throughput"] = {
    asOf,
    complete: true,
    reason: null,
    source: "Closures recorded by this hearth · 30 UTC days",
    data: Array.from({ length: 30 }, (_, index) => ({
      date: new Date(
        Date.parse("2026-10-28T00:00:00.000Z") + index * 86_400_000,
      )
        .toISOString()
        .slice(0, 10),
      count: (index * 7) % 9,
    })),
  };
  await page.addInitScript(
    ({ answers, history, ids }) => {
      const commands: string[] = [];
      let reads = 0;
      Object.defineProperty(window, "liteTestCommands", { value: commands });
      Object.defineProperty(window, "__TAURI_INTERNALS__", {
        value: {
          invoke: async (command: string, args?: Record<string, unknown>) => {
            commands.push(command);
            if (
              command === "read_project_trends" &&
              Object.keys(args ?? {}).length === 1 &&
              typeof args?.projectId === "string" &&
              ids.includes(args.projectId)
            ) {
              return {
                projectId: args.projectId,
                asOf: history.asOf,
                throughput: history,
                runs: [
                  {
                    slug: "stock-check",
                    phase: "plan",
                    completed: ["research"],
                    halted: null,
                    complete: false,
                  },
                ],
              };
            }
            if (command !== "read_work_map" || Object.keys(args ?? {}).length)
              throw Error("Unexpected native command or arguments");
            const answer = answers[Math.min(reads++, answers.length - 1)];
            if (typeof answer === "string") throw Error(answer);
            return answer;
          },
        },
      });
    },
    { answers: responses, history, ids: projects.map((project) => project.id) },
  );
}

const screenshots = ".tmp/screenshots/forge-lite";

test("opens the portfolio, follows project work and compares projects without issuing mutations", async ({
  page,
}, info) => {
  await installReader(page, [snapshot]);
  const errors: string[] = [];
  const apiRequests: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (
      request.method() !== "GET" ||
      /^\/(?:__agent-forge|dev-api)\b/.test(path)
    )
      apiRequests.push(`${request.method()} ${path}`);
  });
  await page.goto("/");
  const graph = page.getByRole("group", { name: "Portfolio graph" });
  await expect(
    graph.getByRole("button", { name: "You", exact: true }),
  ).toBeVisible();
  for (const project of projects)
    await expect(
      graph.getByRole("button", { name: project.name, exact: true }),
    ).toBeVisible();
  const working = graph.getByRole("button", {
    name: /^forge-12, Arrange the workstations/,
  });
  await expect(working).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Back to center" }),
  ).toBeVisible();
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  await expect
    .poll(() =>
      page.evaluate(
        () => document.documentElement.scrollWidth - window.innerWidth,
      ),
    )
    .toBeLessThanOrEqual(1);
  mkdirSync(screenshots, { recursive: true });
  await page.screenshot({
    path: join(screenshots, `${info.project.name}-work-map.png`),
    fullPage: true,
  });

  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(working.locator(".af-portfolio-forge-hammer")).toHaveCSS(
    "animation-name",
    "none",
  );
  await graph.getByRole("button", { name: "Field index, epic" }).press("Enter");
  const details = page.getByRole("complementary", { name: "Work Map details" });
  await expect(details).toContainText("Published the workshop shelf index.");
  await graph
    .getByRole("button", { name: /^atlas-2, Publish the shelf index/ })
    .press("Enter");
  await expect(
    details.getByRole("heading", {
      name: "Publish the shelf index",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    details.getByRole("button", { name: /^Open bead$/ }),
  ).toHaveCount(0);
  const views = page.getByRole("group", { name: "Work Map presentation" });
  await views.getByRole("button", { name: "Compare projects" }).click();
  await expect(
    views.getByRole("button", { name: "Compare projects" }),
  ).toHaveAttribute("aria-pressed", "true");
  const comparison = page.getByRole("region", {
    name: "Project status comparison",
  });
  const foundry = comparison.getByRole("button", { name: /Foundry tools/ });
  await expect(foundry).toContainText("3");
  await expect(
    comparison.getByRole("button", { name: /Atlas library/ }),
  ).toContainText("2");
  await foundry.press("Enter");
  await expect(
    details.getByRole("heading", { name: "Foundry tools", exact: true }),
  ).toBeVisible();
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({
    path: join(screenshots, `${info.project.name}-projects.png`),
    fullPage: true,
  });
  await views.getByRole("button", { name: "List" }).click();
  await expect(views.getByRole("button", { name: "List" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(
    page.getByRole("button", { name: "Open Default workspace" }),
  ).toHaveCount(0);
  await details.getByRole("button", { name: "View project trends" }).click();
  const trend = page.getByRole("figure", {
    name: "Recorded closures by UTC day",
  });
  const day = trend.getByRole("slider", { name: "Inspect daily closures" });
  await expect(day).toHaveAttribute(
    "aria-valuetext",
    "2026-11-26 UTC, 5 closures",
  );
  await day.press("ArrowLeft");
  await expect(day).toHaveAttribute(
    "aria-valuetext",
    "2026-11-25 UTC, 7 closures",
  );
  const phases = page.getByRole("list", { name: "Recorded run phases" });
  await expect(phases.getByRole("listitem").nth(1)).toHaveAttribute(
    "aria-current",
    "step",
  );
  await page.screenshot({
    path: join(screenshots, `${info.project.name}-trends.png`),
    fullPage: true,
  });
  await page.goBack();
  await expect(views.getByRole("button", { name: "List" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(
    details.getByRole("heading", { name: "Foundry tools", exact: true }),
  ).toBeVisible();
  const commands = await page.evaluate(
    () => Reflect.get(window, "liteTestCommands") as string[],
  );
  expect(commands.length).toBeGreaterThan(0);
  expect(new Set(commands)).toEqual(
    new Set(["read_work_map", "read_project_trends"]),
  );
  expect(apiRequests).toEqual([]);
  expect(errors).toEqual([]);
});

test("allows a failed initial native read to be retried", async ({ page }) => {
  await installReader(page, ["The tracker is offline.", snapshot]);
  await page.goto("/");
  await expect(
    page.getByRole("group", { name: "Portfolio graph" }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Refresh Work Map" }).click();
  await expect(
    page.getByRole("group", { name: "Portfolio graph" }),
  ).toBeVisible();
});
