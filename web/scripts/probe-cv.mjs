/**
 * Quick probe: navigate to the app and check window.cv state every 10s for 120s.
 * Reports when/if CV loads and what properties are available.
 * Run: node scripts/probe-cv.mjs
 */
import { chromium } from 'playwright';

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();

const consoleLines = [];
page.on('console', msg => {
  const text = `[${msg.type()}] ${msg.text()}`;
  consoleLines.push(text);
  process.stdout.write(text + '\n');
});
page.on('pageerror', err => process.stdout.write(`[ERROR] ${err.message}\n`));

await page.goto('http://localhost:4173', { waitUntil: 'domcontentloaded' });
console.log('Page loaded. Polling window.cv...');

for (let i = 10; i <= 120; i += 10) {
  await page.waitForTimeout(10_000);
  const state = await page.evaluate(() => {
    const w = window;
    if (!w.cv) return 'window.cv: undefined';
    const props = Object.keys(w.cv).slice(0, 10);
    return `window.cv set; keys[0..9]: ${props.join(', ')}; matFromImageData=${typeof w.cv.matFromImageData}`;
  });
  console.log(`t=${i}s: ${state}`);
  if (state.includes('matFromImageData=function')) {
    console.log('✓ CV ready!');
    break;
  }
}

await browser.close();
