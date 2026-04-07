# Classic Sudoku Test Fixtures

Test images are NOT committed to the repository (see `.gitignore`).

## Downloading images

To run integration tests that require real photographs:

1. Download three openly-licensed classic sudoku images with easy, medium, and hard
   givens density.
2. Save as `easy.png`, `medium.png`, `hard.png` in this directory.
3. Create matching Python fixture modules `easy_fixture.py`, `medium_fixture.py`,
   `hard_fixture.py`, each containing:

```python
GIVEN_DIGITS: list[list[int]] = [
    [0, 5, 0, 0, 0, 0, 0, 0, 0],
    # ... 9 rows of 9 digits; 0 = empty cell
]

SOLUTION: list[list[int]] = [
    [1, 5, 3, 4, 7, 8, 9, 6, 2],
    # ... complete 9×9 solution
]
```

## Sources

Openly-licensed puzzle images can be found in newspaper digital archives
(Guardian, Times, etc.) or puzzle sites that publish puzzles under open licences.
