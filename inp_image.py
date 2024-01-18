import argparse
import math
import pathlib
import pickle as pk
import itertools
import re

import cv2
import numpy as np
from matplotlib import pyplot as plt
# from matplotlib.widgets import Button, Slider
from sklearn import linear_model
from sklearn.cluster import KMeans
from sklearn.decomposition import PCA
from scipy.signal import find_peaks

parser = argparse.ArgumentParser()
parser.add_argument('--rag', choices=["observer", "guardian"], required=True)
parser.add_argument('--rework', default=False, action='store_true')
args = parser.parse_args()
RAG = pathlib.Path(args.rag)
REWORK = args.rework

GNOTO = str(RAG) == r"guardian"
ONOTG = str(RAG) == r"observer"


def intersect(l1, l2):
	# Represent the intersection as the solution to two linear equations.
	rh1, sth1, cth1 = l1
	rh2, sth2, cth2 = l2
	M = [[sth1, cth1],
	     [sth2, cth2]]

	# If the matrix has no inverse then the lines are parallel.
	try:
		Minv = np.linalg.inv(M)
	except np.linalg.LinAlgError:
		return False, None, None
	[Y, X] = np.matmul(Minv, [rh1, rh2])
	return True, Y, X


def draw_hough(img, lines):
	yn, xn, _ = img.shape
	# print(f"H={len(lines)}")
	# print(img.shape)
	for l in lines:
		# print(f"l={l}")
		pts = []
		ints = []
		for ax in [(0, 0, 1), (0, 1, 0), (xn - 1, 0, 1), (yn - 1, 1, 0)]:
			b, y, x = intersect(l, ax)
			ints.append((b, y, x))
			if b and 0 <= x < xn and 0 <= y < yn:
				pts.append((int(round(x)), int(round(y))))
		# print(f"len(pts)={len(pts)}")
		if len(pts) == 2:
			[pt1, pt2] = pts
			cv2.line(img, pt1, pt2, (0, 0, 255), 1, cv2.LINE_AA)


def process_sample(s):
	if GNOTO:
		peaks, _ = find_peaks(~s, height=32)
		return len(peaks)
	sl = s[1:]
	sr = s[:-1]
	se = sl & ~sr
	return np.count_nonzero(se)


def contour_hier(chs, seen, i=0):
	if not chs:
		return []

	ret = []
	while i != -1:
		(c, (n, _, d, _)) = chs[i]
		if i not in seen:
			ret.append((c, cv2.boundingRect(c), contour_hier(chs, seen, d)))
		seen.add(i)
		i = n

	return ret


def contour_is_number(br):
	x, y, w, h = br
	XX = (2 * x) // InpImage.SUBRES
	YY = (2 * y) // InpImage.SUBRES
	return XX % 2 == 0 and YY % 2 == 0 and \
		InpImage.SUBRES // 16 <= w < InpImage.SUBRES // 2 and \
		InpImage.SUBRES // 8 <= h < InpImage.SUBRES // 2


def get_num_contours(chier):
	ret = []

	for (c, br, ds) in chier:
		if contour_is_number(br):
			ret.append((c, br, ds))
		else:
			ret += get_num_contours(ds)

	return ret


def paint_mask(msk, ch, fill=255):
	for (c, _, ds) in ch:
		cv2.drawContours(image=msk, contours=[c], contourIdx=0, color=fill, thickness=-1)
		paint_mask(msk, ds, fill=(255 - fill))


def split_num(br, warped_blk):
	x, y, w, h = br
	ys = np.argmax(warped_blk[y:y + h, x:x + w], axis=0)
	peaks, _ = find_peaks(ys, height=4)
	peaks = [p for p in peaks if contour_is_number((x, y, p, h)) and contour_is_number((x, y, w - p, h))]

	rects = []
	if len(peaks) == 0:
		if w >= h:
			plt_images([warped_blk[y:y + h, x:x + w]])
			exit(0)
		rects.append((y, y + h, x, x + w))
	else:
		sp = peaks[-1]
		if sp >= h or (w - sp) >= h:
			print(peaks)
			plt_images([warped_blk[y:y + h, x:x + w], warped_blk[y:y + h, x:x + sp], warped_blk[y:y + h, x + sp:x + w]],
			           ticks=True)
			exit(0)
		rects.append((y, y + h, x, x + sp))
		rects.append((y, y + h, x + sp, x + w))

	ret = []
	for (yt, yb, xl, xr) in rects:
		ret.append(get_warp_from_rect(np.array([[xl, yt], [xr, yt], [xr, yb], [xl, yb]], dtype=np.float32), warped_blk))

	return ret, x, y


