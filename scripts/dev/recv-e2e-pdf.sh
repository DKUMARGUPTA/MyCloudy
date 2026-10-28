#!/bin/bash
# Receive the E2E PDF from the browser via chunked base64 evals.
OUT="$1"
: > "$OUT.b64"
CHUNK=3000
TOTAL=5704
for ((i=0; i<TOTAL; i+=CHUNK)); do
  LEN=$((CHUNK < TOTAL - i ? CHUNK : TOTAL - i))
  cat <<EVA | agent-browser eval --stdin > /tmp/_chunk.txt 2>/dev/null
(async () => {
  const b = window.__E2E_PDF;
  const bytes = new Uint8Array(b);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin).slice($i, $i + $LEN);
})()
EVA
  python3 - <<PY
import json
line = open("/tmp/_chunk.txt").read().strip()
if line.startswith('"') and line.endswith('"'):
    line = json.loads(line)
open("$OUT.b64", "a").write(line)
PY
done
python3 -c "import base64; open('$OUT','wb').write(base64.b64decode(open('$OUT.b64').read()))"
echo "received: $(wc -c < "$OUT") bytes"
