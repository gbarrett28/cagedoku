// @vitest-environment jsdom

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  imageFileFromClipboard, imageFileFromDrop, resolveLastHandle,
  consumeShareInbox, fileFromLaunchParams, detectUploadEnvironment,
} from './imageInput.js';
import type { FileSystemHandleWithPermission } from './imageInput.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Build a minimal ClipboardEvent mock carrying a single file of the given type. */
function makeClipboardEvent(mimeType: string | null, filename = 'img.png'): ClipboardEvent {
  const file = mimeType ? new File(['x'], filename, { type: mimeType }) : null;
  const items = file ? [{ type: mimeType!, getAsFile: () => file }] : [];
  return { clipboardData: { items }, preventDefault: vi.fn() } as unknown as ClipboardEvent;
}

/** Build a minimal DragEvent mock whose dataTransfer holds a single file. */
function makeDragEvent(mimeType: string | null, filename = 'img.jpg'): DragEvent {
  const file = mimeType ? new File(['x'], filename, { type: mimeType }) : null;
  return { dataTransfer: { files: file ? [file] : [] }, preventDefault: vi.fn() } as unknown as DragEvent;
}

/** Build a minimal FileSystemHandleWithPermission mock. */
function makeMockHandle(name: string, perm: PermissionState): FileSystemHandleWithPermission {
  return {
    kind: 'file',
    name,
    isSameEntry: vi.fn(),
    getFile: vi.fn().mockResolvedValue(new File([], name)),
    queryPermission: vi.fn().mockResolvedValue(perm),
    requestPermission: vi.fn().mockResolvedValue(perm),
  } as unknown as FileSystemHandleWithPermission;
}

afterEach(() => { vi.unstubAllGlobals(); });

// ---------------------------------------------------------------------------

describe('imageFileFromClipboard', () => {
  it('returns the image File when an image/* item is present', () => {
    const e = makeClipboardEvent('image/png', 'screenshot.png');
    const file = imageFileFromClipboard(e);
    expect(file).not.toBeNull();
    expect(file!.name).toBe('screenshot.png');
    expect(file!.type).toBe('image/png');
  });

  it('returns null when no clipboard items are present', () => {
    expect(imageFileFromClipboard(makeClipboardEvent(null))).toBeNull();
  });

  it('returns null for a non-image clipboard item', () => {
    expect(imageFileFromClipboard(makeClipboardEvent('text/plain'))).toBeNull();
  });

  it('accepts image/webp and other image subtypes', () => {
    const file = imageFileFromClipboard(makeClipboardEvent('image/webp', 'snap.webp'));
    expect(file).not.toBeNull();
    expect(file!.type).toBe('image/webp');
  });
});

// ---------------------------------------------------------------------------

describe('imageFileFromDrop', () => {
  it('returns the image File when an image is dropped', () => {
    const e = makeDragEvent('image/jpeg', 'photo.jpg');
    const file = imageFileFromDrop(e);
    expect(file).not.toBeNull();
    expect(file!.name).toBe('photo.jpg');
    expect(file!.type).toBe('image/jpeg');
  });

  it('returns null for a non-image drop', () => {
    expect(imageFileFromDrop(makeDragEvent('text/html'))).toBeNull();
  });

  it('returns null when no file is present in the drop', () => {
    expect(imageFileFromDrop(makeDragEvent(null))).toBeNull();
  });

  it('accepts image/png drops', () => {
    const file = imageFileFromDrop(makeDragEvent('image/png', 'grid.png'));
    expect(file).not.toBeNull();
    expect(file!.type).toBe('image/png');
  });
});

// ---------------------------------------------------------------------------

