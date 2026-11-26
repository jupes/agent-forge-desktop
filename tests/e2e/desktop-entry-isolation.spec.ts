import { expect, test } from "@playwright/test";
import { openSettled } from "./fixtures";

test("the plain Forge dashboard opens without loading Desktop modules or styles", async ({
  page,
}) => {
  const desktopResources = new Set<string>();
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (path.includes("/apps/desktop/src/")) desktopResources.add(path);
  });

  await openSettled(page, "/index.html#/forge-run");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Forge run");
  expect(
    [...desktopResources],
    "Desktop resources requested by the plain dashboard",
  ).toEqual([]);
});
