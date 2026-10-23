#!/usr/bin/env bash
# Triage sweep: open every tool workspace, capture render state + page errors + console errors.
# Usage: bash scripts/audit-sweep.sh <start_line> <end_line>  (lines from /tmp/tool_ids.txt)
cd /home/z/my-project
OUT=/tmp/audit-sweep.jsonl
START=${1:-1}
END=${2:-97}
sed -n "${START},${END}p" /tmp/tool_ids.txt | while read -r id; do
  [ -z "$id" ] && continue
  agent-browser console --clear >/dev/null 2>&1
  agent-browser errors --clear >/dev/null 2>&1
  timeout 40 agent-browser open "http://localhost:3000/#/tool/${id}" >/dev/null 2>&1
  sleep 2.5
  EVAL=$(timeout 30 agent-browser eval "(()=>{try{const h1=document.querySelector('h1');const file=document.querySelector('input[type=file]');const btns=Array.from(document.querySelectorAll('button')).map(b=>(b.textContent||'').trim()).filter(Boolean);const txt=document.body.innerText;return JSON.stringify({h1:h1?h1.textContent.trim().slice(0,60):null,fileInput:!!file,btnCount:btns.length,txtLen:txt.length,errBoundary:/application error|something went wrong/i.test(txt)})}catch(e){return JSON.stringify({evalErr:String(e).slice(0,80)})}})()" 2>&1 | tail -1)
  PERR=$(timeout 20 agent-browser errors 2>&1 | head -c 300 | tr '\n' ' ')
  CERR=$(timeout 20 agent-browser console 2>&1 | rg -i "error|warn" | head -3 | tr '\n' ' ' | head -c 300)
  echo "{\"id\":\"$id\",\"state\":${EVAL:-null},\"pageErrors\":\"${PERR//\"/'}\" ,\"console\":\"${CERR//\"/'}\"}" >> "$OUT"
  echo "done: $id"
done
echo "SWEEP CHUNK COMPLETE ($START-$END)"
