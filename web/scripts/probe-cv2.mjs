/**
 * Deeper probe: check for WASM errors and the readyPromise state.
 */
import { chromium } from 'playwright';

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();

page.on('console', msg => process.stdout.write(`[${msg.type()}] ${msg.text()}\n`));
page.on('pageerror', err => process.stdout.write(`[PAGEERROR] ${err.message}\n`));
page.on('requestfailed', req => process.stdout.write(`[REQFAIL] ${req.url()} — ${req.failure()?.errorText}\n`));

await page.goto('http://localhost:4174', { waitUntil: 'domcontentloaded' });
console.log('Page loaded. Waiting 15s then deep-inspect...');
await page.waitForTimeout(15_000);

const state = await page.evaluate(() => {
  const w = window;
  const cv = w.cv;
  if (!cv) return 'window.cv: MISSING';
  return JSON.stringify({
    type: typeof cv,
    isPromise: cv instanceof Promise,
    keys: Object.keys(cv),
    ownKeys: Object.getOwnPropertyNames(cv).slice(0, 20),
    hasReady: typeof cv.then,
    hasMat: typeof cv.Mat,
    hasMatFromImageData: typeof cv.matFromImageData,
    hasCalledRun: 'calledRun' in cv,
    calledRun: cv.calledRun,
  });
});
console.log('Deep state:', state);

await browser.close();
