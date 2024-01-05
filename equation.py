class Equation:
	# Find all the columns, rows, boxes and cages that intersect with the variables of an equation.
	def set_crbr(self):
		self.col = set()
		self.row = set()
		self.box = set()
		self.rgn = set()
		for i, j in self.s:
			self.col.add(j)
			self.row.add(i)
			self.box.add((3 * (i // 3)) + (j // 3))
			self.rgn.add(self.region[i][j] - 1)

	def __init__(self, s, v, grid):
		assert s != set()
		self.region = grid.region
		self.s = s.copy()
		self.v = v
		self.solve()
		self.calc_mp()
		self.set_crbr()

	def __le__(self, other):
		return self.s <= other.s

	def difference_update(self, other):
		self.s -= other.s
		self.v -= other.v
		self.set_crbr()
		if self.s != set():
			new_solns = []
			for os in other.solns:
				for ss in self.solns:
					if os <= ss:
						new_solns.append(ss - os)
			self.solns = new_solns
		else:
			self.solns = [set()]
		self.calc_mp()

	def show(self):
		return " + ".join([str(n) for n in self.s]) + " = " + str(self.v)  # + " box=" + str(self.box)

	def calc_mp(self):
		self.must = set(range(1, 10))
		self.poss = set()
		for soln in self.solns:
			self.poss |= soln
			self.must &= soln

	def solve(self):
		self.solns = sol_sums(len(self.s), 0, self.v)
		for sol in self.solns:
			assert len(sol) == len(self.s)
		self.calc_mp()


def sol_sums(n, m, v):
	# n is the number of digits in the solution
	# m is the last digit that was used
	# v is the target of the sum
	sq = (n * (n - 1)) // 2
	lo = (n * (m + 1)) + sq
	hi = (n * 9) - sq
	if not (lo <= v <= hi):
		return []
	if n == 1:
		return [{v}]

	solns = []
	for i in range(m + 1, min(10, v)):
		solns += [s | {i} for s in sol_sums(n - 1, i, v - i)]
	return solns


