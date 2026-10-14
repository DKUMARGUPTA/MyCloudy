"""PIL round-trip check for tools/compress-pdf/gray-jpeg.ts outputs.

Each case is decoded with Pillow and compared to the source luma plane:
  - flat   : must be pixel-exact (all-DC blocks survive quantization)
  - others : PSNR against the source must clear a quality-dependent bar
Also asserts the decoded mode is 'L' (true single-channel grayscale JPEG).
"""
import sys
from pathlib import Path

from PIL import Image

DIR = Path("download/gray-qa")
PSNR_MIN = {"flat": 999.0, "gradient": 32.0, "noise": 16.0, "odd": 24.0}
# flat must be exact; noise is inherently lossy at any sane quality

failures = []

for jpg_path in sorted(DIR.glob("*.jpg")):
    name = jpg_path.stem
    src = DIR / f"{name}.bin"
    if not src.exists():
        failures.append(f"{name}: missing .bin")
        continue

    img = Image.open(jpg_path)
    img.load()
    if img.mode != "L":
        failures.append(f"{name}: decoded mode {img.mode}, expected 'L'")
        continue

    decoded = img.tobytes()
    original = src.read_bytes()
    if len(decoded) != len(original):
        failures.append(f"{name}: decoded {len(decoded)} px, source {len(original)} px")
        continue

    se = 0
    max_diff = 0
    for a, b in zip(decoded, original):
        d = a - b
        se += d * d
        max_diff = max(max_diff, abs(d))

    if se == 0:
        psnr = float("inf")
        print(f"  {name}: mode=L exact (max diff 0) — PASS")
        continue
    mse = se / len(decoded)
    psnr = 10 * __import__("math").log10(255 * 255 / mse)
    threshold = PSNR_MIN.get(name, 24.0)
    status = "PASS" if psnr >= threshold else "FAIL"
    print(
        f"  {name}: mode=L psnr={psnr:.1f}dB maxdiff={max_diff} "
        f"(min {threshold}) — {status}"
    )
    if psnr < threshold:
        failures.append(f"{name}: psnr {psnr:.1f} < {threshold}")

if failures:
    print("\nVERIFY FAIL:", "; ".join(failures))
    sys.exit(1)
print("\nGRAY JPEG VERIFY PASS")
