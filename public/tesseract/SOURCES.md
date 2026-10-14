# Self-hosted OCR assets (Apache-2.0)

PRD rule: every asset loads from our own origin — no third-party CDN.

| File | Source | Version |
| --- | --- | --- |
| `public/tesseract/tesseract.min.js` | npm `tesseract.js` dist (UMD browser bundle) | 7.0.0 |
| `public/tesseract/worker.min.js` | npm `tesseract.js` dist | 7.0.0 |
| `public/tesseract/tesseract-core-*.wasm.js` | npm `tesseract.js-core` dist (single-file wasm builds) | 7.0.0 |
| `public/tessdata/eng.traineddata.gz` | github `tesseract-ocr/tessdata_fast` @ main, gzipped -9 | 4.0.0_fast |
| `public/tessdata/hin.traineddata.gz` | github `tesseract-ocr/tessdata_fast` @ main, gzipped -9 | 4.0.0_fast |

Only the LSTM single-file cores are shipped (we always run OEM.LSTM_ONLY):
`relaxedsimd` / `simd` / plain — the worker picks via wasm-feature-detect.

Regenerating the language files:

```
curl -sL -o eng.raw https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/main/eng.traineddata
gzip -9 -c eng.raw > eng.traineddata.gz
```
