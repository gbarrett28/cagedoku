from num_rec import *
from grid import Grid, ProcessingError
# from constraint import Problem, ExactSumConstraint, Domain


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

for f in itertools.islice(RAG.glob(r"*.jpg"), None):
	print(f"Processing {f}...")
	inp = InpImage(f)
	grd = Grid()

	brdrs = np.full(shape=(9, 9, 4), fill_value=True)
	for X in range(9):
		for Y in range(8):
			if ONOTG:
				[osbh, osbv] = OBRDR.tr_brdrs([inp.info['brdrph'][X, Y], inp.info['brdrpv'][Y, X]])
				brdrs[Y + 0, X][1] = osbh
				brdrs[Y + 1, X][3] = osbh
				brdrs[X, Y + 0][2] = osbv
				brdrs[X, Y + 1][0] = osbv
			else:
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
				ntrs = NUM_REC.get_sums(sums)
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

