#!/usr/bin/env python3
"""Merge make-pdf-fillable i18n keys into en.json + hi.json."""
import json

with open("tools/make-pdf-fillable/i18n.json", "r", encoding="utf-8") as f:
    bundle = json.load(f)

for lang in ("en", "hi"):
    path = f"src/i18n/{lang}.json"
    with open(path, "r", encoding="utf-8") as f:
        data = json.load(f)
    section = bundle[lang]["makeFillable"]
    assert "makeFillable" not in data, f"makeFillable already exists in {lang}"
    # Insert after flatten (alphabetical-ish placement near other tool sections)
    new_data = {}
    inserted = False
    for k, v in data.items():
        if k > "makeFillable" and not inserted:
            new_data["makeFillable"] = section
            inserted = True
        new_data[k] = v
    if not inserted:
        new_data["makeFillable"] = section
    with open(path, "w", encoding="utf-8") as f:
        json.dump(new_data, f, ensure_ascii=False, indent=2)
        f.write("\n")
    print(f"{lang}: +{len(section)} keys -> {path}")

# Parity check
with open("src/i18n/en.json", encoding="utf-8") as f:
    en = json.load(f)
with open("src/i18n/hi.json", encoding="utf-8") as f:
    hi = json.load(f)

def count_leaves(d):
    n = 0
    for v in d.values():
        if isinstance(v, dict):
            n += count_leaves(v)
        else:
            n += 1
    return n

print(f"en={count_leaves(en)} hi={count_leaves(hi)} parity={'OK' if count_leaves(en) == count_leaves(hi) else 'MISMATCH'}")
