/* The two shapes the user reported, run against whichever module is passed in.
   Documents are sized so the store is genuinely forced past the ceiling. */
var which = process.argv[2] || './mod.js';
var H = require(which);
var label = which.indexOf('old') >= 0 ? 'BEFORE' : 'AFTER ';

function prose(n, salt) {
  var out = [];
  for (var i = 0; i < n; i++) {
    out.push('## Section ' + i + ' (' + salt + ')\n\nThe quick brown fox jumps over the lazy dog, ' +
             'and then writes ' + (i * 7919 % 977) + ' words about it before stopping to think.\n');
  }
  return out.join('\n');
}
function useDoc(d, n) { H.state.docDir = d; H.state.fileName = n; }

var CEILING = 170000;
var results = [];

/* A: three documents, each holding one full-document delta. */
H.reset();
if (H.setLimits) H.setLimits(CEILING, 3, 60);
var doc = prose(400, 'a');                   /* ~50KB each */
['/one', '/two', '/three'].forEach(function (dir, i) {
  useDoc(dir, 'doc.md');
  H.state.text = doc + '\n<!-- ' + i + ' -->';
  H.CLOCK.now += 60000; H.histSnapshot(true);
  H.state.text = prose(400, 'z' + i);        /* wholesale replacement */
  H.CLOCK.now += 60000; H.histSnapshot(true);
});
results.push(['three documents x full-document delta', doc.length, H.histBytes()]);

/* B: one document bigger than the ceiling on its own. */
H.reset();
if (H.setLimits) H.setLimits(CEILING, 3, 60);
useDoc('/solo', 'huge.md');
var huge = prose(1600, 'h');                 /* ~200KB */
H.state.text = huge;
H.CLOCK.now += 60000; H.histSnapshot(true);
H.state.text = huge + '\nappended';
H.CLOCK.now += 60000; H.histSnapshot(true);
results.push(['one document larger than the ceiling', huge.length, H.histBytes()]);

/* C: three documents, two snapshots each — under the count histDropOne needs. */
H.reset();
if (H.setLimits) H.setLimits(CEILING, 3, 60);
['/p', '/q', '/r'].forEach(function (dir, i) {
  useDoc(dir, 'doc.md');
  H.state.text = prose(300, 'c' + i);
  H.CLOCK.now += 60000; H.histSnapshot(true);
  H.state.text = prose(300, 'c' + i) + '\ntail';
  H.CLOCK.now += 60000; H.histSnapshot(true);
});
results.push(['three short chains, large documents', prose(300, 'x').length, H.histBytes()]);

results.forEach(function (r) {
  var over = r[2] > CEILING;
  console.log(label + ' | ' + (over ? 'OVER  ' : 'within') + ' | ' +
              String(r[2]).padStart(8) + ' / ' + CEILING + ' bytes | ' + r[0]);
});
process.exit(results.some(function (r) { return r[2] > CEILING; }) ? 1 : 0);
