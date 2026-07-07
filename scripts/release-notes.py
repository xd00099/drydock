#!/usr/bin/env python3
"""Print the CHANGELOG.md section for one version. CI uses the output as the
GitHub release body and the updater manifest's `notes`, and fails the release
early when the section is missing — release notes are mandatory.

Usage:  release-notes.py 0.2.1    (a leading `v` is tolerated)
"""
import re
import sys

if len(sys.argv) != 2:
    sys.exit("usage: release-notes.py <version>")
v = sys.argv[1].lstrip("vV")

try:
    with open("CHANGELOG.md", encoding="utf-8") as f:
        text = f.read()
except FileNotFoundError:
    sys.exit("CHANGELOG.md not found — add release notes before tagging")

# A section runs from its `## vX.Y.Z` heading to the next `## v` or EOF.
m = re.search(rf"^## v{re.escape(v)}\b[^\n]*\n(.*?)(?=^## v|\Z)", text, re.M | re.S)
if not m or not m.group(1).strip():
    sys.exit(f"CHANGELOG.md has no notes for v{v} — add a '## v{v}' section")
print(m.group(1).strip())
