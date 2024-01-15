from inp_image import *
from grid import Grid, ProcessingError


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


for f in itertools.islice(RAG.glob(r"*.jpg"), 1):
	print(f"Processing {f}...")
	inp = InpImage(f)
	grd = Grid()

	grd.sol_img.draw_borders(inp.info['brdrs'])

	prd_per_sq = np.zeros(shape=(9, 9), dtype=int)
	for X in range(9):
		for Y in range(9):
			sums = inp.info['sums'][Y, X]
			if sums is not None:
				ntrs = NUM_REC.get_sums(sums)
				if len(ntrs) > 4:
					print(ntrs)
					exit(0)
				for v in [v for v in ntrs if v >= 0]:
					prd_per_sq[X, Y] = (10 * prd_per_sq[X, Y]) + v
				grd.sol_img.draw_sum(X, Y, prd_per_sq[X, Y])

	try:
		grd.set_up(prd_per_sq, inp.info['brdrs'])

		alts_sum, solns_sum = grd.solve()
		if alts_sum != 81:
			print("... cheating")
			grd.cheat_solve()
	except ProcessingError as e:
		print("... failed with ProcessingError: ", e.msg)
		plt_images([inp.gry, grd.sol_img.sol_img])
	# exit(0)
	except AssertionError as e:
		print("... failed with AssertionError: ", e)
	# plt_images([inp.gry, grd.sol_img.sol_img])
	# exit(0)
	except ValueError:
		print("... failed with ValueError")
		plt_images([inp.gry, grd.sol_img.sol_img])
		exit(0)
