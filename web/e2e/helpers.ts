import { type Page } from '@playwright/test';

/**
 * Stub opencv.js with an empty script so it "loads" without starting WASM
 * compilation. Without this, DOMContentLoaded triggers loadCV() which kicks
 * off a 10 MB download + WASM init that blocks browserContext.close() for 10+
 * seconds. Structural tests do not exercise the image pipeline at all.
 */
export async function stubOpenCV(page: Page): Promise<void> {
  await page.route('**/opencv.js', route => route.fulfill({
    status: 200,
    contentType: 'application/javascript',
    body: '// opencv.js stubbed for structural tests',
  }));
}

/** Wait for the image pipeline (opencv + model) to finish loading. */
export async function waitForPipelineReady(page: Page, timeoutMs = 330_000): Promise<void> {
  const result = await page.waitForFunction(
    () => {
      const status = document.getElementById('status-msg')?.textContent ?? '';
      if (status.includes('failed') || status.includes('Error')) return `ERR:${status}`;
      const w = window as unknown as { __pipelineReady?: boolean };
      return w.__pipelineReady ? 'ok' : null;
    },
    { timeout: timeoutMs },
  );
  const msg = await result.jsonValue() as string;
  if (msg.startsWith('ERR:')) throw new Error(`Pipeline load error: ${msg.slice(4)}`);
}

/**
 * Wait until the service worker has installed, activated, and claimed this
 * page (navigator.serviceWorker.controller is non-null).
 */
export async function waitForSwController(page: Page, timeoutMs = 12_000): Promise<void> {
  await page.waitForFunction(
    () => navigator.serviceWorker?.controller !== null,
    { timeout: timeoutMs },
  );
}
