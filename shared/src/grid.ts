/** Row-major 9×9 grid of numbers. */
export type Grid = readonly (readonly number[])[];

/** Row-major 9×9 grid of candidate arrays (each cell is a sorted digit list). */
export type CandidateGrid = readonly (readonly (readonly number[])[])[];
