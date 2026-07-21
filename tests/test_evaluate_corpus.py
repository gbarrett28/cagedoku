"""Unit tests for killer_sudoku.scripts.evaluate_corpus."""

import pytest

from killer_sudoku.scripts.evaluate_corpus import EvalResult, _classify


class TestClassify:
    def test_clean_when_no_error(self) -> None:
        bucket, reason = _classify(None)
        assert bucket == "clean"
        assert reason == "auto_confirmed"

    def test_not_solved_when_error(self) -> None:
        bucket, reason = _classify("unassigned region at r1c1")
        assert bucket == "notSolved"
        assert reason == "spec_error"

    def test_not_solved_when_crash_prefix(self) -> None:
        bucket, reason = _classify("crash: FileNotFoundError: [Errno 2]")
        assert bucket == "notSolved"
        assert reason == "spec_error"


class TestEvalResult:
    def test_is_frozen(self) -> None:
        r = EvalResult(
            bucket="clean",
            reason="auto_confirmed",
            spec_error=None,
            elapsed_ms=100,
            ink_density=0.05,
            total_sum=405,
            fallback_used=False,
            connectivity_score=24,
            cage_head_count=24,
            grid_corners="[[0,0],[1,0],[1,1],[0,1]]",
        )
        with pytest.raises((AttributeError, TypeError)):
            r.__setattr__("bucket", "notSolved")
