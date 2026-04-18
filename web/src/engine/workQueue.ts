/**
 * WorkItem and SolverQueue — priority queue with deduplication and version tracking.
 *
 * Mirrors Python's `killer_sudoku.solver.engine.work_queue` module.
 *
 * WorkItem has three forms:
 *  - Unit-scoped: carries unitId and unitVersion for staleness detection.
 *  - Cell-scoped (CELL_DETERMINED, CELL_SOLVED): carries cell; never stale.
 *  - GLOBAL: no unit or cell; never stale.
 *
 * Deduplication keys (matching Python id(rule) logic):
 *  - Unit-scoped:  `${ruleIdx}:${unitId}`
 *  - Cell-scoped:  `${ruleIdx}:${cell[0]},${cell[1]}`
 *  - GLOBAL:       `${ruleIdx}`
 */

import type { SolverRule } from './rule.js';
import { Trigger } from './types.js';
import type { Cell } from './types.js';

/** A single unit of work for the solver engine main loop. */
export interface WorkItem {
  readonly priority: number;
  readonly rule: SolverRule;
  readonly ruleIdx: number;       // stable per-rule index used for dedup keys
  readonly unitId: number | null;
  readonly unitVersion: number | null;
  readonly cell: Cell | null;
  readonly trigger: Trigger;
  readonly hintDigit: number | null;
}

function dedupKey(item: WorkItem): string {
  if (item.trigger === Trigger.CELL_DETERMINED || item.trigger === Trigger.CELL_SOLVED) {
    return `${item.ruleIdx}:${item.cell![0]},${item.cell![1]}`;
  }
  if (item.trigger === Trigger.GLOBAL) {
    return `${item.ruleIdx}`;
  }
  return `${item.ruleIdx}:${item.unitId}`;
}

export function isStale(item: WorkItem, unitVersions: number[]): boolean {
  if (
    item.trigger === Trigger.CELL_DETERMINED ||
    item.trigger === Trigger.CELL_SOLVED ||
    item.trigger === Trigger.GLOBAL
  ) return false;
  if (item.unitId === null || item.unitVersion === null) return false;
  return unitVersions[item.unitId] === item.unitVersion;
}

/**
 * Min-heap priority queue with O(1) deduplication.
 *
 * When the same (rule, unitId) pair is enqueued twice, the item with the lower
 * priority wins. Superseded entries remain in the heap as ghosts and are
 * discarded on pop.
 */
export class SolverQueue {
  private _heap: WorkItem[] = [];
  /** dedup key → best priority currently live */
  private _best: Map<string, number> = new Map();

  enqueueUnit(
    priority: number,
    rule: SolverRule,
    ruleIdx: number,
    unitId: number,
    unitVersion: number,
    trigger: Trigger,
    hintDigit: number | null,
  ): void {
    const key = `${ruleIdx}:${unitId}`;
    const existing = this._best.get(key);
    if (existing !== undefined && existing <= priority) return;
    this._best.set(key, priority);
    this._push({ priority, rule, ruleIdx, unitId, unitVersion, cell: null, trigger, hintDigit });
  }

  enqueueCell(
    priority: number,
    rule: SolverRule,
    ruleIdx: number,
    cell: Cell,
    trigger: Trigger,
    hintDigit: number | null,
  ): void {
    const key = `${ruleIdx}:${cell[0]},${cell[1]}`;
    if (this._best.has(key)) return;
    this._best.set(key, priority);
    this._push({ priority, rule, ruleIdx, unitId: null, unitVersion: null, cell, trigger, hintDigit });
  }

  enqueueGlobal(priority: number, rule: SolverRule, ruleIdx: number): void {
    const key = `${ruleIdx}`;
    if (this._best.has(key)) return;
    this._best.set(key, priority);
    this._push({ priority, rule, ruleIdx, unitId: null, unitVersion: null, cell: null, trigger: Trigger.GLOBAL, hintDigit: null });
  }

  pop(): WorkItem {
    for (;;) {
      if (this._heap.length === 0) throw new Error('pop from empty SolverQueue');
      const item = this._popHeap()!;
      const key = dedupKey(item);
      if (this._best.get(key) === item.priority) {
        this._best.delete(key);
        return item;
      }
      // ghost — discard and continue
    }
  }

  empty(): boolean {
    return this._best.size === 0;
  }

  // --- Min-heap operations ---

  private _push(item: WorkItem): void {
    this._heap.push(item);
    this._siftUp(this._heap.length - 1);
  }

  private _popHeap(): WorkItem | undefined {
    const heap = this._heap;
    if (heap.length === 0) return undefined;
    const top = heap[0];
    const last = heap.pop()!;
    if (heap.length > 0) {
      heap[0] = last;
      this._siftDown(0);
    }
    return top;
  }

  private _lt(a: WorkItem, b: WorkItem): boolean {
    if (a.priority !== b.priority) return a.priority < b.priority;
    return a.rule.name < b.rule.name;
  }

  private _siftUp(i: number): void {
    const heap = this._heap;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this._lt(heap[i], heap[parent])) {
        [heap[i], heap[parent]] = [heap[parent], heap[i]];
        i = parent;
      } else break;
    }
  }

  private _siftDown(i: number): void {
    const heap = this._heap;
    const n = heap.length;
    for (;;) {
      let smallest = i;
      const l = 2 * i + 1, r = 2 * i + 2;
      if (l < n && this._lt(heap[l], heap[smallest])) smallest = l;
      if (r < n && this._lt(heap[r], heap[smallest])) smallest = r;
      if (smallest === i) break;
      [heap[i], heap[smallest]] = [heap[smallest], heap[i]];
      i = smallest;
    }
  }
}
