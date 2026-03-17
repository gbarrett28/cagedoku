import pathlib
import cv2
from matplotlib import pyplot as plt
import numpy as np
from fpdf import FPDF


scan_dir = pathlib.Path(r"C:\Users\geoff\Pictures\Scans")

pdf = FPDF('P', 'mm', 'A4')
for (i, f) in enumerate(sorted(scan_dir.glob(r"*.jpg"), key=lambda f: f.stat().st_ctime), 1):
	print(f)
	gry = cv2.imread(str(f), cv2.IMREAD_GRAYSCALE)
	blk = cv2.adaptiveThreshold(gry, 192, cv2.ADAPTIVE_THRESH_MEAN_C, cv2.THRESH_BINARY, 31, 11)
	kernel = np.ones((2, 2), np.uint8)
	blk = cv2.morphologyEx(blk, cv2.MORPH_OPEN, kernel)
	blk = cv2.morphologyEx(blk, cv2.MORPH_CLOSE, kernel)
	blk = cv2.inRange(blk, 192, 255)
	gry2 = cv2.cvtColor(blk, cv2.COLOR_GRAY2RGB)
	dst = f"Taylor Swift - Exile ({i}).jpg"
	cv2.imwrite(str(dst), gry2)
	pdf.add_page()
	pdf.image(str(dst), 0, 0, 210, 297)
pdf.output(str(r"Taylor Swift - Exile.pdf"), "F")

# plt.imshow(blk, 'gray')
	# plt.show()



