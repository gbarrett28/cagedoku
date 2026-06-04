/**
 * Browser image-input helpers: clipboard paste, drag-drop extraction, and
 * File System Access API persistence for the "Use last image" feature.
 */

// Permission methods not yet present in the standard TypeScript DOM lib.
export interface FileSystemHandleWithPermission extends FileSystemFileHandle {
  queryPermission(desc: { mode: 'read' | 'readwrite' }): Promise<PermissionState>;
  requestPermission(desc: { mode: 'read' | 'readwrite' }): Promise<PermissionState>;
}

/** Extracts the first image File from a ClipboardEvent, or null if none is present. */
export function imageFileFromClipboard(e: ClipboardEvent): File | null {
  const item = Array.from(e.clipboardData?.items ?? []).find(i => i.type.startsWith('image/'));
  return item?.getAsFile() ?? null;
}

/** Extracts the first image File from a DragEvent, or null if the payload is not an image. */
export function imageFileFromDrop(e: DragEvent): File | null {
  const file = e.dataTransfer?.files[0];
  return (file?.type.startsWith('image/') ? file : null) ?? null;
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
