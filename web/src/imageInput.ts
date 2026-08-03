/**
 * Browser image-input helpers: clipboard paste, drag-drop extraction, and
 * File System Access API persistence for the "Use last image" feature.
 */

// Permission methods not yet present in the standard TypeScript DOM lib.
export interface FileSystemHandleWithPermission extends FileSystemFileHandle {
  queryPermission(desc: { mode: 'read' | 'readwrite' }): Promise<PermissionState>;
  requestPermission(desc: { mode: 'read' | 'readwrite' }): Promise<PermissionState>;
}

// ---------------------------------------------------------------------------
// Supported file types
//
// Single source of truth for "does this app accept this file as a puzzle
// image": every entry point (file picker, paste, drag-drop) must agree, or
// one silently rejects files another accepts. Keep index.html's
// <input accept="..."> in sync with this list by hand — HTML attributes
// can't reference a TS constant.
// ---------------------------------------------------------------------------

/** True for a MIME type this app accepts as puzzle input (image/* or PDF). */
export function isSupportedMimeType(mimeType: string): boolean {
  return mimeType.startsWith('image/') || mimeType === 'application/pdf';
}

/** True for a File that should be routed through the PDF-decode path rather than the raw-image path. */
export function isPdfFile(file: File): boolean {
  return file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');
}

/** True for a File this app accepts as puzzle input — falls back to the
 * filename extension for PDFs, since some sources (e.g. drag-drop from
 * certain file managers) don't reliably set file.type for PDFs. */
export function isSupportedPuzzleFile(file: File): boolean {
  return isSupportedMimeType(file.type) || isPdfFile(file);
}

/** Extracts the first supported (image or PDF) File from a ClipboardEvent, or null if none is present. */
export function imageFileFromClipboard(e: ClipboardEvent): File | null {
  const item = Array.from(e.clipboardData?.items ?? []).find(i => isSupportedMimeType(i.type));
  return item?.getAsFile() ?? null;
}

/** Extracts the first supported (image or PDF) File from a DragEvent, or null if the payload isn't supported. */
export function imageFileFromDrop(e: DragEvent): File | null {
  const file = e.dataTransfer?.files[0];
  return (file && isSupportedPuzzleFile(file) ? file : null) ?? null;
}


export type UploadEnvironment = 'not-installed' | 'installed-android' | 'installed-other';

/**
 * Detects install state and platform to pick the one relevant "better way to
 * upload" tip. Takes win/nav as parameters (rather than reading window/navigator
 * globally) so it stays a pure, directly-testable function.
 */
export function detectUploadEnvironment(win: Window, nav: Navigator): UploadEnvironment {
  const installed =
    win.matchMedia('(display-mode: standalone)').matches ||
    (nav as Navigator & { standalone?: boolean }).standalone === true;
  if (!installed) return 'not-installed';
  return /Android/.test(nav.userAgent) ? 'installed-android' : 'installed-other';
}

// ---------------------------------------------------------------------------
// IndexedDB persistence for FileSystemFileHandle
// ---------------------------------------------------------------------------

function openFsaDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('coach-fsa', 1);
    req.onupgradeneeded = () => { req.result.createObjectStore('handles'); };
    req.onsuccess = () => { resolve(req.result); };
    req.onerror = () => { reject(req.error); };
  });
}

export async function loadLastHandle(): Promise<FileSystemHandleWithPermission | null> {
  try {
    const db = await openFsaDb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction('handles', 'readonly');
      const req = tx.objectStore('handles').get('last');
      req.onsuccess = () => { resolve((req.result as FileSystemHandleWithPermission | undefined) ?? null); };
      req.onerror = () => { reject(req.error); };
    });
  } catch { return null; }
}

export async function saveLastHandle(handle: FileSystemFileHandle): Promise<void> {
  try {
    const db = await openFsaDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('handles', 'readwrite');
      const req = tx.objectStore('handles').put(handle, 'last');
      req.onsuccess = () => { resolve(); };
      req.onerror = () => { reject(req.error); };
    });
  } catch { /* best-effort */ }
}

/**
 * Returns the stored FileSystemFileHandle if the File System Access API is available
 * and read permission is already granted; null otherwise.
 *
 * The `load` parameter is injectable so tests can substitute a mock source.
 */
export async function resolveLastHandle(
  load: () => Promise<FileSystemHandleWithPermission | null> = loadLastHandle,
): Promise<FileSystemHandleWithPermission | null> {
  if (!('showOpenFilePicker' in window)) return null;
  const handle = await load();
  if (!handle) return null;
  const perm = await handle.queryPermission({ mode: 'read' });
  return perm === 'granted' ? handle : null;
}

// ---------------------------------------------------------------------------
// Web Share Target inbox — written by the service worker, consumed on load
// ---------------------------------------------------------------------------

type ShareItem = { buffer: ArrayBuffer; name: string; type: string };

function openShareDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('coach-share-inbox', 1);
    req.onupgradeneeded = () => { req.result.createObjectStore('pending'); };
    req.onsuccess = () => { resolve(req.result); };
    req.onerror = () => { reject(req.error); };
  });
}

async function readAndDeleteItem(): Promise<ShareItem | null> {
  const db = await openShareDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('pending', 'readwrite');
    const store = tx.objectStore('pending');
    const getReq = store.get('item');
    getReq.onsuccess = () => {
      const val = getReq.result as ShareItem | undefined;
      if (!val) { resolve(null); return; }
      store.delete('item').onsuccess = () => { resolve(val); };
    };
    getReq.onerror = () => { reject(getReq.error); };
  });
}

/**
 * Reads and deletes the pending shared image from the share inbox.
 * Returns a reconstructed File, or null if the inbox is empty or unavailable.
 *
 * The `read` parameter is injectable so tests can bypass IndexedDB.
 */
export async function consumeShareInbox(
  read: () => Promise<ShareItem | null> = readAndDeleteItem,
): Promise<File | null> {
  try {
    const item = await read();
    if (!item) return null;
    return new File([item.buffer], item.name, { type: item.type });
  } catch { return null; }
}

// ---------------------------------------------------------------------------
// File Handling API — launched via OS "Open with"
// ---------------------------------------------------------------------------

/**
 * Returns the first File from a File Handling API launch params file list.
 * Returns null if the list is empty or the handle cannot be read.
 */
export async function fileFromLaunchParams(
  files: ReadonlyArray<{ getFile(): Promise<File> }>,
): Promise<File | null> {
  const [first] = files;
  if (!first) return null;
  try { return await first.getFile(); } catch { return null; }
}
