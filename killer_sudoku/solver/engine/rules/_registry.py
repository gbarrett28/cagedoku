"""Self-registration decorator for coaching rules.

Rules that should appear in the default coaching set apply @hintable_rule at
class definition time.  Importing those modules is the registration act;
registered_rules() returns a sorted list of fresh instances.

Usage::

    from killer_sudoku.solver.engine.rules._registry import hintable_rule

    @hintable_rule
    class MyRule:
        priority = 5
        ...

Then in __init__.py::

    from killer_sudoku.solver.engine.rules._registry import registered_rules
    # (also import all rule modules so their decorators fire)

    def default_rules() -> list[SolverRule]:
        return registered_rules()
"""

from __future__ import annotations

from typing import Any

# Populated by @hintable_rule at import time — order reflects import order.
_REGISTRY: list[type[Any]] = []


def hintable_rule[C](cls: type[C]) -> type[C]:
    """Register cls in the default coaching rule set.

    Applied as a class decorator.  The class is returned unchanged; only a
    reference is appended to the module-level registry.
    """
    _REGISTRY.append(cls)
    return cls


def registered_rules() -> list[Any]:
    """Return one fresh instance of every registered rule, sorted by priority.

    Lower priority value = higher priority = fired first by the engine.
    Ties are broken by registration order (import order in __init__.py).
    """
    return sorted((_cls() for _cls in _REGISTRY), key=lambda r: r.priority)
