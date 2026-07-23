import { type Page } from '@playwright/test';

/**
 * Stub opencv.js with a minimal fake `window.cv` so it "loads" without
 * starting WASM compilation. Without this, DOMContentLoaded triggers loadCV()
 * which kicks off a cold WASM compile (~30 s in headless) that blocks
 * browserContext.close(). Structural tests do not exercise the image
 * pipeline at all, but loadCV() unconditionally calls installCvMonitors() on
 * whatever cv resolves to, so the stub must still expose real Mat/MatVector
 * constructors rather than leaving window.cv undefined.
 */
export async function stubOpenCV(page: Page): Promise<void> {
  await page.route('**/opencv.js', route => route.fulfill({
    status: 200,
    contentType: 'application/javascript',
    body: `
      // opencv.js stubbed for structural tests
      function FakeMat() {}
      FakeMat.prototype.delete = function () {};
      function FakeMatVector() {}
      FakeMatVector.prototype.delete = function () {};
      FakeMatVector.prototype.get = function () { return new FakeMat(); };
      window.cv = { Mat: FakeMat, MatVector: FakeMatVector, HEAPU8: new Uint8Array(0) };
    `,
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
