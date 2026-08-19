var H = require('./mod.js');
var fails = 0, passes = 0;
function ok(name, cond, extra) {
  if (cond) { passes++; console.log('  PASS  ' + name); }
  else { fails++; console.log('  FAIL  ' + name + (extra ? '  -> ' + extra : '')); }
}
function head(s) { return s.length > 60 ? s.slice(0, 60) + '…' : s; }

/* A body of realistic prose so deltas behave like real edits. */
function prose(n, salt) {
  var out = [];
  for (var i = 0; i < n; i++) {
    out.push('## Section ' + i + ' (' + salt + ')\n\nThe quick brown fox jumps over the lazy dog, ' +
             'and then writes ' + (i * 7919 % 977) + ' words about it before stopping to think.\n');
  }
  return out.join('\n');
}

function useDoc(dir, name) { H.state.docDir = dir; H.state.fileName = name; }
function type(text) { H.state.text = text; }
function tick(ms) { H.CLOCK.now += ms; }

/* ------------------------------------------------------------------ */
console.log('\n1. the reported case: three documents each holding a full-document delta');
/* A full-document delta is what you get when the text is replaced wholesale:
   histDelta finds no common prefix or suffix, so m is a whole second copy. */
H.reset();
H.setLimits(170000, 3, 60);          /* the original ceiling, to reproduce it */
var big = prose(120, 'a');           /* ~30KB */
console.log('   document size ' + big.length + ' bytes, ceiling ' + H.limits().BYTES);
['/one', '/two', '/three'].forEach(function (dir, i) {
  useDoc(dir, 'doc.md');
  type(big + '\n<!-- ' + i + ' -->');
  tick(60000); H.histSnapshot(true);
  type(prose(120, 'z' + i));         /* wholesale replacement -> full delta */
  tick(60000); H.histSnapshot(true);
});
var b1 = H.histBytes();
console.log('   store is ' + b1 + ' bytes across ' + Object.keys(H.docs()).length + ' documents');
ok('store is within the 170KB ceiling', b1 <= 170000, b1 + ' > 170000');
ok('the current document still has history', H.docs()[H.key()] != null);

/* ------------------------------------------------------------------ */
console.log('\n2. a single document larger than the whole ceiling');
H.reset();
H.setLimits(170000, 3, 60);
useDoc('/solo', 'huge.md');
var huge = prose(900, 'h');          /* ~230KB, bigger than the ceiling itself */
console.log('   document size ' + huge.length + ' bytes');
type(huge); tick(60000); H.histSnapshot(true);
type(huge + '\nappended'); tick(60000); H.histSnapshot(true);
var b2 = H.histBytes();
console.log('   store is ' + b2 + ' bytes');
ok('ceiling holds even when one document exceeds it alone', b2 <= 170000, b2 + ' > 170000');

/* ------------------------------------------------------------------ */
console.log('\n3. the delta chain still reconstructs after thinning');
H.reset();
H.setLimits(40000, 3, 60);           /* tight, to force heavy thinning */
useDoc('/chain', 'doc.md');
var recorded = {};                   /* timestamp -> exact text at that moment */
var text = prose(8, 'c');
type(text); tick(30000); H.histSnapshot(true);
recorded[H.docs()[H.key()].t] = text;
for (var i = 0; i < 220; i++) {
  /* an edit somewhere in the middle, like real typing */
  var cut = Math.floor(text.length * ((i * 37 % 100) / 100));
  text = text.slice(0, cut) + 'edit#' + i + ' ' + text.slice(cut);
  type(text);
  tick(20000 + (i % 5) * 4000);
  H.histSnapshot(true);
  recorded[H.docs()[H.key()].t] = text;
}
var d = H.docs()[H.key()];
console.log('   ' + (d.back.length + 1) + ' snapshots survived of 221 taken, ' + H.histBytes() + ' bytes');
ok('ceiling holds under sustained editing', H.histBytes() <= 40000, H.histBytes() + ' > 40000');
ok('head is the current text', d.head === text);

var bad = null;
for (var j = 0; j < d.back.length; j++) {
  var rebuilt = H.histAt(d, j), want = recorded[d.back[j].t];
  if (want === undefined) { bad = 'entry ' + j + ' has a timestamp never recorded'; break; }
  if (rebuilt !== want) {
    bad = 'entry ' + j + ' rebuilt ' + rebuilt.length + ' bytes, expected ' + want.length;
    break;
  }
}
ok('every surviving snapshot reconstructs byte-for-byte', bad === null, bad);

/* thinning should keep recent history denser than distant history */
var gaps = [];
for (var g = 0; g < d.back.length - 1; g++) gaps.push(d.back[g].t - d.back[g + 1].t);
var recent = gaps.slice(0, Math.floor(gaps.length / 3));
var distant = gaps.slice(-Math.floor(gaps.length / 3));
var avg = function (a) { return a.reduce(function (x, y) { return x + y; }, 0) / a.length; };
console.log('   mean gap: recent ' + Math.round(avg(recent) / 1000) + 's, distant ' +
            Math.round(avg(distant) / 1000) + 's');
ok('recent history is denser than distant history', avg(recent) < avg(distant));

/* ------------------------------------------------------------------ */
console.log('\n4. the document cap');
H.reset();
H.setLimits(4000000, 3, 60);
for (var k = 0; k < 9; k++) {
  useDoc('/d' + k, 'doc.md');
  type('document number ' + k + '\n' + prose(3, 'k' + k));
  tick(60000); H.histSnapshot(true);
  type('document number ' + k + ' edited\n' + prose(3, 'k' + k));
  tick(60000); H.histSnapshot(true);
}
ok('never remembers more than HIST_DOCS documents',
   Object.keys(H.docs()).length <= 3, Object.keys(H.docs()).length + ' documents');
ok('the document on screen survived the cull', H.docs()[H.key()] != null);

console.log('\n' + passes + ' passed, ' + fails + ' failed\n');
process.exit(fails ? 1 : 0);
