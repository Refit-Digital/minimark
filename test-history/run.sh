#!/bin/bash
# Extracts the version-history module out of app.js and drives it headless
# under node. No browser, no app bundle — the module only touches state.text,
# docText(), send() and setText(), all of which the harnesses stand in for.
#
#   ./run.sh
#
cd "$(dirname "$0")"
python3 - <<'PY'
h = open('harness2.js').read()
m = open('../minimark.app/Contents/Resources/app.js').read()
s = m.index('/* ---------------- version history ----------------')
e = m.index("/* ---------------- block-level formatting ---------------- */")
open('mod.js','w').write(h.replace('HISTMODULE', m[s:e]))
PY
node test.js && node review.js && node adversarial.js ./mod.js
