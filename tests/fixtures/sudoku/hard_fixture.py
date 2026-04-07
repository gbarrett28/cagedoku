"""Fixture data for hard.png.

Source: Wikimedia Commons — "Sudoku puzzle hard for brute force"
URL: https://commons.wikimedia.org/wiki/File:Sudoku_puzzle_hard_for_brute_force.svg
License: CC BY-SA 4.0 (attribution: Auguel; original puzzle: Rico Alan, Flickr 2008)
Clues: 17

This puzzle is computationally difficult for ascending-order brute-force solvers;
it remains solvable by constraint propagation.
"""

GIVEN_DIGITS: list[list[int]] = [
    [0, 0, 0, 0, 0, 0, 0, 0, 0],
    [0, 0, 0, 0, 0, 3, 0, 8, 5],
    [0, 0, 1, 0, 2, 0, 0, 0, 0],
    [0, 0, 0, 5, 0, 7, 0, 0, 0],
    [0, 0, 4, 0, 0, 0, 1, 0, 0],
    [0, 9, 0, 0, 0, 0, 0, 0, 0],
    [5, 0, 0, 0, 0, 0, 0, 7, 3],
    [0, 0, 2, 0, 1, 0, 0, 0, 0],
    [0, 0, 0, 4, 0, 0, 0, 0, 9],
]

# This puzzle has multiple valid solutions (ambiguous — likely missing a clue
# in the original transcription).  No canonical SOLUTION can be set.
SOLUTION: list[list[int]] | None = None
