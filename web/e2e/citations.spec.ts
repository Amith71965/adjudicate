/**
 * U2 in a real browser: a citation previews its passage on hover; the drawer steps between an
 * item's citations without reloading the page; "Open in decision" shows the AAO PDF on the page
 * of the quote with the words highlighted; and the way back lands on the same citation.
 */
import { expect, test } from "@playwright/test";

test("hover preview, drawer navigation without reloads, and the decision with the quote highlighted", async ({ page }) => {
  await page.goto("/cases/P01");
  const card = page.locator('[data-item-id="prong:original_contributions/original"]');
  await expect(card).toBeVisible();

  // hover: the passage in context, the quote marked
  const first = card.locator("a[data-source]").first();
  await first.hover();
  const tip = page.getByRole("tooltip");
  await expect(tip).toBeVisible();
  await expect(tip.locator("mark")).not.toBeEmpty();

  // soft navigation: a marker on window survives only if the page never reloads
  await page.evaluate(() => { (window as unknown as { __noReload: boolean }).__noReload = true; });
  await first.click();
  const drawer = page.getByRole("dialog", { name: /AAO passage/i });
  await expect(drawer).toContainText(/citation 1 of 3/i);
  await drawer.getByRole("link", { name: /next citation/i }).click();
  await expect(drawer).toContainText(/citation 2 of 3/i);
  await expect(drawer.locator("mark")).not.toBeEmpty();
  expect(await page.evaluate(() => (window as unknown as { __noReload?: boolean }).__noReload)).toBe(true);

  // the decision itself, on the page of the quote, highlighted
  await drawer.getByRole("link", { name: /open in decision/i }).click();
  await expect(page).toHaveURL(/\/decisions\/[A-Z]{3}\d{6}_\d{2}[A-Z]\d{4}\?/);
  await expect(page.getByText(/quote on page \d+ of \d+/)).toBeVisible();
  await expect(page.getByTestId("quote-status")).toHaveText("quote highlighted", { timeout: 20_000 });
  expect(await page.locator(".textLayer .adj-hit").count()).toBeGreaterThan(0);
  // the scanned page itself is drawn (JBIG2 images need the WebAssembly decoder), not just the text layer
  const inked = await page.evaluate(() => {
    const c = document.querySelector("canvas")!;
    const d = c.getContext("2d")!.getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    for (let i = 0; i < d.length; i += 4 * 61) if (d[i] < 160) n++;
    return n;
  });
  expect(inked).toBeGreaterThan(200);
  // and the header and the viewer agree on the page count
  const header = await page.getByText(/quote on page \d+ of \d+/).textContent();
  const viewer = await page.getByText(/^page \d+ of \d+$/).textContent();
  expect(header!.match(/of (\d+)/)![1]).toBe(viewer!.match(/of (\d+)/)![1]);

  // and back to the same citation
  await page.getByRole("link", { name: /back to the citation/i }).click();
  await expect(page.getByRole("dialog", { name: /AAO passage/i })).toContainText(/citation 2 of 3/i);
});
