from num_rec import *
from grid import Grid, ProcessingError
# from constraint import Problem, ExactSumConstraint, Domain

cl_nums = list([1, 6, 8, 2, 0, 7, 9, 3, 1, 8, 8, 4, 6, 5, 1, 9])

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


allcs = []
for f in itertools.islice(RAG.glob(r"*.jpg"), None):
	print(f"Processing {f}...")
	inp = InpImage(f)
	grd = Grid()

	brdrs = np.full(shape=(9, 9, 4), fill_value=True)
	for X in range(9):
		for Y in range(9):
			if Y < 8:
				for i in range(4):
					isbh = process_sample(inp.info['brdrsh'][X, Y], inp.info['isblack'] + 16)
					brdrs[Y + 0, X][1] = isbh > 2
					brdrs[Y + 1, X][3] = isbh > 2
					isbv = process_sample(inp.info['brdrsv'][Y, X], inp.info['isblack'] + 16)
					brdrs[X, Y + 0][2] = isbv > 2
					brdrs[X, Y + 1][0] = isbv > 2
	grd.sol_img.draw_borders(brdrs)

	prd_per_sq = np.zeros(shape=(9, 9), dtype=int)
	for X in range(9):
		for Y in range(9):
			sums = inp.info['sums'][Y, X]
			if sums is not None:
				allcs += sums
				dcds = NUM_REC.get_clusters(sorted(sums, key=lambda c: c[1][0]))
				for s in dcds:
					prd_per_sq[X, Y] = (10 * prd_per_sq[X, Y]) + cl_nums[s]
				grd.sol_img.draw_sum(X, Y, prd_per_sq[X, Y])

	grd.set_up(prd_per_sq, brdrs)
	alts_sum, solns_sum = grd.solve()
	if alts_sum != 81:
		grd.cheat_solve()

	# plt.imshow(grd.sol_img.sol_img)
	# plt.show()
	# exit(0)

labels = NUM_REC.get_clusters(allcs)
show_clusters(labels, allcs)
exit(0)
clusters = dict()
for (k, v) in zip(labels, allcs):
	if k not in clusters:
		clusters[k] = []
	clusters[k].append(v)

num_clusters = len(clusters.keys())
centroids = dict()
for (k, vs) in clusters.items():
	shape = (np.max([h for (_, (_, _, w, h), _) in vs]), np.max([w for (_, (_, _, w, h), _) in vs]))
	numbs = [number_img(v, shape=shape) for v in vs]
	centroids[k] = ~np.uint8(np.mean(np.array(numbs), axis=0))
	plt.subplot(1, num_clusters, k+1)
	plt.imshow(centroids[k], 'gray')
	plt.xticks([]), plt.yticks([])
plt.show()

# # sln = SolImage()
# # sln.draw_borders(brdrs)
# # plt.imshow(sln.sol_img, 'gray')
# # plt.xticks([]), plt.yticks([])
# # plt.show()
# # exit(0)
#
# threshold = 0.85
# for f in itertools.islice(RAG.glob(r"*.jpg"), None):
# 	print(f"Processing {f}...")
# 	gry, _ = get_gry_img(f)
# 	for (k, t) in centroids.items():
# 		w, h = t.shape
# 		res = cv2.matchTemplate(gry, t, cv2.TM_CCORR_NORMED)
# 		plt.hist(res)
# 		plt.show()
# 		# loc = np.where(res >= threshold)
# 		# for pt in zip(*loc[::-1]):
# 		# 	cv2.rectangle(gry, pt, (pt[0] + w, pt[1] + h), 128, -1)
# 	plt.imshow(gry, 'gray')
# 	plt.xticks([]), plt.yticks([])
# 	plt.show()
# 	exit(0)
