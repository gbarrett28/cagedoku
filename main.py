from inp_image import *
from grid import Grid, ProcessingError


status_path = RAG / "status.pkl"
if status_path.exists():
	status = pk.load(open(status_path, "rb"))
else:
	status = dict()


def collect_status():
	solved = 0
	cheated = 0
	perror = 0
	aerror = 0
	total = 0
	for f in itertools.islice(RAG.glob(r"*.jpg"), None):
		print(f"Processing {f}...")
		total += 1
		inp = InpImage(f)
		grd = Grid()

		try:
			grd.set_up(inp.info['cagevals'], inp.info['brdrs'])

			alts_sum, solns_sum = grd.solve()
			if alts_sum != 81:
				print("... cheating")
				grd.cheat_solve()
				status[f] = 'CHEAT'
				cheated += 1
			else:
				status[f] = 'SOLVED'
				solved += 1
		except ProcessingError as e:
			print("... failed with ProcessingError: ", e.msg)
			status[f] = f"ProcessingError: {e.msg}"
			perror += 1
		# plt_images([inp.gry, grd.sol_img.sol_img])
		# exit(0)
		except AssertionError as e:
			print("... failed with AssertionError: ", e)
			status[f] = f"AssertionError: {e}"
			aerror += 1
		# plt_images([inp.gry, grd.sol_img.sol_img])
		# exit(0)
		except ValueError:
			print("... failed with ValueError")
			plt_images([inp.gry, grd.sol_img.sol_img])
			exit(0)
	pk.dump(status, open(status_path, "wb"))
	print(f"SOLVED          {solved:3d}")
	print(f"CHEATED         {cheated:3d}")
	print(f"ProcessingError {perror:3d}")
	print(f"AssertionError  {aerror:3d}")
	print(f"TOTAL           {total:3d}")

class MeanDiffBorder:
	def __init__(self, mean, diff):
		self.mean = mean
		self.diff = diff

	def is_border(self, brdph):
		return np.inner(brdph - self.mean, self.diff) < 0


def observer_mean_diff_borders(rework=False):
	mdb_path = RAG / r"mean_diff_border.pkl"
	if not rework and mdb_path.exists():
		mdb = pk.load(open(mdb_path, "rb"))
	else:
		brdrs_0, brdrs_1 = observer_collect_passing_borders(rework)
		mean_0 = np.mean(brdrs_0, axis=0)
		mean_1 = np.mean(brdrs_1, axis=0)
		mean = (mean_0+mean_1)/2
		diff = (mean_0-mean_1)/2
		mdb = MeanDiffBorder(mean, diff)
		pk.dump(mdb, open(mdb_path, "wb"))

		plt.subplot(1, 2, 1)
		plt.plot(range(mean_0.shape[0]), mean)
		plt.subplot(1, 2, 1)
		plt.plot(range(mean_1.shape[0]), diff)
		plt.show()

	status_pat = re.compile(r"^SOLVED")
	is_border = lambda p: mdb.is_border(p)
	aerror, cheated, perror, solved, total = test_border_fun(is_border, status_pat)
	# pk.dump(status, open(status_path, "wb"))
	print(f"SOLVED          {solved:3d}")
	print(f"CHEATED         {cheated:3d}")
	print(f"ProcessingError {perror:3d}")
	print(f"AssertionError  {aerror:3d}")
	print(f"TOTAL           {total:3d}")

class BorderPCA1D:
	def __init__(self, pca):
		self.pca = pca

	def is_border(self, brdps):
		return [v > -100 for v in self.pca.transform(brdps)]

def observer_pca_1d_borders(rework=False):
	mdb_path = RAG / r"pca_fancy_border.pkl"
	if not rework and mdb_path.exists():
		mdb = pk.load(open(mdb_path, "rb"))
	else:
		brdrs_0, brdrs_1 = observer_collect_passing_borders(rework)
		pca: PCA = PCA(n_components=1)
		pca.fit(brdrs_0+brdrs_1)

		mdb = BorderPCA1D(pca)
		pk.dump(mdb, open(mdb_path, "wb"))

	status_pat = re.compile(r"^ProcessingError")
	is_border = lambda p: mdb.is_border([p])[0]
	aerror, cheated, perror, solved, total = test_border_fun(is_border, status_pat)
	# pk.dump(status, open(status_path, "wb"))
	print(f"SOLVED          {solved:3d}")
	print(f"CHEATED         {cheated:3d}")
	print(f"ProcessingError {perror:3d}")
	print(f"AssertionError  {aerror:3d}")
	print(f"TOTAL           {total:3d}")


def test_border_fun(is_border, status_pat):
	solved = 0
	cheated = 0
	perror = 0
	aerror = 0
	total = 0
	for f in itertools.islice(RAG.glob(r"*.jpg"), None):
		if re.match(status_pat, status[f]):
			print(f"Processing {f}...")
			total += 1
			inp = InpImage(f, rework=True)
			grd = Grid()

			brdrs = np.full(shape=(9, 9, 4), fill_value=True)
			for X in range(9):
				for Y in range(8):
					isbh = is_border(inp.brdrph[X, Y])
					isbv = is_border(inp.brdrpv[Y, X])
					brdrs[Y + 0, X][1] = isbh
					brdrs[Y + 1, X][3] = isbh
					brdrs[X, Y + 0][2] = isbv
					brdrs[X, Y + 1][0] = isbv

			try:
				grd.set_up(inp.info['cagevals'], brdrs)

				alts_sum, solns_sum = grd.solve()
				if alts_sum != 81:
					print("... cheating")
					grd.cheat_solve()
					status[f] = 'CHEAT'
					cheated += 1
				else:
					status[f] = 'SOLVED'
					solved += 1
			except ProcessingError as e:
				print("... failed with ProcessingError: ", e.msg)
				status[f] = f"ProcessingError: {e.msg}"
				perror += 1
			except AssertionError as e:
				print("... failed with AssertionError: ", e)
				status[f] = f"AssertionError: {e}"
				aerror += 1
			# plt_images([inp.gry, grd.sol_img.sol_img])
			# exit(0)
			except ValueError:
				print("... failed with ValueError")
				plt_images([inp.gry, grd.sol_img.sol_img])
				exit(0)
	return aerror, cheated, perror, solved, total


def mean_diff_border(brdph, diff, mean):
	isbh = np.inner(brdph - mean, diff) < 0
	return isbh


def observer_collect_passing_borders(rework=False):
	brdrs_0 = []
	brdrs_1 = []
	for f in itertools.islice(RAG.glob(r"*.jpg"), None):
		if status[f] == r"SOLVED":
			print(f"Processing {f}...")
			inp = InpImage(f, rework=rework)
			for (p, b) in inp.info['brdrs_01']:
				if b:
					brdrs_1.append(p)
				else:
					brdrs_0.append(p)
	return brdrs_0, brdrs_1


# collect_status()
# observer_mean_diff_borders()
observer_pca_1d_borders()

# GUARDIAN
# SOLVED          458
# CHEATED           2
# ProcessingError   3
# AssertionError    2
# TOTAL           465

# OBSERVER
# SOLVED          382
# CHEATED          10
# ProcessingError  32
# AssertionError    0
# TOTAL           424
