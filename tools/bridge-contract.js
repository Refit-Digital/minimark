#!/usr/bin/env node
/* ============================================================
   minimark — bridge contract check

   Nothing else checks that the two halves of the app agree. Every message
   between them is a string matched at runtime: a JS `send('tabNew')` with no
   matching `case "tabNew"` in the Swift switch does nothing at all and says
   nothing about it, and a Swift `js("App.showTab(...)")` naming a function
   that was renamed is a silent TypeError inside evaluateJavaScript.

   This greps both sides and diffs the two sets. It is deliberately crude —
   regexes over source, no parser — because the alternative is nothing.

   Usage:  node tools/bridge-contract.js [resourcesDir] [swiftFile]
   ============================================================ */

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');

/* The web layer lives inside the app bundle in the repo, and beside this
   folder in a scratch copy. Take whichever is actually there rather than
   making every caller pass a path. */
function findResources(explicit) {
  if (explicit) return path.resolve(explicit);
  const root = path.resolve(__dirname, '..');
  const candidates = [
    path.join(root, 'minimark.app', 'Contents', 'Resources'),
    path.join(root, 'Resources')
  ];
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, 'index.html'))) return dir;
  }
  throw new Error('could not find the web layer. Looked in:\n  ' + candidates.join('\n  '));
}

const resDir = findResources(process.argv[2]);
const swiftFile = process.argv[3] || path.join(root, 'minimark.swift');

const read = f => fs.readFileSync(f, 'utf8');

const uniq = a => Array.from(new Set(a)).sort();
const all = (src, re, g = 1) => {
  const out = [];
  let m;
  while ((m = re.exec(src))) out.push(m[g]);
  return uniq(out);
};

/* Every script the page loads that is ours, taken from index.html rather than
   listed here. The list was hardcoded as app.js and ui.js, which meant a new
   file joining the web layer was silently outside the contract — the one
   thing this tool exists to stop. vendor/ is excluded: nothing in there talks
   over the bridge, and marked alone would double the size of the scan. */
const ours = (() => {
  const found = all(read(path.join(resDir, 'index.html')), /<script\s+src="([^"]+)"/g)
    .filter(s => !s.startsWith('vendor/') && !/^https?:/.test(s));
  if (!found.length) throw new Error('bridge-contract: no scripts found in index.html');
  return found;
})();
const js = ours.map(f => read(path.join(resDir, f))).join('\n');
const swift = read(swiftFile);

/* ---- web to native ------------------------------------------------------
   send('type', {...}) in the page, against `case "type":` in the switch. */
const sent = all(js, /\bsend\(\s*'([A-Za-z][\w]*)'/g);
/* Scoped to the message handler. The file has other string switches —
   runMenuAction, the command names — and folding them in here would make an
   unhandled message look handled, which is the one answer this must not give. */
const handler = (() => {
  const at = swift.indexOf('func userContentController(');
  if (at < 0) throw new Error('bridge-contract: no userContentController in the Swift');
  const end = swift.indexOf('\n    func ', at + 10);
  return swift.slice(at, end < 0 ? swift.length : end);
})();
const cases = all(handler, /^\s*case\s+"([A-Za-z][\w]*)":/gm);

/* ---- native to web ------------------------------------------------------
   App.name( inside a js("…") or evaluateJavaScript("…") string, against the
   keys of the window.App object literal in ui.js. Guard names (App&&App.x)
   collapse to the same set, which is the point. */
const called = all(swift, /\bApp\.([A-Za-z][\w]*)\s*\(/g);
const appBlock = (() => {
  const at = js.indexOf('window.App = {');
  if (at < 0) return '';
  /* to the end of the file is fine: nothing after it declares a key at this
     indentation, and over-reading only ever makes this check laxer, never
     wrong in the direction that matters */
  return js.slice(at);
})();
const defined = uniq([
  ...all(appBlock, /^\s{4}([A-Za-z][\w]*)\s*:/gm),
  ...all(js, /window\.App\.([A-Za-z][\w]*)\s*=/g)
]);

/* ---- prefs --------------------------------------------------------------
   Any key the page persists has to be in kPrefKeys or the shell drops it on
   the floor, and the setting silently stops surviving a relaunch. */
const prefsSent = all(js, /send\(\s*'pref'\s*,\s*\{\s*key\s*:\s*'([\w]+)'/g);
const prefKeys = (() => {
  const m = /let kPrefKeys = \[([\s\S]*?)\]/.exec(swift);
  return m ? uniq(all(m[1], /"([\w]+)"/g)) : [];
})();

/* ---- App.command names --------------------------------------------------
   Menu items carry a command name as representedObject; the page looks it up
   in a map. A typo either way is a menu item that does nothing. */
const cmdSent = all(swift, /command:\s*"([\w]+)"/g)
  .concat(all(swift, /\bcommand\(\s*"([\w]+)"\s*\)/g));
const cmdMap = (() => {
  const at = js.indexOf('command: function (name) {');
  if (at < 0) return [];
  const chunk = js.slice(at, at + 4000);
  return uniq([
    ...all(chunk, /^\s{8}([A-Za-z][\w]*)\s*:/gm),
    /* the restore steps are generated from a table rather than written out */
    ...all(js, /map\['restore' \+ s\.id\]/g).length
      ? all(js, /\{\s*id:\s*'(\w+)',\s*ms:/g).map(id => 'restore' + id)
      : []
  ]);
})();

let failures = 0;
function report(title, missing, note) {
  if (!missing.length) {
    console.log(`  ok    ${title}`);
    return;
  }
  failures += missing.length;
  console.log(`  FAIL  ${title}`);
  console.log(`        ${note}`);
  missing.forEach(m => console.log(`          - ${m}`));
}

console.log('bridge contract\n');
report('every send() type has a Swift case',
  sent.filter(t => !cases.includes(t)),
  'the page posts these and the shell ignores them:');
report('every App.x() the shell calls exists',
  called.filter(n => !defined.includes(n)),
  'the shell evaluates these and the page has no such function:');
report('every persisted pref is in kPrefKeys',
  prefsSent.filter(k => !prefKeys.includes(k)),
  'the page saves these and the shell drops them:');
report('every menu command name is in the command map',
  uniq(cmdSent).filter(n => !cmdMap.includes(n)),
  'menu items send these and the page does nothing with them:');

/* Unused in the other direction is worth knowing about but is not a failure:
   the shell legitimately defines cases for messages an older page sent, and
   the page legitimately exposes functions for a shell that has not caught up. */
const orphanCases = cases.filter(c => !sent.includes(c));
if (orphanCases.length) {
  console.log(`\n  note  Swift cases nothing sends: ${orphanCases.join(', ')}`);
}

console.log('');
if (failures) {
  console.log(`${failures} contract mismatch(es)`);
  process.exit(1);
}
console.log('contract holds');
