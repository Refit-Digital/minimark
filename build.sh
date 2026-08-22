#!/usr/bin/env bash
#
#  minimark — build
#
#  One command, no arguments. Compiles both architectures, lips them into a
#  universal binary, and produces two things from it:
#
#    minimark.app        the bundle in this repo, for working in. Its
#                        Resources are the real files, so an edit to app.js
#                        or styles.css shows up on the next launch without
#                        rebuilding anything.
#    build/minimark.app  a self-contained copy, for zipping and shipping.
#
#  Neither is committed: .gitignore covers the binary, the signature and
#  build/. This script is what makes a fresh clone runnable.
#
set -euo pipefail

cd "$(dirname "$0")"

APP="minimark.app"
OUT="build/minimark.app"
DEPLOY="13.0"
BIN="$(mktemp -d)/minimark"
trap 'rm -rf "$(dirname "$BIN")"' EXIT

command -v swiftc >/dev/null || {
  echo "swiftc not found. Install the Xcode command line tools:" >&2
  echo "    xcode-select --install" >&2
  exit 1
}

# ---------------------------------------------------------------- compile
#
# Two slices and a lipo, rather than one -target. A single arm64 build will
# not launch at all on an Intel Mac — not slowly, not under Rosetta, not at
# all — and the failure looks to the person downloading it like a broken app
# rather than a wrong architecture.
#
echo "compiling arm64…"
swiftc -O -target "arm64-apple-macos$DEPLOY"  minimark.swift -o "$BIN.arm64"
echo "compiling x86_64…"
swiftc -O -target "x86_64-apple-macos$DEPLOY" minimark.swift -o "$BIN.x86_64"
lipo -create "$BIN.arm64" "$BIN.x86_64" -output "$BIN"

# --------------------------------------------------------------- assemble
#
# Move the binary into place rather than copying over it. cp overwrites the
# file the running app is executing from, which invalidates its signature
# under it and can take the app down mid-edit; mv replaces the directory
# entry and leaves the running process holding the old inode, which is what
# lets you rebuild without quitting first. The new binary is picked up on the
# next launch.
#
mkdir -p "$APP/Contents/MacOS"
cp "$BIN" "$APP/Contents/MacOS/.minimark.new"
mv -f "$APP/Contents/MacOS/.minimark.new" "$APP/Contents/MacOS/minimark"

rm -rf build
mkdir -p "$OUT/Contents/MacOS"
cp "$APP/Contents/Info.plist" "$OUT/Contents/Info.plist"
cp "$APP/Contents/PkgInfo"    "$OUT/Contents/PkgInfo"
cp -R "$APP/Contents/Resources" "$OUT/Contents/Resources"
cp "$BIN" "$OUT/Contents/MacOS/minimark"
find "$OUT" -name .DS_Store -delete

# ------------------------------------------------------------------- sign
#
# The ad-hoc signature is load-bearing and must not be tidied away. Since
# macOS 15.1 a genuinely *unsigned* app is refused outright — "The application
# does not have permission to open" — with no override anywhere in the system.
# An ad-hoc signed app is still signed, just not with a Developer ID, so it
# keeps the Open Anyway path in System Settings › Privacy & Security.
#
# Signing happens last, because the seal covers Resources: sign before copying
# them and the bundle is broken. There is no nested code here — no frameworks,
# no helpers — so one call per bundle is already inside-out, and --deep, which
# the old recipe used, is deprecated and does the wrong thing besides.
#
#
# Extended attributes have to go first. codesign refuses a bundle carrying
# com.apple.FinderInfo or a resource fork: "resource fork, Finder information,
# or similar detritus not allowed". They hold nothing the app needs.
#
# Clearing them and signing is a race, not a step. If the repo lives anywhere
# iCloud Drive syncs — and Desktop and Documents are synced by default — the
# file provider re-stamps the bundle within moments of anything inside it
# changing, which is exactly what this script just did. Losing that race once
# is ordinary. Losing it three times means something else is wrong, and then
# the attributes it choked on are worth seeing.
#
sign() {
  local target="$1" try
  for try in 1 2 3; do
    xattr -cr "$target" 2>/dev/null || true
    if codesign --force --sign - "$target" 2>/dev/null; then return 0; fi
    sleep 1
  done
  echo "codesign failed on $target after three attempts. Attributes present:" >&2
  xattr -lr "$target" >&2
  return 1
}

echo "signing…"
sign "$APP"
sign "$OUT"
codesign --verify --strict "$OUT"

echo
echo "  $APP        $(file -b "$APP/Contents/MacOS/minimark" | head -1)"
echo "  $OUT  ready to zip"
echo
echo "run it:    open $APP"
echo "test it:   cd tools && npm install --include=dev && npm test"
