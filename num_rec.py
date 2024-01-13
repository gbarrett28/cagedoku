import re

from sklearn.preprocessing import Normalizer

from inp_image import *
from inp_image import number_img


class NumberRecogniserA:
	def __init__(self, allcs, n_clusters):
		self.norm = Normalizer()
		self.pca = PCA()
		self.kmeans = KMeans(n_clusters=n_clusters, n_init=16)

		allmoms = get_moments_v(allcs)
		num_var = self.pca.fit_transform(self.norm.fit_transform(allmoms))
		labels = self.kmeans.fit_predict(num_var)

		show_clusters(labels, allcs)
		self.show_scatter(labels, num_var)

	def show_scatter(self, labels, num_var):
		print(self.pca.explained_variance_ratio_)
		print(np.cumsum(self.pca.explained_variance_ratio_))

		plt.scatter([v[0] for v in num_var], [v[1] for v in num_var], c=labels)
		plt.show()

	def get_clusters(self, sums):
		allmoms = get_moments_v(sums)

		return self.kmeans.predict(self.pca.transform(self.norm.transform(allmoms)))


class NumberRecogniserB:
	def __init__(self, allcs, n_clusters):
		self.pca = PCA()
		self.kmeans = KMeans(n_clusters=n_clusters, n_init=16)

		num_var = self.pca.fit_transform([n.flatten() for n in allcs])
		labels = self.kmeans.fit_predict(num_var)

		show_clusters(labels, allcs)
		self.show_scatter(labels, num_var)

	def show_scatter(self, labels, num_var):
		print(self.pca.explained_variance_ratio_)
		print(np.cumsum(self.pca.explained_variance_ratio_))

		plt.scatter([v[0] for v in num_var], [v[1] for v in num_var], c=labels)
		plt.show()

	def get_clusters(self, sums):
		return self.kmeans.predict(self.pca.transform([s.flatten() for s in sums]))


def get_moments_v(sums):
	allmoms = []
	for ml in get_moments(sums):
		momsv = np.zeros(35, dtype=np.float64)
		momsv[:len(ml)] = np.array(ml)[:min(35, len(ml))]
		allmoms.append(momsv)
	return allmoms


def show_clusters(labels, allcs):
	clusters = dict()
	for (c, l) in zip(allcs, labels):
		if l not in clusters:
			clusters[l] = []
		clusters[l].append(c)
	print(f"Number of clusters is {len(clusters)}")

	for (i, k) in enumerate(sorted(clusters.keys())):
		for (j, c1) in enumerate(clusters[k][:10], 1):
			# numb = number_img(c1)
			numb = c1

			plt.subplot(len(clusters.keys()), 10, j + (10 * i))
			plt.imshow(numb, 'gray')
			plt.xticks([]), plt.yticks([])
	plt.show()


def get_moments(nums):
	ret = []
	for (c, _, ds) in nums:
		cv2moms = cv2.moments(c)
		moms = [v for (k, v) in cv2moms.items() if re.match(r"^nu", k)]
		for rmoms in get_moments(ds):
			moms += rmoms
		ret.append(moms)
	return ret


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

def numrec_initialiser(n_clusters: int, rework=False) -> NumberRecogniserB:
	num_rec_pkl = RAG / r"numrec.pkl"
	if not rework and num_rec_pkl.exists():
		num_rec: NumberRecogniserB = pk.load(open(num_rec_pkl, "rb"))
	else:
		allcs = []
		for f in itertools.islice(RAG.glob(r"*.jpg"), None):
			print(f"Processing {f}...")
			inp = InpImage(f)

			for X in range(9):
				for Y in range(9):
					sums = inp.info['sums'][Y, X]
					if sums is not None:
						allcs += sums

		num_rec = NumberRecogniserB(allcs, n_clusters)
		pk.dump(num_rec, open(num_rec_pkl, "wb"))

	return num_rec
