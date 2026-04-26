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
export function loadCV(url = './opencv.js'): Promise<Cv> {
  if (_cv !== null) return Promise.resolve(_cv);
  if (_cvLoading !== null) return _cvLoading;

  _cvLoading = new Promise<Cv>((resolve, reject) => {
    // OpenCV.js sets window.cv when loaded; we poll until it's ready.
    const script = document.createElement('script');
    script.src = url;
    script.async = true;
    script.onload = () => {
      // Modern OpenCV.js (MODULARIZE=1) sets window.cv to a Promise that resolves
      // to the module after WASM initialisation.  Older builds set it to the module
      // object directly.  Promise.resolve() handles both cases correctly.
      const w = window as unknown as { cv?: Promise<Cv> | Cv };
      Promise.resolve(w.cv as Promise<Cv>)
        .then((module: Cv) => {
          _cv = module;
          resolve(_cv);
        })
        .catch(reject);
    };
    script.onerror = () => reject(new Error(`Failed to load OpenCV.js from ${url}`));
    document.head.appendChild(script);
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
