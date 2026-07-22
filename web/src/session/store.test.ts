import { describe, it, expect, beforeEach, vi } from 'vitest';
import { PuzzleState } from './types.js';
import {
  getState,
  setState,
  getStateCandidates,
  setStateCandidates,
  clearSession,
  enqueueTelemetryFailure,
  drainTelemetryFailure,
  onTelemetryFailure,
  installCvMonitors,
} from './store.js';
import type { OpenCVModule } from '../image/opencv.js';

function makeState(): PuzzleState {
  return PuzzleState.createClassic(null, [], null);
}

function makeFakeCv(heapSize = 0): OpenCVModule {
  class FakeMat { delete(): void {} }
  class FakeMatVector {
    delete(): void {}
    get(_i: number): FakeMat { return new FakeMat(); }
  }
  return {
    Mat: FakeMat,
    MatVector: FakeMatVector,
    HEAPU8: new Uint8Array(heapSize),
  } as unknown as OpenCVModule;
}

describe('store candidate list', () => {
  beforeEach(() => {
    clearSession();
  });

  it('starts with no candidates', () => {
    expect(getStateCandidates()).toEqual([]);
    expect(getState()).toBeNull();
  });

  it('setStateCandidates replaces the candidate list', () => {
    const a = makeState();
    const b = makeState();
    setStateCandidates([a, b]);
    expect(getStateCandidates()).toEqual([a, b]);
  });

  it('setState sets a singleton candidate list', () => {
    const state = makeState();
    setState(state);
    expect(getStateCandidates()).toEqual([state]);
    expect(getState()).toBe(state);
  });

  it('clearSession empties the candidate list', () => {
    setState(makeState());
    clearSession();
    expect(getStateCandidates()).toEqual([]);
    expect(getState()).toBeNull();
  });
});

describe('telemetry failure queue', () => {
  beforeEach(() => {
    drainTelemetryFailure(); // reset any leftover state between tests
    onTelemetryFailure(() => {}); // reset any leftover handler between tests
  });

  it('drainTelemetryFailure returns null when nothing is queued', () => {
    expect(drainTelemetryFailure()).toBeNull();
  });

  it('enqueueTelemetryFailure makes the message available to the next drain', () => {
    enqueueTelemetryFailure('rule-bug report dropped: no consent');
    expect(drainTelemetryFailure()).toBe('rule-bug report dropped: no consent');
  });

  it('drain clears the queue so a second drain returns null', () => {
    enqueueTelemetryFailure('first failure');
    drainTelemetryFailure();
    expect(drainTelemetryFailure()).toBeNull();
  });

  it('a later enqueue overwrites an undrained earlier one', () => {
    enqueueTelemetryFailure('first failure');
    enqueueTelemetryFailure('second failure');
    expect(drainTelemetryFailure()).toBe('second failure');
  });

  it('enqueueTelemetryFailure invokes the registered handler', () => {
    const handler = vi.fn();
    onTelemetryFailure(handler);
    enqueueTelemetryFailure('a failure');
    expect(handler).toHaveBeenCalledOnce();
  });
});

describe('installCvMonitors', () => {
  it('exposes __cvLiveMats, __cvHeapBytes, __cvAllocBytes on the window object', () => {
    const win: Record<string, unknown> = {};
    installCvMonitors(makeFakeCv(), win);
    expect(typeof win['__cvLiveMats']).toBe('function');
    expect(typeof win['__cvHeapBytes']).toBe('function');
    expect(typeof win['__cvAllocBytes']).toBe('function');
  });

  it('starts with zero live mats', () => {
    const win: Record<string, unknown> = {};
    installCvMonitors(makeFakeCv(), win);
    expect((win['__cvLiveMats'] as () => number)()).toBe(0);
  });

  it('increments count on new Mat() and decrements on delete()', () => {
    const win: Record<string, unknown> = {};
    const cv = makeFakeCv();
    installCvMonitors(cv, win);
    const live = () => (win['__cvLiveMats'] as () => number)();

    const m = new (cv.Mat as new () => { delete(): void })();
    expect(live()).toBe(1);
    m.delete();
    expect(live()).toBe(0);
  });

  it('increments count on new MatVector() and decrements on delete()', () => {
    const win: Record<string, unknown> = {};
    const cv = makeFakeCv();
    installCvMonitors(cv, win);
    const live = () => (win['__cvLiveMats'] as () => number)();

    const v = new (cv.MatVector as new () => { delete(): void })();
    expect(live()).toBe(1);
    v.delete();
    expect(live()).toBe(0);
  });

  it('counts MatVector.get() accessor mats separately', () => {
    const win: Record<string, unknown> = {};
    const cv = makeFakeCv();
    installCvMonitors(cv, win);
    const live = () => (win['__cvLiveMats'] as () => number)();

    type MV = { delete(): void; get(i: number): { delete(): void } };
    const v = new (cv.MatVector as new () => MV)();
    expect(live()).toBe(1);

    const m = v.get(0);
    expect(live()).toBe(2);

    m.delete();
    expect(live()).toBe(1);

    v.delete();
    expect(live()).toBe(0);
  });

  it('reports HEAPU8 byteLength as __cvHeapBytes', () => {
    const win: Record<string, unknown> = {};
    installCvMonitors(makeFakeCv(4096), win);
    expect((win['__cvHeapBytes'] as () => number)()).toBe(4096);
  });

  it('returns -1 for __cvAllocBytes when _mallinfo is absent', () => {
    const win: Record<string, unknown> = {};
    installCvMonitors(makeFakeCv(), win);
    expect((win['__cvAllocBytes'] as () => number)()).toBe(-1);
  });
});
