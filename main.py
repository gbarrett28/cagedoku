from inp_image import *
from grid import Grid, ProcessingError


def observer_pca_1d_borders(rework=True, rework_all=False):
	mdb = observer_1d_pca_border_gen(rework, rework_all)

	status_pat = re.compile(r"^")
	aerror, cheated, perror, solved, total = test_border_fun(status_pat, lambda p: mdb.is_border([p])[0])
	print(f"SOLVED          {solved:3d}")
	print(f"CHEATED         {cheated:3d}")
	print(f"ProcessingError {perror:3d}")
	print(f"AssertionError  {aerror:3d}")
	print(f"TOTAL           {total:3d}")


def test_border_fun(status_pat, is_border=None):
	solved = 0
	cheated = 0
	perror = 0
	aerror = 0
	total = 0
	for f in itertools.islice(RAG.glob(r"*.jpg"), None):
		if re.match(status_pat, status[f]):
			print(f"Processing (test_border_fun) {f}...")
			total += 1
			inp = InpImage(f, rework=True)
			grd = Grid()

			if is_border is None:
				brdrs = inp.info['brdrs']
			else:
				brdrs = np.full(shape=(9, 9, 4), fill_value=True)
				for X in range(9):
					for Y in range(8):
						isbh = is_border(inp.brdrph[X, Y])
						isbv = is_border(inp.brdrpv[Y, X])
						brdrs[Y + 0, X][1] = isbh
						brdrs[Y + 1, X][3] = isbh
						brdrs[X, Y + 0][2] = isbv
						brdrs[X, Y + 1][0] = isbv

			try:
				grd.set_up(inp.info['cagevals'], brdrs)

				alts_sum, solns_sum = grd.solve()
				if alts_sum != 81:
					print("... cheating")
					sol_aux = grd.sol_img.sol_img.copy()
					grd.sol_img.draw_dots(grd.sq_poss)
					sol_mine = grd.sol_img.sol_img.copy()
					grd.sol_img.sol_img = sol_aux
					grd.cheat_solve()
					status[f] = 'CHEAT'
					cheated += 1
					plt_images([sol_mine, grd.sol_img.sol_img])
					exit(0)
				else:
					status[f] = 'SOLVED'
					solved += 1
			except ProcessingError as e:
				print("... failed with ProcessingError: ", e.msg)
				status[f] = f"ProcessingError: {e.msg}"
				perror += 1
				plt_images([inp.img, inp.blk, grd.sol_img.sol_img])
				# exit(0)
			# except AssertionError as e:
			# 	print("... failed with AssertionError: ", e)
			# 	status[f] = f"AssertionError: {e}"
			# 	aerror += 1
			# except ValueError:
			# 	print("... failed with ValueError")
			# 	plt_images([inp.gry, grd.sol_img.sol_img])
			# 	exit(0)
	return aerror, cheated, perror, solved, total


collect_status()
# test_border_fun(re.compile(r"CHEAT"))
# observer_pca_1d_borders(rework=True)

# status_pat = re.compile(r"^AssertionError")
# test_num_rec(status_pat)


# rework = True
# rework_all = True
#
# if not rework and nums_pca_s_path.exists():
# 	num_pca_s = pk.load(open(nums_pca_s_path, "rb"))
# else:
# 	num_pca_s = rework_cayenne(rework_all=True)

# num_pca_s.show_scatter()
# GUARDIAN
# SOLVED          461
# CHEATED           2
# ProcessingError   0
# AssertionError    2
# TOTAL           465

# OBSERVER
# SOLVED          412
# CHEATED          10
# ProcessingError   0
# AssertionError    2
# TOTAL           424
