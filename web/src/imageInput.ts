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
