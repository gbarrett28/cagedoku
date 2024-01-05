from num_rec import *
# from grid import Grid, ProcessingError
# from constraint import Problem, ExactSumConstraint, Domain

num_rec_pkl = RAG / r"numrec.pkl"
num_rec: NumberRecogniser = pk.load(open(num_rec_pkl, "rb"))

cl_nums = [0, 4, 5, 9, 1, 1, 2, 7, 6, 7, 4, 0, 1, 8, 9, 3]

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

	for X in range(9):
		for Y in range(9):
			sums = inp.info['sums'][Y, X]
			if sums is not None:
				allcs += sums

labels = num_rec.get_clusters(allcs)
# show_clusters(labels, allcs)
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
# 	plt.subplot(1, num_clusters, k+1)
# 	plt.imshow(centroids[k], 'gray')
# 	plt.xticks([]), plt.yticks([])
# plt.show()

# sln = SolImage()
# sln.draw_borders(brdrs)
# plt.imshow(sln.sol_img, 'gray')
# plt.xticks([]), plt.yticks([])
# plt.show()
# exit(0)

threshold = 0.75
for f in itertools.islice(RAG.glob(r"*.jpg"), None):
	print(f"Processing {f}...")
	gry, _ = get_gry_img(f)
	for (k, t) in centroids.items():
		w, h = t.shape
		res = cv2.matchTemplate(gry, t, cv2.TM_CCOEFF_NORMED)
		loc = np.where(res >= threshold)
		for pt in zip(*loc[::-1]):
			cv2.rectangle(gry, pt, (pt[0] + w, pt[1] + h), 128, -1)
	plt.imshow(gry, 'gray')
	plt.xticks([]), plt.yticks([])
	plt.show()
	exit(0)
