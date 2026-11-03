#!/bin/sh
# Publish the built arranger-st10.html to GitHub Pages: commits it as index.html
# (plus .nojekyll) onto the gh-pages branch and pushes it to origin.
# Run `python3 build.py` first. The working tree is not touched.
set -e
cd "$(dirname "$0")/.."
src=$(git rev-parse HEAD)
html=$(git hash-object -w arranger-st10.html)
empty=$(git hash-object -w /dev/null)
tree=$(printf '100644 blob %s\t.nojekyll\n100644 blob %s\tindex.html\n' "$empty" "$html" | git mktree)
parent=$(git rev-parse -q --verify refs/heads/gh-pages || true)
if [ -n "$parent" ] && [ "$(git rev-parse "$parent^{tree}")" = "$tree" ]; then
  echo "gh-pages already up to date"
else
  commit=$(git commit-tree "$tree" ${parent:+-p "$parent"} -m "Publish $(git rev-parse --short "$src")")
  git update-ref refs/heads/gh-pages "$commit"
fi
git push origin gh-pages
