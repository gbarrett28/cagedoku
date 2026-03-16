# CLAUDE.md Design — killer_sudoku

**Date:** 2026-03-16
**Status:** Approved

## Goal

Prepare `killer_sudoku` for GitHub publication with the same Claude Code conventions
used in the companion `caboodle` project. The project is a flat-script research codebase
today; the CLAUDE.md establishes the target shape it will grow into.

## Approved Decisions

### Package Structure (Approach B — shallow subpackages)

```
killer_sudoku/            # Project root
├── killer_sudoku/        # Python package root
│   ├── image/            # Grid location, border detection, number recognition
│   ├── solver/           # grid.py, equation.py
│   └── output/           # sol_image.py
├── tests/
├── guardian/             # Gitignored puzzle image data
├── observer/             # Gitignored puzzle image data
└── pyproject.toml
```

`inp_image.py` starts monolithic inside `image/` and is split as it grows.
`archive.py` and `no_gutter.py` are excluded from quality gates pending review.

### Import Rule

One form only — always use the full `killer_sudoku.` prefix:
```python
from killer_sudoku.solver.grid import Grid
from killer_sudoku.image.inp_image import InpImage
```

### Quality Gates

Full caboodle parity: ruff + mypy --strict + pytest bronze/silver gates.

### Coding Guidelines

Full caboodle parity including:
- Safety by construction (zip/enumerate, pathlib, strong types)
- No star imports, no inline imports, no module-level side effects
- Central config dataclass per module
- Tiered docstrings (LLM + human)
- FastAPI/Pydantic rules retained (web API layer may be added later)
- Serena MCP protocol mandatory

### Commit Conventions

Conventional commits with Co-Authored-By tag (same as caboodle).
