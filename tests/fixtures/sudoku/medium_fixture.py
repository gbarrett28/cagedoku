"""Fixture data for medium.png.

Source: Wikimedia Commons — "Sudoku Puzzle (an automorphic puzzle with 18 clues)"
URL: https://commons.wikimedia.org/wiki/File:Sudoku_Puzzle_(an_automorphic_puzzle_with_18_clues).svg
License: CC BY-SA 4.0
Clues: 18 (two-way diagonal symmetry)

Note: the image uses pastel-coloured cell backgrounds to illustrate the automorphic
symmetry.  This may require the pipeline to handle non-white cell backgrounds.
"""

GIVEN_DIGITS: list[list[int]] = [
    [0, 0, 0, 0, 2, 1, 0, 0, 0],
    [0, 0, 0, 7, 3, 0, 0, 0, 0],
    [0, 0, 5, 8, 0, 0, 0, 0, 0],
    [0, 4, 3, 0, 0, 0, 0, 0, 0],
    [0, 2, 0, 0, 0, 0, 0, 0, 8],
    [0, 0, 0, 0, 0, 0, 7, 6, 0],
    [0, 0, 0, 0, 0, 2, 5, 0, 0],
    [0, 0, 0, 0, 7, 3, 0, 0, 0],
    [0, 0, 0, 9, 8, 0, 0, 0, 0],
]

# Solution not independently verified — set to None until confirmed.
SOLUTION: list[list[int]] | None = None
