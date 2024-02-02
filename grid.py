from equation import *
from sol_image import *
from constraint import *


class NoSolnError(Exception):
	pass


class ProcessingError(Exception):
	def __init__(self, msg, regions, brdrs):
		self.msg = msg
		self.regions = regions
		self.brdrs = brdrs


COLLS = 'abcdefghi'
ROWLS = '123456789'

# Sets of coordinates for rows/columns/boxes.
ROWS = [set([(i, j) for j in range(9)]) for i in range(9)]
COLS = [set([(j, i) for j in range(9)]) for i in range(9)]
BOXS = [set([((3 * (i // 3)) + (j // 3), (3 * (i % 3)) + (j % 3)) for j in range(9)]) for i in range(9)]


def all_boxes_a(i, s):
	s.add(i)
	x = i // 3
	y = i % 3
	ret = [[]]
	if y < 2 and i + 1 not in s:
		ret += [[BOXS[i]] + s for s in all_boxes_a(i + 1, s.copy())]
	if y > 0 and i - 1 not in s:
		ret += [[BOXS[i]] + s for s in all_boxes_a(i - 1, s.copy())]
	if x < 2 and i + 3 not in s:
		ret += [[BOXS[i]] + s for s in all_boxes_a(i + 3, s.copy())]
	if x > 0 and i - 3 not in s:
		ret += [[BOXS[i]] + s for s in all_boxes_a(i - 3, s.copy())]
	return [l for l in ret if len(l) + len(s) == 9]


def all_boxes():
	ret = []
	for i in range(len(BOXS)):
		ret += all_boxes_a(i, set())
	return ret


BOX_SEQS = all_boxes()

# Strings for the variables used in each box and collections for rows/columns/boxes.
# These are used by the constraint solver.
VARNS = [c + r for r in ROWLS for c in COLLS]
COLNS = [[c + r for r in ROWLS] for c in COLLS]
ROWNS = [[c + r for c in COLLS] for r in ROWLS]
BOXNS = [[c + r for c in COLLS[i:i + 3] for r in ROWLS[j:j + 3]] for i in range(0, 9, 3) for j in
         range(0, 9, 3)]

# Offset of up/right/down/left.
BRDR_MV = [[0, -1], [1, 0], [0, 1], [-1, 0]]


class Grid:
	# region: ndarray[(9, 9), dtype[np.uint]]
	# sq_poss: ndarray[(9, 9), dtype[set[np.uint8]]]

	# Find all the points in a cage starting at the square containing the total.
	def mark_region(self, i, j, reg, brdrs):
		marked = 0
		if self.region[i][j] == 0:
			self.region[i][j] = reg
			marked = 1
			for b, mv in zip(brdrs[j][i], BRDR_MV):
				if not b:
					marked += self.mark_region(i + mv[1], j + mv[0], reg, brdrs)
		elif self.region[i][j] != reg:
			raise ProcessingError(f"region reassigned", self.region, brdrs)

		return marked

	def add_equns(self, line):
		equns = []
		rf = 0
		rb = 0
		cvr = set()
		sm = 0
		while rf < len(line):
			lmc = line[rf] - cvr
			cml = cvr - line[rf]
			if len(lmc) == 1 and len(cml) == 1:
				# (p, q, n) in DFFS => q == p+n
				self.DFFS.add((lmc.copy().pop(), cml.copy().pop(), sm - 45))
			for i, j in lmc:
				if (i, j) not in cvr:
					c, v = self.get_cge_val(i, j)
					cvr |= c
					sm += v
			assert sm >= 45
			rf += 1
			while rb < len(line) and line[rb] <= cvr:
				cvr -= line[rb]
				sm -= 45
				assert sm >= 0
				assert (sm == 0) == (cvr == set()), f"sm={sm}, cvr={cvr}"
				rb += 1
			rf = max(rf, rb)
			if sm != 0:
				i, j = cvr.copy().pop()
				if self.is_burb(cvr, i, j):
					equns.append(Equation(cvr, sm, self))

		return equns

	def is_burb(self, cvr, i, j):
		return cvr <= self.get_row(i, j) or cvr <= self.get_col(i, j) or \
				cvr <= self.get_box(i, j) or cvr <= self.get_cge(i, j)

	def get_row(self, i, j):
		return ROWS[i]

	def get_col(self, i, j):
		return COLS[j]

	def get_box(self, i, j):
		return BOXS[(3 * (i // 3)) + (j // 3)]

	def get_cge(self, i, j):
		return self.CAGES[self.region[i][j] - 1]

	def get_cge_val(self, i, j):
		idx = self.region[i][j] - 1
		return self.CAGES[idx], self.VALS[idx]


	# Add equations from the boxes.
	def add_equns_r(self, box, cvr, sm=0, seen=None):
		if seen is None:
			seen = set()

		equns = []
		for i, j in BOXS[box]:
			if (i, j) not in cvr:
				c, v = self.get_cge_val(i, j)
				cvr |= c
				sm += v
		# remove completely covered boxes
		for b in set(range(len(BOXS))) - seen:
			if BOXS[b] <= cvr:
				assert sm >= 45, \
					f"sum={sm} box={b} cover={cvr}"
				seen.add(b)
				sm -= 45
				cvr -= BOXS[b]
		# add an equation if possible
		if sm != 0:
			assert cvr != set(), \
				f"sum={sm}"
			i, j = cvr.copy().pop()
			if self.is_burb(cvr, i, j):
				equns.append(Equation(cvr, sm, self))
		# find where to go next
		bi, bj = box // 3, box % 3
		for di, dj in [(-1, 0), (1, 0), (0, -1), (0, 1)]:
			ni, nj = (bi + di, bj + dj)
			nb = (3 * ni) + nj
			if 0 <= ni < 3 and 0 <= nj < 3:
				if (ni, nj) not in seen and not BOXS[nb].isdisjoint(cvr):
					equns += self.add_equns_r(box=nb, cvr=cvr.copy(), sm=sm, seen=seen.copy())

		return equns

	def __init__(self):
		self.sol_img = SolImage()

		self.sq_poss = np.array([[set(range(1, 10)) for _ in range(9)] for _ in range(9)])
		# self.sq_poss = np.full((9, 9), set(range(1, 10)))
		self.CAGES = []
		self.VALS = []
		self.region = np.zeros((9, 9), np.uint)

	def set_up(self, prd_per_sq, brdrs):
		self.sol_img.draw_borders(brdrs)

		cszs = np.zeros((9, 9), dtype=int)
		# Mark all the regions.
		reg = 0
		for i in range(9):
			for j in range(9):
				if prd_per_sq[i][j] != 0:
					self.sol_img.draw_sum(i, j, prd_per_sq[i][j])
					reg += 1
					cszs[i, j] = self.mark_region(i, j, reg, brdrs)
					n = cszs[i, j]
					assert (n * (n + 1)) // 2 <= prd_per_sq[i][j] <= (
							n * (19 - n)) // 2, f"cagesize={n}, total={prd_per_sq[i][j]}"
		if (self.region == 0).any():
			raise ProcessingError("unassigned region", self.region, brdrs)

		# Set up the CAGES and VALS for each cage.
		self.CAGES = [set() for _ in np.unique(self.region)]
		self.VALS = [0 for _ in np.unique(self.region)]
		for i in range(9):
			for j in range(9):
				idx = self.region[i][j] - 1
				self.CAGES[idx].add((i, j))
				self.VALS[idx] = max(self.VALS[idx], prd_per_sq[i][j])

		# Initialise the equations.
		self.equns = [Equation(s, 45, self) for s in ROWS + COLS + BOXS]
		self.equns += [Equation(s, v, self) for s, v in zip(self.CAGES, self.VALS)]
		self.DFFS = set()
		self.equns += self.add_equns(ROWS)
		self.equns += self.add_equns(COLS)
		self.equns += self.add_equns(ROWS[::-1])
		self.equns += self.add_equns(COLS[::-1])
		for b in range(len(BOXS)):
			self.equns += self.add_equns_r(box=b, cvr=set())

	# Remove a value from all other rows/columns/boxes/cages
	# when it is known to be the solution to one of the squares.
	def discard_n(self, i, j, n):
		# Keep track of whether anything changes.
		reduced = False
		for k in range(9):
			if i != k:
				reduced |= n in self.sq_poss[k][j]
				self.sq_poss[k][j].discard(n)
			if j != k:
				reduced |= n in self.sq_poss[i][k]
				self.sq_poss[i][k].discard(n)
			x = (3 * (i // 3)) + (k // 3)
			y = (3 * (j // 3)) + (k % 3)
			if i != x or j != y:
				reduced |= n in self.sq_poss[x][y]
				self.sq_poss[x][y].discard(n)
		rgn = self.get_cge(i, j)
		for x, y in rgn:
			if (i, j) != (x, y):
				reduced |= n in self.sq_poss[x][y]
				self.sq_poss[x][y].discard(n)
		return reduced

	# Like discard_n but
	# where a number must be in some part of a row/col/box/cage then eliminate it from the rest.
	def elim_must(self):
		reduced = False
		univ = set(range(1, 10))
		loads = [(e.s, e.must) for e in self.equns] + \
		        [(s, univ) for s in COLS + ROWS + BOXS] + \
		        [(s, set()) for s in self.CAGES]
		for i in range(len(loads)):
			si, mi = loads[i]
			for j in range(len(loads)):
				sj, mj = loads[j]
				sij = si & sj
				if i != j and sij != set():
					elsewhere = set()
					for x, y in si - sj:
						elsewhere |= self.sq_poss[x][y]
					sij_must = mi - elsewhere
					for x, y in sj - si:
						reduced |= not self.sq_poss[x][y].isdisjoint(sij_must)
						self.sq_poss[x][y] -= sij_must

		for ((pi, pj), (qi, qj), n) in self.DFFS:
			na = self.sq_poss[pi][pj] & set([m - n for m in self.sq_poss[qi][qj] if 1 <= m - n <= 9])
			self.sq_poss[pi][pj] = na
			self.sq_poss[qi][qj] = set([m + n for m in na])

		return reduced

	# Find all possible assignments of the values in vs to the points in ps.
	def sol_maps(self, ps, vs):
		assert len(ps) == len(vs)
		sqs = sorted(list(ps), key=lambda p: len(self.sq_poss[p[0]][p[1]]))
		sqi, sqj = sqs[0]
		if len(sqs) == 1:
			v = vs.pop()
			return [{(sqi, sqj, v)}] if v in self.sq_poss[sqi][sqj] else []

		solns = []
		for v in self.sq_poss[sqi][sqj] & vs:
			subsols = self.sol_maps(ps - {(sqi, sqj)}, vs - {v})
			solns += [{(sqi, sqj, v)} | m for m in subsols]
		return solns

	# Find equations whose variables are a subset of other equations and simplify accordingly.
	def reduce_equns(self, equns):
		reduced = True
		while reduced:
			reduced = False
			equns = sorted([e for e in equns if e.s != set()], key=lambda e: len(e.s))
			for i in range(len(equns)):
				for j in range(i + 1, len(equns)):
					if equns[i] <= equns[j]:
						equns[j].difference_update(equns[i])
						reduced = True

		return equns

	# Use human solution methods for solving the grid.
	def solve(self):
		self.equns = self.reduce_equns(self.equns)

		# Restrict each square to have some number from the solutions to the equation.
		self.sq_poss = np.array([[set(range(1, 10)) for _ in range(9)] for _ in range(9)])
		for e in self.equns:
			for i, j in e.s:
				self.sq_poss[i][j] &= e.poss

		# Where an area is known to require a set of values,
		# remove those values from any bigger area with a unique property.
		reduced = True
		while reduced:
			reduced = self.elim_must()

		# Propagate definite values across rows/cols/boxes/cages
		for i in range(9):
			for j in range(9):
				if len(self.sq_poss[i][j]) == 1:
					n = self.sq_poss[i][j].copy().pop()
					self.sol_img.draw_number(n, i, j)
					self.discard_n(i, j, n)

		# Use alts_sum and solns_sum as the variant for the loop.
		alts_sum = np.sum([np.sum([len(s) for s in col]) for col in self.sq_poss])
		solns_sum = np.sum([len(e.solns) << len(e.s) for e in self.equns])
		while True:
			new_equns = []
			for e in self.equns:
				# Don't do this with big regions.
				if True:  # len(e.s) <= 4 and len(e.solns) <= 3:
					sm = []  # List of solution mappings.
					sf = []  # List of whether a mapping was possible for each solution.
					for sl in e.solns:
						# Map each solution to squares if possible.
						assert len(e.s) == len(sl), f"{e.s}\n{sl}"
						sma = self.sol_maps(e.s, sl.copy())
						sf.append(len(sma) != 0)
						sm += sma
					e.solns = [s for s, b in zip(e.solns, sf) if b]
					e.calc_mp()

					# Calculate more precise possibilities for each square
					# based on whether a number appeared there in a mapped solution.
					new_sq_poss = [[set() for _ in range(9)] for _ in range(9)]
					for m in sm:
						for i, j, v in m:
							new_sq_poss[i][j].add(v)

					for i, j in e.s:
						self.sq_poss[i][j] &= new_sq_poss[i][j]
						if len(self.sq_poss[i][j]) == 1:
							n = self.sq_poss[i][j].copy().pop()
							self.sol_img.draw_number(n, i, j)
							self.discard_n(i, j, n)
							new_equns.append(Equation({(i, j)}, n, self))

			# Look for single numbers that only appear in one place in a row/col/box
			# or pairs of numbers that only appear in two places.
			for u in ROWS + COLS + BOXS:
				lu = np.array(list(u))
				grid = np.array([[num in self.sq_poss[i][j] for i, j in lu] for num in range(1, 10)])
				for num in range(9):
					if np.sum(grid[num, :]) == 1:
						sq = grid[num, :] == 1
						grid[:, sq] = 0
						grid[num, sq] = 1
						for i, j in lu[sq]:
							self.sq_poss[i][j] = {num + 1}
							new_equns.append(Equation({(i, j)}, num + 1, self))

				twos = [(num, grid[num, :]) for num in range(9) if np.sum(grid[num, :]) == 2]
				for i in range(len(twos)):
					numi, gridi = twos[i]
					for j in range(i):
						numj, gridj = twos[j]
						if (gridi == gridj).all():
							equn_vars = []
							for x, y in lu[gridi == 1]:
								self.sq_poss[x][y] = {numi + 1, numj + 1}
								equn_vars.append((x, y))
							new_equns.append(Equation(set(equn_vars), numi + numj + 2, self))

			# Simplify equations when the variables are subsets.
			if len(new_equns) != 0:
				self.equns = self.reduce_equns(new_equns + self.equns)

			# Remove numbers from areas when they must be in another part of the region.
			reduceda = True
			while reduceda:
				reduceda = self.elim_must()

			# Check whether we have found any reductions.
			old_alts_sum = alts_sum
			alts_sum = np.sum([np.sum([len(s) for s in col]) for col in self.sq_poss])
			assert alts_sum <= old_alts_sum
			old_solns_sum = solns_sum
			solns_sum = np.sum([len(e.solns) << len(e.s) for e in self.equns])
			assert solns_sum <= old_solns_sum
			if alts_sum == old_alts_sum and solns_sum == old_solns_sum:
				break

		return alts_sum, solns_sum

	# Use a generic constraint solver to solve the problem.
	def cheat_solve(self):
		CAGNS = [make_vars(vs) for vs in self.CAGES]
		ks = Problem()

		# Add the variables but use the constraints on squares that we have already deduced.
		for v in VARNS:
			ks.addVariable(v, range(1, 10))

		# Add the standard sudoku constraints.
		for vs in COLNS + ROWNS + BOXNS + CAGNS:
			ks.addConstraint(AllDifferentConstraint(), vs)

		# Add the cage total constraints.
		for v, vs in zip(self.VALS, CAGNS):
			ks.addConstraint(ExactSumConstraint(v), vs)

		# Help it a little with corollary of all-different constraint.
		for vs in COLNS + ROWNS + BOXNS:
			ks.addConstraint(ExactSumConstraint(45), vs)

		# Solve.
		s = ks.getSolution()

		# Add the solution back into the custom framework.
		for i in range(9):
			for j in range(9):
				self.sq_poss[i][j] = {s[COLNS[i][j]]}
				self.sol_img.draw_number(s[COLNS[i][j]], i, j)

def make_vars(vs):
	ret = set()
	for (i, j) in vs:
		ret.add(COLLS[i] + ROWLS[j])
	return ret
