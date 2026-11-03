"""Measure blank bands: contain vs fill (the R44 fix)."""
import fitz


def bands(path):
    doc = fitz.open(path)
    page = doc[0]
    pix = page.get_pixmap(dpi=72)
    w, h, n = pix.width, pix.height, pix.n
    buf = pix.samples

    def col_white(x):
        for y in range(h):
            if buf[(y * w + x) * n] <= 245:
                return False
        return True

    def row_white(y):
        row = buf[y * w * n:(y + 1) * w * n]
        return all(row[i] > 245 for i in range(0, len(row), n))

    left = 0
    while left < w and col_white(left):
        left += 1
    right = 0
    while right < w and col_white(w - 1 - right):
        right += 1
    top = 0
    while top < h and row_white(top):
        top += 1
    bottom = 0
    while bottom < h and row_white(h - 1 - bottom):
        bottom += 1
    return left, right, top, bottom, w, h


for label, path in [
    ("CONTAIN (old default)", "download/r44-contain.pdf"),
    ("FILL    (new option) ", "download/r44-fill.pdf"),
]:
    l, r, t, b, w, h = bands(path)
    print(
        f"{label}: page {w}x{h}pt | blank L={l}pt R={r}pt T={t}pt B={b}pt "
        f"({round(100 * (l + r) / w)}% side waste)"
    )
