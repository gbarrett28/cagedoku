/**
 * In-memory session singleton.
 *
 * Replaces the server-side SessionStore and SettingsStore from the Python
 * coaching app. All state lives in module-level variables; there is no
 * server round-trip.
 *
 * OpenCV and the digit recogniser are loaded once at app startup and
 * cached here so every action can access them without re-loading.
 */

import type { CandidatesResponse, PuzzleState } from './types.js';
import { loadNumRecogniser } from '../image/numberRecognition.js';
import type { NumRecogniser } from '../image/numberRecognition.js';
import type { OpenCVModule } from '../image/opencv.js';
type Cv = OpenCVModule;

// ---------------------------------------------------------------------------
// Puzzle session state
// ---------------------------------------------------------------------------

let _state: PuzzleState | null = null;
let _candidatesCache: CandidatesResponse | null = null;

export function getState(): PuzzleState | null { return _state; }

export function setState(state: PuzzleState): void {
  _state = state;
  // Invalidate candidates cache whenever state changes
  _candidatesCache = null;
}

export function getCandidatesCache(): CandidatesResponse | null { return _candidatesCache; }

export function setCandidatesCache(c: CandidatesResponse): void { _candidatesCache = c; }

export function clearSession(): void {
  _state = null;
  _candidatesCache = null;
}

// ---------------------------------------------------------------------------
// OpenCV + digit recogniser singletons
// ---------------------------------------------------------------------------

let _cv: Cv | null = null;
let _rec: NumRecogniser | null = null;
let _cvLoading: Promise<Cv> | null = null;
let _recLoading: Promise<NumRecogniser> | null = null;

export function getCV(): Cv | null { return _cv; }
export function getRec(): NumRecogniser | null { return _rec; }

/**
 * Loads OpenCV.js from the given URL (or the default public path) and
 * returns a promise that resolves to the cv object. Subsequent calls
 * return the cached instance.
 */
export function loadCV(
  url = './opencv.js',
  onProgress?: (phase: 'downloading' | 'compiling', ratio: number) => void,
): Promise<Cv> {
  if (_cv !== null) return Promise.resolve(_cv);
  if (_cvLoading !== null) return _cvLoading;

  _cvLoading = new Promise<Cv>((resolve, reject) => {
    const injectBlob = (blobUrl: string) => {
      const script = document.createElement('script');
      script.src = blobUrl;
      script.async = true;
      script.onload = () => {
        URL.revokeObjectURL(blobUrl);
        const w = window as unknown as { cv?: Promise<Cv> | Cv };
        console.log('[CV] script loaded, waiting for WASM init…');
        Promise.resolve(w.cv as Promise<Cv>)
          .then((module: Cv) => { console.log('[CV] ready'); _cv = module; resolve(_cv); })
          .catch(e => { console.error('[CV] WASM init failed', e); reject(e); });
      };
      script.onerror = (e) => {
        URL.revokeObjectURL(blobUrl);
        console.error('[CV] script inject failed', e);
        reject(new Error(`Failed to inject OpenCV.js blob`));
      };
      document.head.appendChild(script);
    };

    if (!onProgress) {
      // Fast path: no progress needed — use a plain script tag.
      console.log('[CV] loading', url);
      const script = document.createElement('script');
      script.src = url;
      script.async = true;
      script.onload = () => {
        const w = window as unknown as { cv?: Promise<Cv> | Cv };
        console.log('[CV] script loaded, waiting for WASM init…');
        Promise.resolve(w.cv as Promise<Cv>)
          .then((module: Cv) => { console.log('[CV] ready'); _cv = module; resolve(_cv); })
          .catch(e => { console.error('[CV] WASM init failed', e); reject(e); });
      };
      script.onerror = (e) => { console.error('[CV] script load failed', e); reject(new Error(`Failed to load OpenCV.js from ${url}`)); };
      document.head.appendChild(script);
      return;
    }

    // Progress path: stream the fetch so we can report download progress,
    // then inject the completed bytes as a blob URL.
    console.log('[CV] fetching', url);
    fetch(url)
      .then(response => {
        if (!response.ok) throw new Error(`HTTP ${response.status} fetching ${url}`);
        if (!response.body) throw new Error(`No response body for ${url}`);
        const total = Number(response.headers.get('Content-Length') ?? '0');
        console.log('[CV] download started, Content-Length:', total || 'unknown');
        const reader = response.body.getReader();
        const chunks: ArrayBuffer[] = [];
        let received = 0;

        const pump = (): Promise<void> =>
          reader.read().then(({ done, value }) => {
            if (done) {
              console.log('[CV] download complete, injecting blob…');
              onProgress('compiling', 0);
              const blob = new Blob(chunks, { type: 'application/javascript' });
              injectBlob(URL.createObjectURL(blob));
              return;
            }
            chunks.push(value!.buffer.slice(value!.byteOffset, value!.byteOffset + value!.byteLength));
            received += value!.byteLength;
            if (total > 0) onProgress('downloading', received / total);
            return pump();
          });

        return pump();
      })
      .catch(e => { console.error('[CV] fetch failed', e); reject(e); });
  });

  return _cvLoading;
}

/**
 * Loads the digit-recogniser model from the pre-built binary + manifest files.
 * Returns a promise that resolves to the NumRecogniser. Subsequent calls
 * return the cached instance.
 */
export function loadRec(
  binUrl = './num_recogniser.bin',
  jsonUrl = './num_recogniser.json',
): Promise<NumRecogniser> {
  if (_rec !== null) return Promise.resolve(_rec);
  if (_recLoading !== null) return _recLoading;

  _recLoading = (async () => {
    const [binRes, jsonRes] = await Promise.all([fetch(binUrl), fetch(jsonUrl)]);
    if (!binRes.ok) throw new Error(`Failed to load recogniser binary: ${binRes.status}`);
    if (!jsonRes.ok) throw new Error(`Failed to load recogniser manifest: ${jsonRes.status}`);

    const [binBuffer, manifest] = await Promise.all([binRes.arrayBuffer(), jsonRes.json()]);
    _rec = loadNumRecogniser(binBuffer, manifest as Parameters<typeof loadNumRecogniser>[1]);
    return _rec;
  })();

  return _recLoading;
}
