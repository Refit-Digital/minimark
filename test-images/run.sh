#!/bin/bash
# Image insertion tests. Extracts the real functions out of app.js / ui.js and
# runs them headless, so they cannot drift from the shipped code.
#
# Needs jsdom:  npm install jsdom
#
cd "$(dirname "$0")"
[ -d node_modules/jsdom ] || npm install --silent jsdom || {
  echo "jsdom missing: run  npm install jsdom  in $(pwd)"; exit 1; }
node names.js && node fiximages.js && node mdlink.js && node insert.js
