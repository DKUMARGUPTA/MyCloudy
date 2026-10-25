#!/usr/bin/env bash
# R6-b: run every scripts/smoke-*.ts, print a one-line verdict each (420s cap per smoke — image-heavy smokes need headroom under sequential load), summary at end.
cd /home/z/my-project
OUT=/tmp/r6b-smoke-battery.txt
: > "$OUT"
for f in scripts/smoke-*.ts; do
  name=$(basename "$f")
  start=$(date +%s)
  if timeout 420 bun "$f" > "/tmp/r6b-smoke-$name.log" 2>&1; then
    end=$(date +%s)
    echo "PASS $name $((end-start))s" >> "$OUT"
  else
    code=$?
    end=$(date +%s)
    echo "FAIL($code) $name $((end-start))s" >> "$OUT"
  fi
done
echo "=== SUMMARY ===" >> "$OUT"
echo "pass=$(rg -c '^PASS' "$OUT") fail=$(rg -c '^FAIL' "$OUT" || echo 0)" >> "$OUT"
