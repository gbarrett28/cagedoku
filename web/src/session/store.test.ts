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
} from './store.js';

function makeState(): PuzzleState {
  return PuzzleState.createClassic(null, [], null);
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
