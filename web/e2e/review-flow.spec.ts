/**
 * Phase 8 critical flow, in a real browser against the real API and a clone of the corpus:
 * open a case → every AI claim opens its source in one click (each citation shows the exact
 * quoted words in the full AAO passage) → resolve or dismiss every item with a note → export
 * stays blocked (in the UI and at the server) until the attorney signs off → export → reopen
 * blocks it again.
 */
import { expect, test, type Page } from "@playwright/test";

const CASE = "P08";
const norm = (s: string | null) => (s ?? "").replace(/\s+/g, " ").trim();
const objections = (page: Page) => page.getByTestId("objection");

test("an attorney reviews every objection before the memo can be exported", async ({ page, request }) => {
  await page.goto("/");
  await expect(page.getByRole("row")).toHaveCount(17); // header + 16 cases
  await page.getByRole("link", { name: CASE, exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/cases/${CASE}$`));
  const total = 9;
  await expect(objections(page)).toHaveCount(total);
  await expect(page.getByTestId("open-count")).toHaveText(String(total));

  // the gate is enforced by the server, not only by the missing button
  expect((await request.get(`/api/cases/${CASE}/export`)).status()).toBe(409);
  await expect(page.getByRole("link", { name: /export review memo/i })).toHaveCount(0);

  // every AI claim links to its source in one click
  for (let i = 0; i < total; i++) {
    await page.waitForLoadState("load"); // links are plain hrefs: each click is a full page load
    const card = objections(page).nth(i);
    const sources = card.locator("a[data-source]");
    await expect(sources.first(), `item ${await card.getAttribute("data-item-id")} has no source link`).toBeAttached();
    const kind = (await card.getAttribute("data-item-id"))!.split(":")[0];
    for (let n = 0; n < (await sources.count()); n++) {
      const card2 = objections(page).nth(i);
      const link = card2.locator("a[data-source]").nth(n);
      if (kind === "prong") {
        const quote = norm(await card2.locator("q").nth(n).textContent());
        await link.click();
        const drawer = page.getByRole("dialog", { name: /AAO passage/i });
        await expect(drawer).toBeVisible();
        await expect(drawer.getByRole("alert")).toHaveCount(0); // quote found verbatim
        expect(norm(await drawer.locator("mark").textContent())).toBe(quote);
        await drawer.getByRole("link", { name: "Close" }).click();
        await page.waitForLoadState("load");
        await expect(drawer).toHaveCount(0);
      } else {
        const href = await link.getAttribute("href");
        await link.click();
        await expect(page).toHaveURL(new RegExp(`${href}$`));
        await expect(page.locator(href!)).toBeVisible();
      }
    }
  }

  // name the reviewer, then resolve or dismiss every item with a note
  await page.getByLabel("Reviewing as").fill("Attorney Example");
  await page.getByRole("button", { name: "Start reviewing" }).click();
  await expect(page.getByRole("button", { name: "Change" })).toBeVisible();
  for (let i = 0; i < total; i++) {
    const card = page.locator('[data-testid="objection"][data-status="open"]').first();
    await card.getByLabel("Attorney note").fill(`Checked against the exhibits (${i + 1}).`);
    await card.getByRole("button", { name: i % 3 === 2 ? "Dismiss" : "Resolve" }).click();
    await expect(page.getByTestId("open-count")).toHaveText(String(total - i - 1));
  }

  // all disposed but not signed off: still blocked
  expect((await request.get(`/api/cases/${CASE}/export`)).status()).toBe(409);
  await expect(page.getByText("attorney sign-off required")).toBeVisible();

  await page.getByLabel("Your full name").fill("Attorney Example");
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "Sign off" }).click();

  const exportLink = page.getByRole("link", { name: /export review memo/i });
  await expect(exportLink).toBeVisible();
  const [download] = await Promise.all([page.waitForEvent("download"), exportLink.click()]);
  expect(download.suggestedFilename()).toBe(`adjudicate-${CASE}-review.md`);
  const memo = await (await download.createReadStream()).toArray().then((b) => Buffer.concat(b).toString("utf8"));
  expect(memo).toContain("Signed off by Attorney Example");
  expect(memo).toContain("Checked against the exhibits (1).");
  expect(memo).not.toMatch(/\*\*Open\.\*\*/);

  // the history records every step, and a reopen voids the sign-off
  await page.reload();
  const history = page.getByRole("region", { name: "Version history" });
  await expect(history.getByRole("listitem")).toHaveCount(total + 2); // dispositions + sign-off + export
  await expect(history).toContainText("exported the memo");

  const first = objections(page).first();
  await first.getByLabel(/attorney note/i).fill("Reopened: exhibit 3 is missing a page.");
  await first.getByRole("button", { name: "Reopen" }).click();
  await expect(page.getByText("1 objection still open")).toBeVisible();
  await expect(page.getByRole("link", { name: /export review memo/i })).toHaveCount(0);
  expect((await request.get(`/api/cases/${CASE}/export`)).status()).toBe(409);

  // a second tab that loaded the same state cannot overwrite the first tab's decision
  const stale = await page.context().newPage();
  await stale.goto(`/cases/${CASE}`);
  const openHere = page.locator('[data-testid="objection"][data-status="open"]').first();
  await openHere.getByLabel("Attorney note").fill("Missing page added as exhibit 3a.");
  await openHere.getByRole("button", { name: "Resolve" }).click();
  await expect(page.getByTestId("open-count")).toHaveText("0");
  const openThere = stale.locator('[data-testid="objection"][data-status="open"]').first();
  await openThere.getByLabel("Attorney note").fill("Dismissing from the other tab.");
  await openThere.getByRole("button", { name: "Dismiss" }).click();
  // refused either by the action's reload ("already resolved") or by the API's last-event check
  await expect(stale.locator('[data-testid="objection"] [role="alert"]')).toContainText(/already resolved|changed in another tab/);
  await page.reload();
  await expect(page.getByRole("region", { name: "Version history" })).not.toContainText("Dismissing from the other tab.");
});
