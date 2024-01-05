from num_rec import *
from grid import Grid, ProcessingError
from constraint import Problem, ExactSumConstraint, Domain

num_rec_pkl = RAG / r"numrec.pkl"
num_rec: NumberRecogniser = pk.load(open(num_rec_pkl, "rb"))

ONEVAR = Domain(range(10))
TWOVAR = Domain(range(10, 46))
numrec_prob = Problem()
numrec_prob.addVariables([f"v{n}" for n in range(num_rec.kmeans.n_clusters)], ONEVAR)


def cl_to_num(lo, hi, cs):
	ret = 0
	for c in cs:
		ret = (10 * ret) + c
	return lo <= ret <= hi


def plot_pca(pca, dim=32):
	print(pca.explained_variance_ratio_[0:32])
	print(np.cumsum(pca.explained_variance_ratio_[0:32]))
	# print(pca.components_[0].shape)

	for c in range(dim):
		pmin = pca.components_[c].min()
		pmax = pca.components_[c].max()
		# gry_weights = np.reshape(np.uint8((pca.components_[c] - pmin) * 255 / (pmax - pmin)), (yn, xn))
		gry_weights = np.uint8((pca.components_[c] - pmin) * 255 / (pmax - pmin))
		col_weights = cv2.applyColorMap(gry_weights, cv2.COLORMAP_JET)

		plt.subplot(4, 8, c + 1)
		plt.imshow(col_weights)
		plt.xticks([]), plt.yticks([])

	plt.show()


globs = RAG.glob(r"*.jpg")
# allmoms = []
# allcs = []
allbrdrs = set()
twovars = set()
for f in itertools.islice(globs, 2):
	print(f"Processing {f}...")
	inp = InpImage(f)
	grid = Grid()

	cszs = []
	vals = np.zeros(shape=(9, 9), dtype=object)
	brdrs = np.full((9, 9, 4), fill_value=True, dtype=bool)
	prd_per_sq = np.zeros((9, 9), dtype=int)
	numbers = np.zeros((InpImage.RESOLUTION, InpImage.RESOLUTION), dtype=np.uint8)
	for X in range(9):
		for Y in range(9):
			if Y < 8:
				for i in range(4):
					isbh = process_sample(inp.info['brdrsh'][X, Y], inp.info['isblack'] + 16)
					allbrdrs.add(isbh)
					brdrs[Y + 0, X][1] = isbh > 2
					brdrs[Y + 1, X][3] = isbh > 2
					isbv = process_sample(inp.info['brdrsv'][Y, X], inp.info['isblack'] + 16)
					allbrdrs.add(isbv)
					brdrs[X, Y + 0][2] = isbv > 2
					brdrs[X, Y + 1][0] = isbv > 2
			sums = inp.info['sums'][Y, X]
			if sums is None:
				continue
			# allcs += sums
			paint_mask(numbers, sums)
			vs = num_rec.get_clusters(sums)
			for n in vs:
				prd_per_sq[X, Y] = (17 * prd_per_sq[X, Y]) + n + 1
			if prd_per_sq[X, Y] != 0:
				grid.sol_img.draw_sum(X, Y, prd_per_sq[X, Y])
			vals[X, Y] = vs
	try:
		cszs = grid.set_up(prd_per_sq, brdrs)
	except ProcessingError as err:
		print(err.msg)
		continue

	sum405 = []
	for X in range(9):
		for Y in range(9):
			csz = cszs[X, Y]
			if csz != 0:
				vs = [f"v{n}" for n in vals[X, Y]]
				assert len(vs) in [1, 2]
				if len(vs) == 2:
					[v1, v2] = vs
					v12 = v2 + v1
					if v12 not in twovars:
						twovars.add(v12)
						numrec_prob.addVariable(v12, TWOVAR)
						print(f"Add {v12}")
						print(numrec_prob.getSolution())
						numrec_prob.addConstraint(lambda v12, v1, v2: v12 == ((10 * v2) + v1), [v12, v1, v2])
						print(f"{v12} == ((10 * {v2}) + {v1})")
						print(numrec_prob.getSolution())
					vs = [v12]
				lo = (csz * (csz + 1)) // 2
				hi = (csz * (19 - csz)) // 2
				# Need to capture the current values of lo and hi otherwise lambda is evaluated with the wrong values.
				numrec_prob.addConstraint(lambda v, l=lo, h=hi: l <= v <= h, vs)
				print(f"{lo} <= {vs[0]} <= {hi}")
				print(numrec_prob.getSolution())
				sum405 += vs
	numrec_prob.addConstraint(ExactSumConstraint(405), sum405)
	print(f"Sum 405 {sum405}")
	print(numrec_prob.getSolution())

print(numrec_prob.getSolution())
# sln = SolImage()
# sln.draw_borders(brdrs)
# plt.imshow(sln.sol_img, 'gray')
# plt.xticks([]), plt.yticks([])
# plt.show()
# exit(0)
