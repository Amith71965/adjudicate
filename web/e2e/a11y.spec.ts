/**
 * Accessibility gate: no serious or critical axe violations on the pages an attorney uses,
 * in light and dark, with the citation drawer and the shortcuts dialog open.
 */
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

async function serious(page: Page) {
  // after a client-side navigation Next re-streams <title>; check the settled page
  await expect(page).toHaveTitle(/\S/);
  const { violations } = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
  return violations
    .filter((v) => v.impact === "serious" || v.impact === "critical")
    .map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).slice(0, 3).join(", ")}`);
}

for (const colorScheme of ["light", "dark"] as const) {
  test.describe(`${colorScheme} theme`, () => {
    test.use({ colorScheme });

    test("dashboard and case page", async ({ page, context }) => {
      await context.addCookies([{ name: "adjudicate_reviewer", value: "Attorney Example", url: "http://127.0.0.1:3100" }]);
      await page.goto("/");
      await expect(page.getByRole("row")).toHaveCount(17);
      expect(await serious(page)).toEqual([]);

      await page.goto("/cases/P08");
      await expect(page.getByTestId("objection")).toHaveCount(9);
      expect(await serious(page)).toEqual([]);

      await page.getByTestId("objection").first().getByRole("button", { name: "Resolve", exact: true }).click();
      expect(await serious(page)).toEqual([]); // the inline note form

      await page.keyboard.press("Escape");
      await page.locator("body").click({ position: { x: 5, y: 300 } });
      await page.keyboard.press("?");
      await expect(page.getByRole("dialog", { name: /keyboard shortcuts/i })).toBeVisible();
      expect(await serious(page)).toEqual([]);
    });

    test("citation drawer", async ({ page }) => {
      await page.goto("/cases/P08");
      await page.locator("a[data-source]").first().click();
      await expect(page.getByRole("dialog", { name: /AAO passage/i })).toBeVisible();
      expect(await serious(page)).toEqual([]);
    });
  });
}

test.describe("phone width", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("no page scrolls sideways at 390 px", async ({ page }) => {
    for (const path of ["/", "/cases/P08"]) {
      await page.goto(path);
      await page.waitForLoadState("networkidle");
      const width = await page.evaluate(() => document.documentElement.scrollWidth);
      expect(width, `${path} is ${width}px wide`).toBeLessThanOrEqual(390);
    }
  });
});
