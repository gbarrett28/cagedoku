import numpy as np
import cv2


# Calculate the top/left coordinate of a sudoku box.
def sq_coord(i):
	return ((i // 3) * SolImage.BOX_SIZE) + SolImage.THICK_BRDR + ((i % 3) * SolImage.SQ_SIZE) + SolImage.THIN_BRDR


class SolImage:
	# Size parameters for solution image.
	THIN_BRDR = 3
	DIFF_BRDR = 3
	THICK_BRDR = THIN_BRDR + DIFF_BRDR
	SQ_EDGE = 128
	SQ_SIZE = (2 * THIN_BRDR) + SQ_EDGE
	BOX_SIZE = (2 * THICK_BRDR) + (3 * SQ_SIZE)
	SOL_IMG_SIZE = 3 * BOX_SIZE

	def __init__(self):
		# Start with all black.
		self.sol_img = np.zeros((SolImage.SOL_IMG_SIZE, SolImage.SOL_IMG_SIZE, 3), np.uint8)

		# Add the sudoku squares in white.
		for bi in range(3):
			bi_c = (bi * SolImage.BOX_SIZE) + SolImage.THICK_BRDR
			for bj in range(3):
				bj_c = (bj * SolImage.BOX_SIZE) + SolImage.THICK_BRDR
				for si in range(3):
					si_c = bi_c + (si * SolImage.SQ_SIZE) + SolImage.THIN_BRDR
					for sj in range(3):
						sj_c = bj_c + (sj * SolImage.SQ_SIZE) + SolImage.THIN_BRDR
						cv2.rectangle(self.sol_img, (si_c, sj_c), (si_c + SolImage.SQ_EDGE, sj_c + SolImage.SQ_EDGE),
						              (255, 255, 255), -1)

	CAGE_BRDR = (128 + 96, 0, 0)

	# Add the cage boundaries in pink.
	def draw_borders(self, brdrs):
		for i, aux in enumerate(brdrs):
			si_c = sq_coord(i)
			si_d = si_c + SolImage.SQ_EDGE
			for j, b in enumerate(aux):
				[u, r, d, l] = b
				sj_c = sq_coord(j)
				sj_d = sj_c + SolImage.SQ_EDGE
				if u:
					cv2.rectangle(self.sol_img, (si_c, sj_c), (si_d, sj_c + 16), SolImage.CAGE_BRDR, -1)
				if r:
					cv2.rectangle(self.sol_img, (si_d - 16, sj_c), (si_d, sj_c + SolImage.SQ_EDGE), SolImage.CAGE_BRDR,
					              -1)
				if d:
					cv2.rectangle(self.sol_img, (si_d - SolImage.SQ_EDGE, sj_d - 16), (si_d, sj_d), SolImage.CAGE_BRDR,
					              -1)
				if l:
					cv2.rectangle(self.sol_img, (si_c, sj_d - SolImage.SQ_EDGE), (si_c + 16, sj_d), SolImage.CAGE_BRDR,
					              -1)

	# Add a cage total in green
	def draw_sum(self, i, j, n):
		sj_c = sq_coord(i)
		si_c = sq_coord(j)
		# Remove the cage boundary behind the total before adding the text.
		cv2.rectangle(self.sol_img, (si_c, sj_c), (si_c + 64, sj_c + 64), (255, 255, 255), -1)
		cv2.putText(self.sol_img, str(n), (si_c + 4, sj_c + 52), cv2.FONT_HERSHEY_SIMPLEX, 1.5,
		            (0, 0, 255), 5)

	# Add the solution to the square.
	def draw_number(self, n, i, j):
		sj_c = sq_coord(i) + SolImage.SQ_EDGE - 20
		si_c = sq_coord(j) + 44
		cv2.putText(self.sol_img, str(n), (si_c, sj_c), cv2.FONT_HERSHEY_SIMPLEX, 3, (0, 255, 0), 10)

	# Add dots to represent which numbers are still possible in the squares.
	def draw_dots(self, sq_poss):
		fr = 24
		for i in range(9):
			bi = sq_coord(i) + 64
			for j in range(9):
				if len(sq_poss[i][j]) > 1:
					bj = sq_coord(j) + 32
					for num in range(1, 10):
						gr = 255 if num in sq_poss[i][j] else 0
						px = bi + (fr * ((num - 1) // 3))
						py = bj + (fr * ((num - 1) % 3))
						cv2.circle(self.sol_img, (py, px), 6, (0, gr, 0), thickness=-1)
