import re

import cv2
from sklearn.preprocessing import Normalizer
from inp_image import *
from inp_image import InpImage, paint_mask


class NumberRecogniser:
	def __init__(self, allcs):
		self.norm = Normalizer()
		self.pca = PCA()
		self.kmeans = KMeans(n_clusters=16, n_init=16)

		allmoms = find_moments(allcs)
		num_var = self.pca.fit_transform(self.norm.fit_transform(allmoms))
		labels = self.kmeans.fit_predict(num_var)

		show_clusters(allcs)
		self.show_scatter(labels, num_var)

	def show_scatter(self, labels, num_var):
		print(self.pca.explained_variance_ratio_)
		print(np.cumsum(self.pca.explained_variance_ratio_))

		plt.scatter([v[0] for v in num_var], [v[1] for v in num_var], c=labels)
		plt.show()

	def get_clusters(self, sums):
		allmoms = []
		for ml in find_moments(sums):
			momsv = np.zeros(35, dtype=np.float64)
			momsv[:len(ml)] = np.array(ml)
			allmoms.append(momsv)

		return self.kmeans.predict(self.pca.transform(self.norm.transform(allmoms)))


def show_clusters(labels, allcs):
	clusters = dict()
	for (c, l) in zip(allcs, labels):
		if l not in clusters:
			clusters[l] = []
		clusters[l].append(c)
	print(f"Number of clusters is {len(clusters)}")

	for (i, k) in enumerate(clusters.keys()):
		for (j, c1) in enumerate(clusters[k][:10], 1):
			number = np.zeros((InpImage.RESOLUTION, InpImage.RESOLUTION))
			paint_mask(number, [c1])

			plt.subplot(len(clusters.keys()), 10, j + (10 * i))
			(_, (x, y, w, h), _) = c1
			plt.imshow(number[y:y + h, x:x + w], 'gray')
			plt.xticks([]), plt.yticks([])
	plt.show()


def find_moments(nums):
	ret = []
	for (c, _, ds) in nums:
		cv2moms = cv2.moments(c)
		moms = [v for (k, v) in cv2moms.items() if re.match(r"^nu", k)]
		for rmoms in find_moments(ds):
			moms += rmoms
		ret.append(moms)
	return ret
