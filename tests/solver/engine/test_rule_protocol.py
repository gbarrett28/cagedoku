"""Verify as_hints() is discoverable on all default rules."""

from killer_sudoku.solver.engine.rules import default_rules


def test_all_default_rules_have_as_hints() -> None:
    for rule in default_rules():
        assert hasattr(rule, "as_hints"), f"{rule.name} missing as_hints()"
