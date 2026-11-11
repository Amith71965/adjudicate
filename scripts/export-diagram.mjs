#!/usr/bin/env node
// Export an archify HTML diagram to SVG (dual-theme) and PNG via the viewer's
// own export menu, driving the system Chrome headless. Fails loudly on any
// missing control or download — a diagram that silently didn't export is worse
// than a red build.
//
// usage: node scripts/export-diagram.mjs <diagram.html> <out-dir> <basename>
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const require = createRequire(path.resolve('web/package.json'));
const { chromium } = require('@playwright/test');

const [html, outDir, base] = process.argv.slice(2);
if (!html || !outDir || !base) {
  console.error('usage: export-diagram.mjs <diagram.html> <out-dir> <basename>');
  process.exit(2);
}
fs.mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2, acceptDownloads: true });
  await page.goto(pathToFileURL(path.resolve(html)).href);
  for (const [format, ext] of [['svg', 'svg'], ['png', 'png']]) {
    const item = page.locator(`button[data-format="${format}"]`);
    if ((await item.count()) !== 1) throw new Error(`export item ${format} not found`);
    const menuId = await item.evaluate((el) => el.closest('[role="menu"]')?.id ?? '');
    if (!menuId) throw new Error('export menu has no id');
    await page.locator(`[aria-controls="${menuId}"]`).first().click();
    const [download] = await Promise.all([page.waitForEvent('download', { timeout: 30000 }), item.click()]);
    const target = path.join(outDir, `${base}.${ext}`);
    await download.saveAs(target);
    const bytes = fs.statSync(target).size;
    if (bytes < 1024) throw new Error(`${target} suspiciously small (${bytes} B)`);
    console.log(`${target} ${bytes} B`);
  }
} finally {
  await browser.close();
}
