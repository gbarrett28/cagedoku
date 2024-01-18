from inp_image import *
from grid import Grid, ProcessingError


status_path = RAG / "status.pkl"
if status_path.exists():
	status = pk.load(open(status_path, "rb"))
else:
	status = dict()


def collect_status():
	status = dict()
	solved = 0
	cheated = 0
	perror = 0
	aerror = 0
	total = 0
	for f in itertools.islice(RAG.glob(r"*.jpg"), None):
		print(f"Processing (collect_status) {f}...")
		total += 1
		inp = InpImage(f, rework=True)
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
		except AssertionError as e:
			print("... failed with AssertionError: ", e)
			status[f] = f"AssertionError: {e}"
			aerror += 1
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

class BorderPCA1D:
	def __init__(self, PP, MM, cmp):
		self.vec = PP
		self.bp = MM
		self.cmp = cmp

	def project(self, brdps):
		return [np.matmul(self.vec, b) - self.bp for b in brdps]

	def is_border(self, brdps):
		return [(b > 0) != self.cmp for b in self.project(brdps)]

def observer_pca_1d_borders(rework=True, rework_all=False):
	mdb_path = RAG / r"pca_1d_border.pkl"
	if not rework and mdb_path.exists():
		mdb = pk.load(open(mdb_path, "rb"))
	else:
		brdrs_raw_0, brdrs_raw_1 = observer_collect_passing_borders(rework_all)
		len0 = len(brdrs_raw_0)

		pca_raw = PCA()
		brdrs_0 = pca_raw.fit_transform(brdrs_raw_0)
		brdrs_1 = pca_raw.transform(brdrs_raw_1)
		cumsum = np.cumsum(pca_raw.explained_variance_ratio_)
		dims = np.argmax(cumsum > 0.99)
		print(f"dims={dims}")

		pca = PCA(n_components=2)
		brdrs = pca.fit_transform([b[dims:] for b in (list(brdrs_0)+list(brdrs_1))])

		coeffs = [b[0] for b in brdrs]
		m0 = np.mean(coeffs[:len0])
		m1 = np.mean(coeffs[len0:])
		cmp = m0 >= m1
		p = .25
		if not cmp:
			bp = ((p * np.max(coeffs[:len0])) + ((1 - p) * np.min(coeffs[len0:])))
		else:
			bp = (((1 - p) * np.min(coeffs[:len0])) + (p * np.max(coeffs[len0:])))

		# Collapse the PCA transforms to a single inner product and subtraction
		# P2*((P1*(V-M1)-M2) = P2*P1*V - (P2*P1*M1 + P2*M2)
		P1 = pca_raw.components_[dims:, :]
		M1 = pca_raw.mean_
		P2 = pca.components_[:1, :]
		M2 = pca.mean_
		PP = np.matmul(P2, P1)
		MM = np.matmul(P2, np.matmul(P1, M1)) + np.matmul(P2, M2)

		print(f"breakpoint={bp}, swapped={cmp}")
		plt.scatter([v[0] for v in brdrs], [v[1] for v in brdrs], c=['red' if i < len0 else 'green' for i in range(len(brdrs))])
		plt.show()

		mdb = BorderPCA1D(PP, MM + bp, cmp)
		pk.dump(mdb, open(mdb_path, "wb"))

	status_pat = re.compile(r"^")
	is_border = lambda p: mdb.is_border([p])[0]
	aerror, cheated, perror, solved, total = test_border_fun(status_pat, is_border)
	print(f"SOLVED          {solved:3d}")
	print(f"CHEATED         {cheated:3d}")
	print(f"ProcessingError {perror:3d}")
	print(f"AssertionError  {aerror:3d}")
	print(f"TOTAL           {total:3d}")


def test_border_fun(status_pat, is_border=None):
	solved = 0
	cheated = 0
	perror = 0
	aerror = 0
	total = 0
	for f in itertools.islice(RAG.glob(r"*.jpg"), None):
		if re.match(status_pat, status[f]):
			print(f"Processing (test_border_fun) {f}...")
			total += 1
			inp = InpImage(f, rework=True)
			grd = Grid()

			if is_border is None:
				brdrs = inp.info['brdrs']
			else:
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
				plt_images([inp.img, inp.blk, grd.sol_img.sol_img])
				# exit(0)
			except AssertionError as e:
				print("... failed with AssertionError: ", e)
				status[f] = f"AssertionError: {e}"
				aerror += 1
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
			print(f"Processing (observer_collect_passing_borders) {f}...")
			inp = InpImage(f, rework=rework)
			for (p, b) in inp.info['brdrs_01']:
				if b:
					brdrs_1.append(p)
				else:
					brdrs_0.append(p)
	print(f"Number of borders True={len(brdrs_1)}, False={len(brdrs_0)}, TOTAL={len(brdrs_1)+len(brdrs_0)}")
	return brdrs_0, brdrs_1


# collect_status()
# observer_mean_diff_borders()
observer_pca_1d_borders(rework=True)

# status_pat = re.compile(r"^ProcessingError")
# aerror, cheated, perror, solved, total = test_border_fun(status_pat)

# GUARDIAN
# SOLVED          459
# CHEATED           2
# ProcessingError   2
# AssertionError    2
# TOTAL           465

# OBSERVER
# SOLVED          410
# CHEATED          10
# ProcessingError   2
# AssertionError    2
# TOTAL           424
