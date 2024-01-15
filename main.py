from inp_image import *
from grid import Grid, ProcessingError


status_path = RAG / "status.pkl"
if status_path.exists():
	status = pk.load(open(status_path, "rb"))
else:
	status = dict()

solved = 0
cheated = 0
perror = 0
aerror = 0
total = 0
for f in itertools.islice(RAG.glob(r"*.jpg"), None):
	print(f"Processing {f}...")
	total += 1
	inp = InpImage(f)
	grd = Grid()

	try:
		grd.set_up(inp.info['cagevals'], inp.info['brdrs'])

		alts_sum, solns_sum = grd.solve()
		if alts_sum != 81:
			print("... cheating")
			grd.cheat_solve()
			status[f] = 'CHEAT'
			cheated += 1
		else:
			status[f] = 'SOLVED'
			solved += 1
	except ProcessingError as e:
		print("... failed with ProcessingError: ", e.msg)
		status[f] = f"ProcessingError: {e.msg}"
		perror += 1
		# plt_images([inp.gry, grd.sol_img.sol_img])
		# exit(0)
	except AssertionError as e:
		print("... failed with AssertionError: ", e)
		status[f] = f"AssertionError: {e}"
		aerror += 1
		# plt_images([inp.gry, grd.sol_img.sol_img])
		# exit(0)
	except ValueError:
		print("... failed with ValueError")
		plt_images([inp.gry, grd.sol_img.sol_img])
		exit(0)

pk.dump(status, open(status_path, "wb"))
print(f"SOLVED          {solved:3d}")
print(f"CHEATED         {cheated:3d}")
print(f"ProcessingError {perror:3d}")
print(f"AssertionError  {aerror:3d}")
print(f"TOTAL           {total:3d}")

# GUARDIAN
# SOLVED          458
# CHEATED           2
# ProcessingError   3
# AssertionError    2
# TOTAL           465

# OBSERVER
# SOLVED          382
# CHEATED          10
# ProcessingError  32
# AssertionError    0
# TOTAL           424
