"""Rules that lack hint implementations and cannot be surfaced in the coaching UI.

These rules are fully functional as solver rules — they eliminate candidates and
solve puzzles — but they have no ``compute_hints`` implementation, so they cannot
be promoted to always-apply via the config modal or surfaced as on-demand hints.

They are kept here to:
- Power the batch solver (used via ``incomplete_rules()`` alongside ``default_rules()``)
- Track future hint-implementation work

To promote a rule to the main package:
1. Implement ``compute_hints`` (inherit ``HintableRule``).
2. Add tests for the hint logic.
3. Move the file back to ``killer_sudoku/solver/engine/rules/``.
4. Add the class to ``default_rules()`` in that package's ``__init__.py``.
"""

from killer_sudoku.solver.engine.rule import SolverRule
from killer_sudoku.solver.engine.rules.incomplete.cage_intersection import (
    CageIntersection,
)
from killer_sudoku.solver.engine.rules.incomplete.hidden_pair import HiddenPair
from killer_sudoku.solver.engine.rules.incomplete.hidden_single import HiddenSingle
from killer_sudoku.solver.engine.rules.incomplete.jellyfish import Jellyfish
from killer_sudoku.solver.engine.rules.incomplete.locked_candidates import (
    LockedCandidates,
)
from killer_sudoku.solver.engine.rules.incomplete.must_contain import MustContain
from killer_sudoku.solver.engine.rules.incomplete.naked_hidden_quad import (
    NakedHiddenQuad,
)
from killer_sudoku.solver.engine.rules.incomplete.naked_hidden_triple import (
    NakedHiddenTriple,
)
from killer_sudoku.solver.engine.rules.incomplete.naked_pair import NakedPair
from killer_sudoku.solver.engine.rules.incomplete.pointing_pairs import PointingPairs
from killer_sudoku.solver.engine.rules.incomplete.simple_colouring import (
    SimpleColouring,
)
from killer_sudoku.solver.engine.rules.incomplete.swordfish import Swordfish
from killer_sudoku.solver.engine.rules.incomplete.unique_rectangle import (
    UniqueRectangle,
)
from killer_sudoku.solver.engine.rules.incomplete.unit_partition_filter import (
    UnitPartitionFilter,
)
from killer_sudoku.solver.engine.rules.incomplete.x_wing import XWing
from killer_sudoku.solver.engine.rules.incomplete.xy_wing import XYWing


def incomplete_rules() -> list[SolverRule]:
    """Return the incomplete rule set in priority order.

    These rules are used by the batch solver but are not surfaced in the
    coaching UI. Combine with ``default_rules()`` for a full solving pass.
    LinearElimination, DeltaConstraint, and SumPairConstraint have been
    promoted to default_rules() and are no longer listed here.
    """
    return [
        HiddenSingle(),
        CageIntersection(),
        MustContain(),
        NakedPair(),
        HiddenPair(),
        NakedHiddenTriple(),
        NakedHiddenQuad(),
        PointingPairs(),
        LockedCandidates(),
        UnitPartitionFilter(),
        XWing(),
        Swordfish(),
        Jellyfish(),
        XYWing(),
        UniqueRectangle(),
        SimpleColouring(),
    ]