class InpImage:
	do_print = False
	RHO = 2
	THETA = math.pi / 16
	HTHRESH = 1792

	# Size of the regions used for detecting borders.
	SUBRES = 128
	RESOLUTION = 9 * SUBRES
	DST_SIZE = np.array([
		[0, 0],
		[RESOLUTION - 1, 0],
		[RESOLUTION - 1, RESOLUTION - 1],
		[0, RESOLUTION - 1]], dtype="float32")

	def __init__(self, f, rework=REWORK, rework_brdr=False):
		self.info = dict()

		gry, img = get_gry_img(f)
		self.gry = gry
		self.img = img

		jpk = f.with_suffix(r".jpk")
		if not rework and jpk.exists():
			self.info = pk.load(open(jpk, "rb"))
		else:
			# blur = cv2.GaussianBlur(gry, (5, 5), 0)
			# gry = cv2.addWeighted(gry, 1.5, blur, -0.5, 0)
			blk_detect = np.reshape(np.ravel(gry), (-1, 1))
			counts, bins = np.histogram(blk_detect, bins=range(0, 257, 16))
			self.info['hist'] = counts
			# print(counts, bins)

			# print(f"GNOTO={GNOTO}, RAG={RAG}")
			if GNOTO or True:
				cm = np.sum(counts)
				isblack = 256
				for (c, b) in reversed(list(zip(counts, bins))):
					if c < cm:
						# print(f"c={c}, cm={cm}, b={b}")
						cm = c
						isblack = int(b)
					else:
						break
				isblack -= 56
			else:
				kmeans = KMeans(n_clusters=3, n_init='auto')
				kmeans.fit(blk_detect)
				labs = kmeans.predict(np.reshape(range(256), (-1, 1)))
				isblack = list(labs).count(labs[0])
			self.info['isblack'] = isblack

			blk = cv2.inRange(gry, 0, isblack)
			self.blk = blk

			lines_rt = cv2.HoughLines(blk, InpImage.RHO, InpImage.THETA, InpImage.HTHRESH)
			if lines_rt is None:
				print(f"Lines not found for {f}")
				show_stuff(bins, blk, counts, img, isblack, [], [])
				return

			lines = [(r, math.sin(t), math.cos(t)) for [[r, t]] in lines_rt]
			draw_hough(img, lines)
			isects = []
			for (i, li) in enumerate(lines):
				for (j, lj) in enumerate(lines[:i]):
					b, y, x = intersect(li, lj)
					if b:
						isects.append((y, x))
			usects = sorted(set(isects))

			raw_nums = []
			if len(usects) < 4:
				print(f"Intersections not found for {f}")
				show_stuff(bins, blk, counts, img, isblack, [], [])
				return
			else:
				y0 = min([y for y, _ in usects])
				x0 = min([x for _, x in usects])
				yn = 1 + max([y for y, _ in usects]) - y0
				xn = 1 + max([x for _, x in usects]) - x0
				reg_X = []
				reg_y = []
				for p in usects:
					y, x = p
					m = round((9 * (x - x0)) / xn)
					n = round((9 * (y - y0)) / yn)
					if m % 3 == 0 and n % 3 == 0:
						reg_X.append((n, m))
						reg_y.append(p)
				# cv2.circle(gry, (round(x), round(y)), 1, (0, 0, 255), -1)
				regr = linear_model.LinearRegression()
				regr.fit(reg_X, reg_y)
				rect = np.zeros((4, 2), dtype="float32")
				rect[3] = list(reversed(regr.intercept_ + 9 * regr.coef_[0]))
				rect[2] = list(reversed(regr.intercept_ + 9 * regr.coef_[0] + 9 * regr.coef_[1]))
				rect[1] = list(reversed(regr.intercept_ + 9 * regr.coef_[1]))
				rect[0] = list(reversed(regr.intercept_))

				m = cv2.getPerspectiveTransform(rect, InpImage.DST_SIZE)
				warped_gry = cv2.warpPerspective(gry, m, (InpImage.RESOLUTION, InpImage.RESOLUTION),
				                                 flags=cv2.INTER_LINEAR)

				brd_view = cv2.adaptiveThreshold(warped_gry, 255, cv2.ADAPTIVE_THRESH_MEAN_C,
				                                 cv2.THRESH_BINARY, 31, 0)
				brdrs = np.full(shape=(9, 9, 4), fill_value=True)

				brdrsh = np.zeros((9, 8), int)
				brdrsv = np.zeros((8, 9), int)
				self.brdrph = np.zeros((9, 8, InpImage.SUBRES // 2), np.uint8)
				self.brdrpv = np.zeros((8, 9, InpImage.SUBRES // 2), np.uint8)
				brdrs_01 = []
				for X in range(9):
					XM = (((2 * X + 1) * InpImage.SUBRES) // 2)
					XT = XM + (InpImage.SUBRES // 4) - (InpImage.SUBRES // 16)
					XB = XM + (InpImage.SUBRES // 16)
					for Y in range(1, 9):
						# Take a square centred on the boundary that is a quarter the area of a cell
						YL = (Y * InpImage.SUBRES) - (InpImage.SUBRES // 4)
						YR = (Y * InpImage.SUBRES) + (InpImage.SUBRES // 4)
						if ONOTG:
							self.brdrph[X, Y - 1] = np.min(warped_gry[XB:XT, YL:YR], axis=0)
							self.brdrpv[Y - 1, X] = np.min(warped_gry[YL:YR, XB:XT], axis=1)
						else:
							brdrsh[X, Y - 1] = process_sample(np.min(brd_view[XB:XT, YL:YR], axis=0)) > 2
							brdrsv[Y - 1, X] = process_sample(np.min(brd_view[YL:YR, XB:XT], axis=1)) > 2

				if rework_brdr:
					self.info['brdrph'] = self.brdrph
					self.info['brdrpv'] = self.brdrpv
				else:
					for X in range(9):
						for Y in range(8):
							if ONOTG:
								[isbh, isbv] = OBRDR.tr_brdrs([self.brdrph[X, Y], self.brdrpv[Y, X]])
								brdrs_01.append((self.brdrph[X, Y], isbh))
								brdrs_01.append((self.brdrpv[Y, X], isbv))
							else:
								isbh = brdrsh[X, Y]
								isbv = brdrsv[Y, X]
							brdrs[Y + 0, X][1] = isbh
							brdrs[Y + 1, X][3] = isbh
							brdrs[X, Y + 0][2] = isbv
							brdrs[X, Y + 1][0] = isbv
					self.info['brdrs'] = brdrs.copy()
					self.info['brdrs_01'] = brdrs_01.copy()

				num_pixels = np.empty((9, 9), dtype=object)
				warped_blk = cv2.warpPerspective(blk, m, (InpImage.RESOLUTION, InpImage.RESOLUTION),
				                                 flags=cv2.INTER_LINEAR)

				contours, hiers = cv2.findContours(warped_blk, cv2.RETR_TREE, cv2.CHAIN_APPROX_SIMPLE)
				if hiers is not None:
					[hier] = hiers
					chiers = contour_hier(list(zip(contours, hier)), set())
					raw_nums = get_num_contours(chiers)
					InpImage.do_print = len(raw_nums) <= 9
					for (c, br, ds) in sorted(raw_nums, key=lambda n: n[1][0]):
						num_chiers, x, y = split_num(br, warped_blk)
						X = x // InpImage.SUBRES
						Y = y // InpImage.SUBRES
						if num_pixels[X, Y] is None:
							num_pixels[X, Y] = list()
						num_pixels[X, Y] += num_chiers

				if rework_brdr:
					self.info['sums'] = num_pixels
				else:
					prd_per_sq = np.zeros(shape=(9, 9), dtype=int)
					for X in range(9):
						for Y in range(9):
							sums = num_pixels[Y, X]
							if sums is not None:
								ntrs = NUM_REC.get_sums(sums)
								if len(ntrs) > 4:
									print(ntrs)
									exit(0)
								for v in [v for v in ntrs if v >= 0]:
									prd_per_sq[X, Y] = (10 * prd_per_sq[X, Y]) + v
					self.info['cagevals'] = prd_per_sq

			if rework_brdr:
				if jpk.exists():
					jpk.unlink()
			else:
				pk.dump(self.info, open(jpk, "wb"))


def show_stuff(bins, blk, counts, img, isblack, rect, num_chiers):
	if InpImage.do_print:
		for pt in rect:
			cv2.circle(img, tuple([int(round(i)) for i in pt]), 5, (0, 255, 0), -1)
		plt.subplot(1, 3, 1)
		plt.imshow(img)
		plt.xticks([]), plt.yticks([])
		plt.subplot(1, 3, 2)
		plt.imshow(blk, 'gray')
		plt.xticks([]), plt.yticks([])
		plt.subplot(1, 3, 3)
		plt.title(f"{isblack}")
		plt.stairs(counts, bins)
		# plt.xticks([]), plt.yticks([])
		plt.show()
		numbers = np.zeros(blk.shape, np.uint8)
		paint_mask(numbers, num_chiers)
		plt.imshow(numbers, 'gray')
		plt.show()
	# exit(0)


def get_gry_img(f):
	# Read the image file.
	imga = cv2.imread(str(f))
	# Sometimes we have a low resolution image in a big white square so don't do this before grid
	# recognition.
	# Scale up until input image is the same order as the cage detection requires.
	while imga.shape[0] < InpImage.RESOLUTION or imga.shape[1] < InpImage.RESOLUTION:
		imga = cv2.pyrUp(imga)
	# Add a bounding black box to help with the grid detection.
	img = cv2.bitwise_not(np.zeros((imga.shape[0] + 6, imga.shape[1] + 6, 3), np.uint8))
	img[3:3 + imga.shape[0], 3:imga.shape[1] + 3] = imga
	# Find grey distribution and eliminate to get the black bits.
	gry = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
	return gry, img


def number_img(c, shape=None):
	number = np.zeros((InpImage.RESOLUTION, InpImage.RESOLUTION))
	paint_mask(number, [c])

	(_, (x, y, w, h), _) = c
	if shape is not None:
		ret = np.zeros(shape)
		ret[:h, :w] = number[y:y + h, x:x + w]
	else:
		ret = number[y:y + h, x:x + w]
	return ret


def get_warp_from_rect(rect, gry, res=(InpImage.SUBRES // 2, InpImage.SUBRES // 2)):
	resy, resx = res
	dst = np.array([
		[0, 0],
		[resy - 1, 0],
		[resy - 1, resx - 1],
		[0, resx - 1]], dtype="float32")
	m = cv2.getPerspectiveTransform(rect, dst)
	return cv2.warpPerspective(gry, m, res, flags=cv2.INTER_LINEAR)


def plt_images(imgs, ticks=False):
	for (i, img) in enumerate(imgs, 1):
		plt.subplot(1, len(imgs), i)
		plt.imshow(img, 'gray')
		if not ticks:
			plt.xticks([]), plt.yticks([])
	plt.show()


class BorderDecode:
	def __init__(self, pca, kmeans, isbrdr):
		self.pca: PCA = pca
		self.kmeans: KMeans = kmeans
		self.isbrdr = isbrdr

	def tr_brdrs(self, brdrs):
		cls = self.kmeans.predict(self.pca.transform(brdrs))
		return [self.isbrdr[c] for c in cls]


def observer_border_gen(rework=REWORK):
	brdr_path = RAG / r"brdr.pkl"
	if not rework and brdr_path.exists():
		brdr: BorderDecode = pk.load(open(brdr_path, "rb"))
	else:
		samples = []
		hasnums = []
		globs = RAG.glob(r"*.jpg")
		for f in itertools.islice(globs, None):
			print(f"Processing (observer_border_gen) {f}...")
			inp = InpImage(f, rework=rework, rework_brdr=True)
			for X in range(9):
				for Y in range(9):
					cbd = inp.info['sums'][X, Y] is not None
					if X > 0:
						hasnums.append(cbd)
						samples.append(inp.info['brdrph'][Y, X - 1])
					if Y > 0:
						hasnums.append(cbd)
						samples.append(inp.info['brdrpv'][Y - 1, X])

		pca: PCA = PCA()
		brdrs = pca.fit_transform(samples)

		kmeans: KMeans = KMeans(n_clusters=4, n_init=16)
		labels = kmeans.fit_predict(brdrs)
		clusters = np.unique(labels)
		cl_brdr = dict([(c, 0) for c in clusters])
		cl_size = dict([(c, 0) for c in clusters])
		for (c, b) in zip(labels, hasnums):
			cl_size[c] += 1
			if b:
				cl_brdr[c] += 1
		# print(cl_brdr)
		# print(cl_size)
		cl_is_brdr = dict()
		for c in clusters:
			cl_is_brdr[c] = cl_size[c] < 10 * cl_brdr[c]
		# print(cl_is_brdr)

		brdr = BorderDecode(pca, kmeans, cl_is_brdr)
		pk.dump(brdr, open(brdr_path, "wb"))

	return brdr


OBRDR = observer_border_gen(rework=REWORK) if ONOTG else None


class NumberRecogniser:
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

	def get_sums(self, sums):
		cls = self.get_clusters(sums)
		return [cl_nums[c] for c in cls]


# def get_moments_v(sums):
# 	allmoms = []
# 	for ml in get_moments(sums):
# 		momsv = np.zeros(35, dtype=np.float64)
# 		momsv[:len(ml)] = np.array(ml)[:min(35, len(ml))]
# 		allmoms.append(momsv)
# 	return allmoms


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


# def get_moments(nums):
# 	ret = []
# 	for (c, _, ds) in nums:
# 		cv2moms = cv2.moments(c)
# 		moms = [v for (k, v) in cv2moms.items() if re.match(r"^nu", k)]
# 		for rmoms in get_moments(ds):
# 			moms += rmoms
# 		ret.append(moms)
# 	return ret


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


def numrec_initialiser(n_clusters: int, rework: bool = False) -> NumberRecogniser:
	num_rec_pkl = RAG / r"numrec.pkl"
	if not rework and num_rec_pkl.exists():
		num_rec = pk.load(open(num_rec_pkl, "rb"))
	else:
		allcs = []
		for f in itertools.islice(RAG.glob(r"*.jpg"), None):
			print(f"Processing (numrec_initialiser) {f}...")
			inp = InpImage(f)

			for X in range(9):
				for Y in range(9):
					sums = inp.info['sums'][Y, X]
					if sums is not None:
						allcs += sums

		num_rec = NumberRecogniser(allcs, n_clusters)
		pk.dump(num_rec, open(num_rec_pkl, "wb"))

	return num_rec


cl_nums_g = list([3, 1, 2, 0, 1, 8, 7, 9, 6, 1, 4, 0, 2, 5, 3, 7])
cl_nums_o = list([2, 1, 6, 4, 0, 7, 8, 3, 1, 2, 1, 9, 5, 1, 2, 5])
cl_nums: list[int] = cl_nums_g if GNOTO else cl_nums_o
NUM_REC = numrec_initialiser(16)

# fig, (axg, axb, sl) = plt.subplots(1, 3)
# def update(warped_blr, v):
# 	k = 2*int(v)+1
# 	warped_blk = cv2.adaptiveThreshold(warped_blr, 255, cv2.ADAPTIVE_THRESH_MEAN_C,
# 	                                   cv2.THRESH_BINARY, k, 0)
# 	axb.imshow(warped_blk, 'gray')
#
# at_slider = Slider(
# 	ax=sl,
# 	label="val",
# 	valmin=1,
# 	valmax=18,
# 	valinit=3,
# 	orientation="vertical"
# )
# at_slider.on_changed(lambda v, wb=warped_blr: update(wb, v))
# # plt.subplot(1, 2, 1)
# axg.imshow(warped_blr, 'gray')
# axg.set_xticks([]), axg.set_yticks([])
# # plt.subplot(1, 2, 2)
# axb.imshow(warped_blk, 'gray')
# axb.set_xticks([]), axb.set_yticks([])
# plt.show()
# exit(0)
