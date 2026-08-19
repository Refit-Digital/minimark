var H = require('./mod.js');
var fails = 0, passes = 0;
function ok(n, c, x) { if (c) { passes++; console.log('  PASS  ' + n); } else { fails++; console.log('  FAIL  ' + n + (x ? '  -> ' + x : '')); } }
function prose(n, salt) {
  var o = [];
  for (var i = 0; i < n; i++) o.push('## S' + i + ' (' + salt + ')\n\nThe quick brown fox jumps over the lazy dog ' + (i * 7919 % 977) + '.\n');
  return o.join('\n');
}
function use(d, n) { H.state.docDir = d; H.state.fileName = n; }
function writes() { return H.sent.filter(function (s) { return s.type === 'histWrite'; }); }

console.log('\n#1  histCapped must not be stamped on a document that was merely never seen');
H.reset();
/* the shell delivers setHistory during handleReady, BEFORE loadDoc: at this
   point histKey() is still the untitled placeholder */
use('', 'Untitled.md');
H.histLoad(JSON.stringify({ docs: { '/notes/real.md': { head: 'hello', t: 1, back: [], seen: 1 } } }));
ok('a freshly loaded store leaves capped unset', H.capped() === null, String(H.capped()));
ok('the picker does not claim the document is too large', H.histStats().capped === false);

console.log('\n#2  an app-switch on an untouched document must cost nothing');
H.reset();
use('/notes', 'a.md'); H.state.text = prose(5, 'a');
H.CLOCK.now += 60000; H.histSnapshot(true);
H.histFlush();
var n0 = writes().length;
var c1 = H.histCommit(), c2 = H.histCommit(), c3 = H.histCommit();
ok('histCommit returns null when nothing changed', c1 === null && c2 === null && c3 === null);
ok('and sends nothing', writes().length === n0);

console.log('\n#3  quit must pin the present, not just serialise what the 20s tick caught');
H.reset();
use('/notes', 'b.md'); H.state.text = 'first';
H.CLOCK.now += 60000; H.histSnapshot(true); H.histFlush();
H.CLOCK.now += 3000;                    /* well inside the 20s throttle */
H.state.text = 'first, plus a sentence written just before quitting';
var dump = H.histCommit();
ok('histCommit returns a store', dump !== null);
var parsed = dump ? JSON.parse(dump) : { docs: {} };
var d3 = parsed.docs[H.key()];
ok('the last edit is in the persisted head', d3 && d3.head === H.state.text,
   d3 ? JSON.stringify(d3.head) : 'no document');

console.log('\n#4  a failed send must leave the store dirty for a retry');
H.reset();
use('/notes', 'c.md'); H.state.text = 'x';
H.CLOCK.now += 60000; H.histSnapshot(true);
H.breakBridge(true);
H.histFlush();
ok('nothing was sent while the bridge was down', writes().length === 0);
H.breakBridge(false);
H.histFlush();
ok('the retry after the bridge returns does send', writes().length === 1);

console.log('\n#5  an eviction down to an empty store must be persistable');
H.reset();
H.setLimits(2000, 3, 60);               /* smaller than any real document */
use('/notes', 'huge.md'); H.state.text = prose(80, 'h');
H.CLOCK.now += 60000; H.histSnapshot(true);
H.state.text = prose(80, 'h') + '\nmore';
H.CLOCK.now += 60000; H.histSnapshot(true);
ok('the store really did empty', Object.keys(H.docs()).length === 0);
H.histFlush();
var w5 = writes();
ok('the empty store was written rather than skipped', w5.length > 0);
ok('and it is a valid empty store, not an empty string',
   w5.length > 0 && w5[w5.length - 1].payload.json === '{"docs":{}}',
   w5.length ? JSON.stringify(w5[w5.length - 1].payload.json) : 'nothing sent');
ok('capped is set, so the picker can explain itself', H.histStats().capped === true);

console.log('\n#6  a malformed sidecar must not stop the document opening');
H.reset(); H.setLimits(2000000, 8, 60);
use('/notes', 'd.md');
H.histLoad(JSON.stringify({ docs: {
  '/notes/good.md': { head: 'fine', t: 5, back: [], seen: 5 },
  '/notes/nobck.md': { head: 'no back array', t: 5, seen: 5 },
  '/notes/badentry.md': { head: 'x', t: 5, seen: 5, back: [{ t: 4, p: 0 }] },
  '/notes/nothead.md': { head: 42, t: 5, seen: 5, back: [] }
} }));
ok('the good document survived', H.docs()['/notes/good.md'] != null);
ok('the three malformed ones were dropped', Object.keys(H.docs()).length === 1,
   Object.keys(H.docs()).join(', '));
var threw = false;
try { H.state.text = 'typing into the freshly opened document'; H.CLOCK.now += 60000; H.histSnapshot(true); }
catch (e) { threw = true; }
ok('and a snapshot afterwards does not throw', !threw);

console.log('\n#7  the budget defers, it does not destroy — and a write is always compliant');
H.reset(); H.setLimits(40000, 3, 60);
use('/notes', 'e.md');
var t = prose(6, 'e');
H.state.text = t; H.CLOCK.now += 30000; H.histSnapshot(true);
for (var i = 0; i < 260; i++) {
  var cut = Math.floor(t.length * ((i * 37 % 100) / 100));
  t = t.slice(0, cut) + 'edit#' + i + ' ' + t.slice(cut);
  H.state.text = t; H.CLOCK.now += 21000; H.histSnapshot(true);
}
ok('history survived a long session rather than being collapsed',
   H.docs()[H.key()].back.length > 5, H.docs()[H.key()].back.length + ' snapshots');
H.histFlush();
var last = writes()[writes().length - 1];
ok('what actually got written is within the ceiling',
   last && last.payload.json.length <= 40000,
   last ? last.payload.json.length + ' bytes' : 'nothing sent');

console.log('\n#8  opening documents without editing them must not pile up entries');
H.reset(); H.setLimits(2000000, 8, 60);
for (var k8 = 0; k8 < 30; k8++) {
  use('/d' + k8, 'doc.md');
  H.state.text = 'contents of document ' + k8;
  H.CLOCK.now += 60000;
  H.histSnapshot(true);                 /* what App.loadDoc does */
}
ok('the document cap applies to merely-opened documents too',
   Object.keys(H.docs()).length <= 8, Object.keys(H.docs()).length + ' entries');
ok('the document on screen is one of them', H.docs()[H.key()] != null);

console.log('\n' + passes + ' passed, ' + fails + ' failed\n');
process.exit(fails ? 1 : 0);
