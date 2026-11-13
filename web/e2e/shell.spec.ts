/**
 * U3 shell in a real browser: ⌘K jumps straight to an objection, the breadcrumb follows you, the
 * reviewer is named in the app bar, and an unknown case is a branded 404 with a way back.
 */
import { expect, test } from "@playwright/test";

test("jump to an objection with the palette", async ({ page, context }) => {
  await context.addCookies([{ name: "adjudicate_reviewer", value: "Attorney Example", url: "http://127.0.0.1:3100" }]);
  await page.goto("/");
  await expect(page.getByRole("row")).toHaveCount(17);
  await expect(page.getByText("Reviewing as Attorney Example")).toBeAttached();
  await page.keyboard.press("ControlOrMeta+k");
  const box = page.getByRole("combobox", { name: /search cases and objections/i });
  await box.fill("marrowfield judging");
  await expect(page.getByRole("option")).toHaveCount(1);
  await box.press("Enter");
  await expect(page).toHaveURL(/\/cases\/P08#item-prong-judging-whole$/);
  await expect(page.getByRole("navigation", { name: "Breadcrumb" })).toContainText("P08");
  await expect(page.locator("#item-prong-judging-whole")).toBeVisible();
});

test("an unknown case shows the not-found page with a way back", async ({ page }) => {
  await page.goto("/cases/P99");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(/not found/i);
  // streamed under Cache Components, so the status is 200; Next marks the page noindex instead
  await expect(page.locator('meta[name="robots"][content*="noindex"]').first()).toBeAttached();
  await page.getByRole("link", { name: "Back to the review queue" }).click();
  await expect(page).toHaveURL(/\/$/);
});
