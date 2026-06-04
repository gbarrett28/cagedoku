/**
 * PWA install-prompt helpers.
 * Isolated so they can be unit-tested without importing main.ts.
 */

export const INSTALL_DISMISSED_KEY = 'coach_install_dismissed';

export function shouldShowInstallBanner(storage: Pick<Storage, 'getItem'>): boolean {
  return storage.getItem(INSTALL_DISMISSED_KEY) === null;
}
