import re

import numpy

from inp_image import RAG, observer_collect_passing_borders
from main import test_border_fun


class MeanDiffBorder:
	def __init__(self, mean, diff):
		self.mean = mean
		self.diff = diff

	def is_border(self, brdph):
		return np.inner(brdph - self.mean, self.diff) < 0


def observer_mean_diff_borders(rework=True, rework_all=False):
	mdb_path = RAG / r"mean_diff_border.pkl"
	if not rework and mdb_path.exists():
		mdb = pk.load(open(mdb_path, "rb"))
	else:
		brdrs_0, brdrs_1 = observer_collect_passing_borders(rework=rework_all)
		m = np.mean(brdrs_0, axis=0)
		mean_0 = m
		m1 = np.mean(brdrs_1, axis=0)
		mean_1 = m1
		mean = (mean_0+mean_1)/2
		diff = (mean_0-mean_1)/2
		mdb = MeanDiffBorder(mean, diff)
		pk.dump(mdb, open(mdb_path, "wb"))

		# plt.subplot(1, 2, 1)
		plt.plot(range(mean_0.shape[0]), mean_0)
		# plt.subplot(1, 2, 1)
		plt.plot(range(mean_1.shape[0]), mean_1)
		plt.show()

	status_pat = re.compile(r"^SOLVED")
	is_border = lambda p: mdb.is_border(p)
	aerror, cheated, perror, solved, total = test_border_fun(status_pat, is_border)
	print(f"SOLVED          {solved:3d}")
	print(f"CHEATED         {cheated:3d}")
	print(f"ProcessingError {perror:3d}")
	print(f"AssertionError  {aerror:3d}")
	print(f"TOTAL           {total:3d}")


def mean_diff_border(brdph, diff, mean):
	isbh = np.inner(brdph - mean, diff) < 0
	return isbh

def linalg(self):
		num_equns = 27 + len(self.CAGES)
		equns = np.zeros((num_equns, 82), int)

		for i in range(9):
			equn = np.zeros((9, 9), int)
			equn[i, :] = 1
			equns[3 * i + 0, :81] = equn.flatten()
			equns[3 * i + 0, 81] = 45
			equn = np.zeros((9, 9), int)
			equn[:, i] = 1
			equns[3 * i + 1, :81] = equn.flatten()
			equns[3 * i + 1, 81] = 45
			equn = np.zeros((9, 9), int)
			x = 3 * (i // 3)
			y = 3 * (i % 3)
			equn[x:x + 3, y:y + 3] = 1
			equns[3 * i + 2, :81] = equn.flatten()
			equns[3 * i + 2, 81] = 45

		for k, (c, v) in enumerate(zip(self.CAGES, self.VALS), 27):
			equn = np.zeros((9, 9), int)
			for (i, j) in c:
				equn[i, j] = 1
			equns[k, :81] = equn.flatten()
			equns[k, 81] = v

		for v in range(26, 27):
			r1 = np.argmax(equns[:, v] != 0)
			c1 = equns[r1, v]
			print(f"v={v} r1={r1}, coeff={c1}, shape={equns[r1].shape}")
			r1_mask = np.zeros(num_equns, bool)
			r1_mask[r1] = True
			vequns = equns.copy()
			for j in range(num_equns):
				if j != r1:
					vequns[j, :] = (c1 * vequns[j, :]) - (vequns[j, v] * vequns[r1, :])
					assert vequns[j, v] == 0
			for w in range(81):
				if w != v:
					r2 = np.argmax((vequns[:, w] != 0) & ~r1_mask)
					c2 = vequns[r2, w]
					# print(f"w={w} r2={r2}, coeff={c2}")
					if r2 is None:
						continue
					assert r1 != r2
					for j in range(num_equns):
						if j != r2:
							vequns[j, :] = (c2 * vequns[j, :]) - (vequns[j, w] * vequns[r2, :])
							assert vequns[j, w] == 0
					vequns[r1, :] = (c2 * vequns[r1, :]) - (vequns[r1, w] * vequns[r2, :])
					assert vequns[r1, w] == 0
			print(vequns[r1])
			if np.count_nonzero(vequns[r1, :81]) == 1:
				print(f"v={v}, val={vequns[r1, 81] // c1}")
			# for e in vequns:
			# 	print(e.shape, e)
			exit(0)

	def add_equns(self, line):
		equns = []
		cvra = set()
		sa = 0
		cvrb = set()
		sb = 0
		cvrc = set()
		sc = 0
		for s in line:
			assert cvra <= cvrc <= cvrb, (cvra, cvrc, cvrb)
			assert sa <= sc <= sb, (sa, sc, sb)
			assert cvrc.isdisjoint(s)
			cvrc |= s
			sc += 45
			for i, j in cvrc - cvra:
				idx = self.region[i][j] - 1
				if (i, j) not in cvrb:
					cvrb |= self.CAGES[idx]
					sb += self.VALS[idx]
				if (i, j) not in cvra and self.CAGES[idx] <= cvrc:
					cvra |= self.CAGES[idx]
					sa += self.VALS[idx]
			assert cvra <= cvrc <= cvrb, (cvra, cvrc, cvrb)
			assert sa <= sc <= sb, (sa, sc, sb)
			# print(f"sa={sa}, cvra={cvra}")
			# print(f"sc={sc}, cvra={cvrc}")
			# print(f"sb={sb}, cvra={cvrb}")
			for (sx, cvrx) in [(sc - sa, cvrc - cvra), (sb - sc, cvrb - cvrc)]:
				assert (sx == 0) != bool(cvrx), (sx, cvrx)
				if sx != 0:
					i, j = cvrx.copy().pop()
					if cvrx <= ROWS[i] or cvrx <= COLS[j] or \
							cvrx <= BOXS[(3 * (i // 3)) + (j // 3)] or cvrx <= self.CAGES[self.region[i][j] - 1]:
						# print(f"sx={sx}, cvrx={cvrx}")
						equns.append(Equation(cvrx, sx, self))
		# assert False

		return equns




