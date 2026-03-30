"""R16 UniqueRectangle â exploit puzzle uniqueness to eliminate candidates.

A Unique Rectangle (UR) is formed by four cells at the corners of a rectangle
spanning exactly two rows and two columns, where each pair of corners lies in
the same 3Ã3 box (i.e. both rows are in the same band and both columns are in
the same stack â or they cross box boundaries, but the two-box constraint is
sufficient).

Type 1 (most common): Three corners contain only the same two candidates {a, b}.
  The fourth corner (the "floor") must not be {a, b} alone, so one of {a, b}
  can be eliminated from it â specifically any candidate that appears in all
  three "roof" cells.

Type 2: All four corners contain {a, b} plus exactly one extra candidate x in
  the same two cells. Those two cells must take x or the puzzle has multiple
  solutions, so x can be eliminated from all cells that see both of them.

Since published killer-sudoku puzzles are guaranteed to have a unique solution,
uniqueness-based eliminations are valid.

Fires on GLOBAL trigger.
"""

from __future__ import annotations

import itertools

from killer_sudoku.solver.engine.hint import HintResult
from killer_sudoku.solver.engine.rule import RuleContext
from killer_sudoku.solver.engine.types import Cell, Elimination, Trigger, UnitKind


def _sees(r1: int, c1: int, r2: int, c2: int) -> bool:
    """Return True if two cells share a row, column, or 3Ã3 box."""
    if r1 == r2 or c1 == c2:
        return True
    return (r1 // 3, c1 // 3) == (r2 // 3, c2 // 3)


class UniqueRectangle:
    """R16: Unique Rectangle types 1 and 2."""

    name = "UniqueRectangle"
    priority = 17
    triggers: frozenset[Trigger] = frozenset({Trigger.GLOBAL})
    unit_kinds: frozenset[UnitKind] = frozenset()  # GLOBAL

    def apply(self, ctx: RuleContext) -> list[Elimination]:
        """Scan for UR type-1 and type-2 patterns."""
        board = ctx.board
        elims: list[Elimination] = []

        # Candidate rows and columns for UR: need exactly two rows and two cols
        for r1, r2 in itertools.combinations(range(9), 2):
            for c1, c2 in itertools.combinations(range(9), 2):
                corners: list[Cell] = [(r1, c1), (r1, c2), (r2, c1), (r2, c2)]

                # Collect candidate sets for all four corners
                cands = [board.candidates[r][c] for r, c in corners]

                # Union of all candidates across all four cells
                all_cands: set[int] = set()
                for s in cands:
                    all_cands |= s
                # A UR needs exactly 2 "base" digits
                if len(all_cands) < 2:
                    continue

                # Check each pair of digits as the potential UR pair {a, b}
                for a, b in itertools.combinations(sorted(all_cands), 2):
                    ab = frozenset({a, b})

                    # --- Type 1: exactly three corners are {a, b} ---
                    roof_indices = [i for i, s in enumerate(cands) if s == ab]
                    if len(roof_indices) == 3:
                        floor_idx = next(i for i in range(4) if i not in roof_indices)
                        fr, fc = corners[floor_idx]
                        # Eliminate a and b from the floor cell (the UR pair must
                        # not be left as the only option there)
                        for d in (a, b):
                            if d in board.candidates[fr][fc]:
                                elims.append(Elimination(cell=(fr, fc), digit=d))

                    # --- Type 2: all four corners contain {a, b} plus one extra ---
                    # Two corners have exactly {a, b, x} for the same x;
                    # the other two corners are exactly {a, b}
                    base_indices = [i for i, s in enumerate(cands) if s == ab]
                    extra_indices = [
                        i for i, s in enumerate(cands) if ab < s and len(s) == 3
                    ]
                    if len(base_indices) == 2 and len(extra_indices) == 2:
                        extras = [cands[i] - ab for i in extra_indices]
                        if extras[0] == extras[1] and len(extras[0]) == 1:
                            x = next(iter(extras[0]))
                            ea = corners[extra_indices[0]]
                            eb = corners[extra_indices[1]]
                            ear, eac = ea
                            ebr, ebc = eb
                            # Eliminate x from cells seeing both extra corners
                            for r in range(9):
                                for c in range(9):
                                    if (r, c) in (ea, eb):
                                        continue
                                    if x in board.candidates[r][c]:
                                        if _sees(r, c, ear, eac) and _sees(
                                            r, c, ebr, ebc
                                        ):
                                            elims.append(
                                                Elimination(cell=(r, c), digit=x)
                                            )

        return list(dict.fromkeys(elims))

    def as_hints(
        self, ctx: RuleContext, eliminations: list[Elimination]
    ) -> list[HintResult]:
        """Placeholder - incomplete rule, no coaching hint yet."""
        return []
