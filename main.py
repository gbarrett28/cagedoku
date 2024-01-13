from typing import List, Any

from num_rec import *
from grid import Grid, ProcessingError
# from constraint import Problem, ExactSumConstraint, Domain

NUM_REC = numrec_initialiser(16 if GNOTO else 16, REWORK)

cl_nums_g = list([1, 2, 0, 8, 4, 7, 5, 9, 1, 1, 6, 3, 2, 3, 7, 0]) # list([1, 6, 8, 2, 0, 7, 4, 1, 0, 9, 5, 4, 3, 9, 1, 7])
cl_nums_o = list([3, 1, 7, 2, 0, 4, 6, 5, 9, 8, 1, 2, 2, 1, 1, 5]) # list([1, 6, 5, 8, 4, 7, 0, 9, 2, 3, 4, 8, 9, 8, 1, 5, 1, 7, 8, 8, 0, 9, 4, 6, 9, 1, 3, 2, 2, 8, 2, 2])
cl_nums: list[int] = cl_nums_g if GNOTO else cl_nums_o

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
					isbh = inp.info['brdrsh'][X, Y]
					brdrs[Y + 0, X][1] = isbh > 2
					brdrs[Y + 1, X][3] = isbh > 2
					isbv = inp.info['brdrsv'][Y, X]
					brdrs[X, Y + 0][2] = isbv > 2
					brdrs[X, Y + 1][0] = isbv > 2
	grd.sol_img.draw_borders(brdrs)

	prd_per_sq = np.zeros(shape=(9, 9), dtype=int)
	for X in range(9):
		for Y in range(9):
			sums = inp.info['sums'][Y, X]
			if sums is not None:
				allcs += sums
				dcds = NUM_REC.get_clusters(sums)
				ntrs = [cl_nums[s] for s in dcds]
				if len(ntrs) > 4:
					print(ntrs)
					exit(0)
				for v in [v for v in ntrs if v >= 0]:
					prd_per_sq[X, Y] = (10 * prd_per_sq[X, Y]) + v
				grd.sol_img.draw_sum(X, Y, prd_per_sq[X, Y])

	try:
		grd.set_up(prd_per_sq, brdrs)

		alts_sum, solns_sum = grd.solve()
		if alts_sum != 81:
			print("... cheating")
			grd.cheat_solve()
	except ProcessingError:
		print("... failed with ProcessingError")
		plt.imshow(grd.sol_img.sol_img)
		plt.show()
		exit(0)
	except AssertionError:
		print("... failed with AssertionError")
		plt.imshow(grd.sol_img.sol_img)
		plt.show()
		exit(0)
	except ValueError:
		print("... failed with ValueError")
		plt.imshow(grd.sol_img.sol_img)
		plt.show()
		exit(0)


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