describe('resolveLastHandle', () => {
  it('returns the handle when the API is available and permission is granted', async () => {
    vi.stubGlobal('showOpenFilePicker', vi.fn());
    const handle = makeMockHandle('puzzle.png', 'granted');
    const result = await resolveLastHandle(() => Promise.resolve(handle));
    expect(result).toBe(handle);
  });

  it('returns null when permission is denied', async () => {
    vi.stubGlobal('showOpenFilePicker', vi.fn());
    const handle = makeMockHandle('puzzle.png', 'denied');
    expect(await resolveLastHandle(() => Promise.resolve(handle))).toBeNull();
  });

  it('returns null when permission is prompt (not yet granted)', async () => {
    vi.stubGlobal('showOpenFilePicker', vi.fn());
    const handle = makeMockHandle('puzzle.png', 'prompt');
    expect(await resolveLastHandle(() => Promise.resolve(handle))).toBeNull();
  });

  it('returns null when no handle is stored in IndexedDB', async () => {
    vi.stubGlobal('showOpenFilePicker', vi.fn());
    expect(await resolveLastHandle(() => Promise.resolve(null))).toBeNull();
  });

  it('returns null when showOpenFilePicker is unavailable (non-FSA browser)', async () => {
    // In jsdom showOpenFilePicker is not present — no stub needed.
    const handle = makeMockHandle('puzzle.png', 'granted');
    expect(await resolveLastHandle(() => Promise.resolve(handle))).toBeNull();
  });
});

// ---------------------------------------------------------------------------

describe('consumeShareInbox', () => {
  it('reconstructs a File from a stored share item', async () => {
    const buffer = new TextEncoder().encode('pixel-data').buffer;
    const read = vi.fn().mockResolvedValue({ buffer, name: 'puzzle.png', type: 'image/png' });
    const file = await consumeShareInbox(read);
    expect(file).not.toBeNull();
    expect(file!.name).toBe('puzzle.png');
    expect(file!.type).toBe('image/png');
  });

  it('returns null when the inbox is empty', async () => {
    const read = vi.fn().mockResolvedValue(null);
    expect(await consumeShareInbox(read)).toBeNull();
  });

  it('returns null when the read function rejects', async () => {
    const read = vi.fn().mockRejectedValue(new Error('IDB unavailable'));
    expect(await consumeShareInbox(read)).toBeNull();
  });
});

// ---------------------------------------------------------------------------

describe('fileFromLaunchParams', () => {
  it('returns the file from the first handle', async () => {
    const file = new File(['data'], 'puzzle.jpg', { type: 'image/jpeg' });
    const result = await fileFromLaunchParams([{ getFile: () => Promise.resolve(file) }]);
    expect(result).toBe(file);
  });

  it('returns null when the list is empty', async () => {
    expect(await fileFromLaunchParams([])).toBeNull();
  });

  it('returns null when getFile rejects', async () => {
    const result = await fileFromLaunchParams([
      { getFile: () => Promise.reject(new Error('permission denied')) },
    ]);
    expect(result).toBeNull();
  });
});


// ---------------------------------------------------------------------------

describe('detectUploadEnvironment', () => {
  function fakeWindow(standaloneMatches: boolean): Window {
    return { matchMedia: () => ({ matches: standaloneMatches }) } as unknown as Window;
  }
  function fakeNavigator(userAgent: string, standalone?: boolean): Navigator {
    return { userAgent, standalone } as unknown as Navigator;
  }

  it('returns not-installed when display-mode is not standalone and navigator.standalone is unset', () => {
    const env = detectUploadEnvironment(
      fakeWindow(false),
      fakeNavigator('Mozilla/5.0 (Windows NT 10.0; Win64; x64)'),
    );
    expect(env).toBe('not-installed');
  });

  it('returns installed-android when display-mode is standalone and the UA contains Android', () => {
    const env = detectUploadEnvironment(
      fakeWindow(true),
      fakeNavigator('Mozilla/5.0 (Linux; Android 14; Pixel 8)'),
    );
    expect(env).toBe('installed-android');
  });

  it('returns installed-other when display-mode is standalone and the UA does not contain Android', () => {
    const env = detectUploadEnvironment(
      fakeWindow(true),
      fakeNavigator('Mozilla/5.0 (Windows NT 10.0; Win64; x64)'),
    );
    expect(env).toBe('installed-other');
  });

  it('treats navigator.standalone === true as installed (legacy iOS Safari)', () => {
    const env = detectUploadEnvironment(
      fakeWindow(false),
      fakeNavigator('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)', true),
    );
    expect(env).toBe('installed-other');
  });
});
