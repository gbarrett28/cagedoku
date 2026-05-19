# Design: Ctrl-inverted keyboard digit mode

**Issue:** #65  
**Date:** 2026-05-19  
**Status:** Approved

## Problem

Keyboard users have to press the mode-toggle button to switch between placing digits and editing candidates. A Ctrl modifier should let them perform the opposite-mode action without leaving their current mode.

## Behaviour

The `keydown` handler in `web/src/main.ts` branches on `candidateEditMode`. Adding a `e.ctrlKey` check inside each branch swaps the action:

| Mode | Key | Action |
|---|---|---|
| Normal | `1–9` | `handleCellEntry(d)` — unchanged |
| Normal | `Ctrl+1–9` | `handleCandidateCycle(row, col, d)` |
| Normal | `Backspace / Delete` | `handleCellEntry(0)` — unchanged |
| Normal | `Ctrl+Backspace / Delete` | `handleCandidateCycle(row, col, 0)` |
| Candidate | `1–9` | `handleCandidateCycle(row, col, d)` — unchanged |
| Candidate | `Ctrl+1–9` | `handleCellEntry(d)` |
| Candidate | `Backspace / Delete` | `handleCandidateCycle(row, col, 0)` — unchanged |
| Candidate | `Ctrl+Backspace / Delete` | `handleCellEntry(0)` |

`e.preventDefault()` is called on every Ctrl path to suppress browser defaults.

## Tutorial callout update

The digit-pad callout in `renderPlayingMode` (`web/src/main.ts`, `id: 'digit-1'`) is updated from:

> "Use these buttons to enter digits. In Candidate mode, they toggle pencil marks instead."

to:

> "Use these buttons to enter digits. In Candidate mode, they toggle pencil marks instead. On a keyboard, Ctrl+digit works in the opposite mode."

## Scope

- **File modified:** `web/src/main.ts` only — keydown handler (~8 lines) and one callout string.
- **No new files, no new modules.**
- Pre-confirm classic digit editing is unaffected (it returns before reaching the mode-branching block).

## Testing

- Unit test: extract a pure `resolveDigitKey(candidateEditMode, ctrlKey, key)` helper that returns `{ action, digit }` and test all 8 combinations.
- Manual: in normal mode, Ctrl+3 on a selected cell should toggle candidate 3 without switching mode; in candidate mode, Ctrl+3 should place digit 3.
