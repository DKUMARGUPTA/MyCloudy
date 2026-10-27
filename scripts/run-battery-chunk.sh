#!/usr/bin/env bash
# R14 battery chunk runner: resumable foreground chunks (the sandbox reaps
# long-lived background shells). Each invocation runs pending smokes until
# ~460s elapse, appending PASS/FAIL lines to /tmp/r6b-smoke-battery.txt.
# Call repeatedly until it prints "ALL DONE".
cd /home/z/my-project
OUT=/tmp/r6b-smoke-battery.txt
START=$(date +%s)
DEADLINE=$((START + 460))
for f in scripts/smoke-*.ts; do
  name=$(basename "$f")
  grep -qF "PASS $name " "$OUT" && continue
  s=$(date +%s)
  if timeout 420 bun "$f" > "/tmp/r6b-smoke-$name.log" 2>&1; then
    echo "PASS $name $(( $(date +%s) - s ))s" >> "$OUT"
  else
    code=$?
    echo "FAIL($code) $name $(( $(date +%s) - s ))s" >> "$OUT"
  fi
  now=$(date +%s)
  if [ $((now - START)) -ge 460 ]; then
    echo "CHUNK_TIMEOUT $(date +%s)"
    exit 0
  fi
done
echo "ALL DONE $(date +%s)"
