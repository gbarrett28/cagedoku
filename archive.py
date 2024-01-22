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
