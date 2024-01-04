import argparse
import math
import pathlib
import pickle as pk
import itertools

import cv2
import numpy as np
from matplotlib import pyplot as plt
from sklearn import linear_model
from sklearn.cluster import KMeans
from sklearn.decomposition import PCA

parser = argparse.ArgumentParser()
parser.add_argument('--rag', choices=["observer", "guardian"], required=True)
parser.add_argument('--rework', default=False)
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
		else:
			print(pts)
			print(ints)
			print(l)


def process_sample(s, isblack):
	if GNOTO:
		sbw = s < isblack
		sl = sbw[1:]
		sr = sbw[:-1]
		su = sl & ~sr
		sd = ~sl & sr
		return su.sum(), sd.sum()
	else:
		return s


class BorderDecode:
	def __init__(self, pca, kmeans, isbrdr):
		self.pca = pca
		self.kmeans = kmeans
		self.isbrdr = isbrdr


def observer_border_gen(rework=REWORK):
	samples = []
	hasnums = []
	globs = RAG.glob(r"*.jpg")
	for f in itertools.islice(globs, None):
		print(f"Processing {f}...")
		inp = InpImage(f, rework)
		for X in range(9):
			for Y in range(9):
				cbd = len(inp.info['sums'][X, Y][0]) != 0
				if X > 0:
					hasnums.append(cbd)
					samples.append(inp.info['brdrsh'][Y, X - 1])
				if Y > 0:
					hasnums.append(cbd)
					samples.append(inp.info['brdrsv'][Y - 1, X])

	brdr_path = RAG / r"brdr.pkl"
	if not rework and brdr_path.exists():
		brdr: BorderDecode = pk.load(open(brdr_path, "rb"))
	else:
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


# OBRDR = observer_border_gen() if ONOTG else None

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
	_, _, w, h = br
	return InpImage.SUBRES // 16 <= w < InpImage.SUBRES // 2 and \
		InpImage.SUBRES // 8 <= h < InpImage.SUBRES // 2


# return InpImage.SUBRES // 16 <= w
# return w < InpImage.SUBRES // 2
# return InpImage.SUBRES // 8 <= h
# return h < InpImage.SUBRES // 2
# return True

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


class InpImage:
	do_print = False
	RHO = 2  # 5
	THETA = math.pi / 16
	HTHRESH = 3 * 379

	# Size of the regions used for detecting borders.
	SUBRES = 128
	RESOLUTION = 9 * SUBRES
	DST_SIZE = np.array([
		[0, 0],
		[RESOLUTION - 1, 0],
		[RESOLUTION - 1, RESOLUTION - 1],
		[0, RESOLUTION - 1]], dtype="float32")

	def __init__(self, f, rework=REWORK):
		self.info = dict()

		jpk = f.with_suffix(r".jpk")
		if not rework and jpk.exists():
			self.info = pk.load(open(jpk, "rb"))
		else:
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
			# blur = cv2.GaussianBlur(gry, (5, 5), 0)
			# gry = cv2.addWeighted(gry, 1.5, blur, -0.5, 0)
			blk_detect = np.reshape(np.ravel(gry), (-1, 1))
			counts, bins = np.histogram(blk_detect, bins=range(0, 257, 16))
			self.info['hist'] = counts
			# print(counts, bins)

			# print(f"GNOTO={GNOTO}, RAG={RAG}")
			if GNOTO:
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

			blk = cv2.inRange(gry, 0, isblack)
			self.info['isblack'] = isblack

			lines_rt = cv2.HoughLines(blk, InpImage.RHO, InpImage.THETA, InpImage.HTHRESH)
			if lines_rt is None:
				print(f"Lines not found for {f}")
				self.show_stuff(bins, blk, counts, img, isblack, [], [])
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

			num_chiers = []
			if len(usects) < 4:
				print(f"Intersections not found for {f}")
				self.show_stuff(bins, blk, counts, img, isblack, [], [])
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
				# cv2.circle(img, (round(x), round(y)), 1, (0, 0, 255), -1)
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

				self.info['brdrsh'] = np.zeros((9, 8, InpImage.SUBRES // 2), np.uint8)
				self.info['brdrsv'] = np.zeros((8, 9, InpImage.SUBRES // 2), np.uint8)
				for X in range(9):
					XM = (((2 * X + 1) * InpImage.SUBRES) // 2)
					XT = XM + (InpImage.SUBRES // 4) - (InpImage.SUBRES // 16)
					XB = XM + (InpImage.SUBRES // 16)
					for Y in range(1, 9):
						# Take a square centred on the boundary that is a quarter the area of a cell
						YL = (Y * InpImage.SUBRES) - (InpImage.SUBRES // 4)
						YR = (Y * InpImage.SUBRES) + (InpImage.SUBRES // 4)
						self.info['brdrsh'][X, Y - 1] = np.min(warped_gry[XB:XT, YL:YR], axis=0)
						self.info['brdrsv'][Y - 1, X] = np.min(warped_gry[YL:YR, XB:XT], axis=1)

				self.info['sums'] = np.empty((9, 9), dtype=object)
				warped_blk = cv2.warpPerspective(blk, m, (InpImage.RESOLUTION, InpImage.RESOLUTION),
				                                 flags=cv2.INTER_AREA)
				# Blank out the grid lines so that they don't join up all the numbers.
				for x in reversed(range(1, warped_blk.shape[0])):
					if np.mean(warped_blk[:, x - 1]) > 200:
						warped_blk[:, x] = 0
				for y in reversed(range(1, warped_blk.shape[1])):
					if np.mean(warped_blk[y - 1, :]) > 200:
						warped_blk[y, :] = 0

				# erosion_size = 2
				# element = cv2.getStructuringElement(cv2.MORPH_CROSS, (2 * erosion_size + 1, 2 * erosion_size + 1),
				#                                    (erosion_size, erosion_size))
				# warped_blk = cv2.erode(warped_blk, element)
				# warped_blk = cv2.dilate(warped_blk, element)
				# warped_blk = cv2.erode(warped_blk, element)
				# warped_blk = cv2.dilate(warped_blk, element)
				# warped_blk = cv2.erode(warped_blk, element)
				# warped_blk = cv2.dilate(warped_blk, element)
				# warped_blk = cv2.erode(warped_blk, element)
				# warped_blk = cv2.dilate(warped_blk, element)

				contours, hiers = cv2.findContours(warped_blk, cv2.RETR_TREE, cv2.CHAIN_APPROX_SIMPLE)
				if hiers is not None:
					[hier] = hiers
					chiers = contour_hier(list(zip(contours, hier)), set())
					num_chiers = get_num_contours(chiers)
					InpImage.do_print = len(num_chiers) <= 9
					for (c, br, ds) in num_chiers:
						x, y, _, _ = br
						X = x // InpImage.SUBRES
						Y = y // InpImage.SUBRES
						if self.info['sums'][X, Y] is None:
							self.info['sums'][X, Y] = list()
						self.info['sums'][X, Y].append((c, br, ds))

			self.show_stuff(bins, warped_blk, counts, img, isblack, rect, num_chiers)

			pk.dump(self.info, open(jpk, "wb"))

	@staticmethod
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
			exit(0)
