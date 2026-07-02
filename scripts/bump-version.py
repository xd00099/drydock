#!/usr/bin/env python3
"""Sync the app version across the three places it lives, in lockstep:
package.json, src-tauri/tauri.conf.json, src-tauri/Cargo.toml.

Usage:  python3 scripts/bump-version.py 0.2.0
Then:   commit, tag v0.2.0, push the tag — CI builds and publishes the release.
"""
import re
import sys

if len(sys.argv) != 2 or not re.fullmatch(r"\d+\.\d+\.\d+", sys.argv[1]):
    sys.exit("usage: bump-version.py <X.Y.Z>")
v = sys.argv[1]

# Surgical replacement of the version field only — no reformatting churn.
# In all three files the FIRST version field is the app's own.
EDITS = (
    ("package.json", r'"version": "[^"]+"', f'"version": "{v}"'),
    ("src-tauri/tauri.conf.json", r'"version": "[^"]+"', f'"version": "{v}"'),
    ("src-tauri/Cargo.toml", r'^version = "[^"]+"', f'version = "{v}"'),
)
for path, pat, repl in EDITS:
    with open(path) as f:
        text = f.read()
    text, n = re.subn(pat, repl, text, count=1, flags=re.M)
    if n != 1:
        sys.exit(f"{path}: version field not found")
    with open(path, "w") as f:
        f.write(text)

print(f"version → {v}  (package.json, tauri.conf.json, src-tauri/Cargo.toml)")
print(f"next: git commit, then  git tag v{v} && git push origin v{v}")
