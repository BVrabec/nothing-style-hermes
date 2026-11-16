#!/usr/bin/env node
/**
 * shot.mjs — render mockups/*.html to PNG.
 *
 *   node tools/shot.mjs                    # every mockup, both viewports
 *   node tools/shot.mjs mockups/chat.html  # one mockup, both viewports
 *
 * Output: screenshots/<name>--desktop.png (1600x1000)
 *         screenshots/<name>--phone.png   (390x844)
 *
 * Setup (once):
 *   npm install playwright && npx playwright install chromium
 */
import { readdirSync, mkdirSync, existsSync } from 'node:fs';
import { join, basename, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

const ROOT = resolve(process.cwd());
const OUT = join(ROOT, 'screenshots');

const VIEWPORTS = [
  { suffix: 'desktop', width: 1600, height: 1000, scale: 1 },
  { suffix: 'phone', width: 390, height: 844, scale: 3 },
];

const targets = process.argv.slice(2).length
  ? process.argv.slice(2).map((p) => resolve(p))
  : readdirSync(join(ROOT, 'mockups'))
      .filter((f) => f.endsWith('.html'))
      .map((f) => join(ROOT, 'mockups', f));

if (!targets.length) {
  console.error('No mockups found in mockups/*.html');
  process.exit(1);
}

mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch();
let failures = 0;

for (const file of targets) {
  if (!existsSync(file)) {
    console.error(`missing: ${file}`);
    failures++;
    continue;
  }
  const name = basename(file, '.html');
  for (const vp of VIEWPORTS) {
    const page = await browser.newPage({
      viewport: { width: vp.width, height: vp.height },
      deviceScaleFactor: vp.scale,
      colorScheme: 'dark',
    });
    try {
      await page.goto(pathToFileURL(file).href, { waitUntil: 'networkidle' });
      await page.evaluate(() => document.fonts && document.fonts.ready);
      const out = join(OUT, `${name}--${vp.suffix}.png`);
      await page.screenshot({ path: out, fullPage: false });
      console.log(`ok  ${out}`);
    } catch (err) {
      console.error(`fail ${name} @ ${vp.suffix}: ${err.message}`);
      failures++;
    } finally {
      await page.close();
    }
  }
}

await browser.close();
process.exit(failures ? 1 : 0);
