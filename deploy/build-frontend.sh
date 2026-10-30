#!/bin/sh
# Step 53: frontend deploy without a gap. `npm run build` empties the live
# frontend/dist that nginx serves, so pages could 404 for a moment. Build into
# dist-new, keep the previous build's assets (tabs still on the old page can
# load them; older than 14 days are dropped), then swap the folders.
set -e
cd "$(dirname "$0")/../frontend"
rm -rf dist-new dist-old
npm run build -- --outDir dist-new --emptyOutDir
if [ -d dist/assets ]; then
    cp -rpn dist/assets/. dist-new/assets/ 2>/dev/null || true
    find dist-new/assets -type f -mtime +14 -delete 2>/dev/null || true
fi
if [ -d dist ]; then
    mv dist dist-old
fi
mv dist-new dist
rm -rf dist-old
echo "frontend: new build live ($(ls dist/assets | grep -c '^index-.*\.js$') index bundle(s) kept)"
