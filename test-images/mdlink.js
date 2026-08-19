var fs = require('fs');
var src = fs.readFileSync('/sessions/epic-zen-hopper/mnt/minimark/minimark.app/Contents/Resources/ui.js','utf8');
var s = src.indexOf('  function mdDestination(p)');
var e = src.indexOf('  function humanSpan(ms)');
var mdDestination = new Function(src.slice(s, e) + '; return mdDestination;')();

var fails = 0, passes = 0;
function ok(n, c, x) { if (c) { passes++; console.log('  PASS  ' + n); } else { fails++; console.log('  FAIL  ' + n + (x ? '  -> ' + x : '')); } }

/* marked's inline-link grammar: ![alt](dest) where a bare dest ends at the
   first space or unbalanced paren, and <dest> runs to the closing angle. */
function parses(md) {
  var m = /^!\[\]\((?:<([^>]*)>|([^\s()]*))\)$/.exec(md);
  return m ? (m[1] !== undefined ? m[1] : m[2]) : null;
}
function roundTrip(name) { return parses('![](' + mdDestination(name) + ')'); }

console.log('\nfilenames that must survive into a working link');
[['simple.png', 'simple.png'],
 ['Screen Shot 2026-08-07 at 14.02.png', 'Screen Shot 2026-08-07 at 14.02.png'],
 ['photo (1).png', 'photo (1).png'],
 ['a-b_c.99.png', 'a-b_c.99.png'],
 ['mixed (2) copy.jpeg', 'mixed (2) copy.jpeg']
].forEach(function (c) {
  var got = roundTrip(c[0]);
  ok('"' + c[0] + '" parses back intact', got === c[1], JSON.stringify(got));
});

console.log('\nangle brackets are only used where needed');
ok('a plain name is left bare', mdDestination('simple.png') === 'simple.png', mdDestination('simple.png'));
ok('a spaced name is wrapped', mdDestination('a b.png') === '<a b.png>', mdDestination('a b.png'));

console.log('\nnames containing angle brackets cannot be wrapped, so are encoded');
var weird = 'a<b>c.png';
var d = mdDestination(weird);
ok('no raw angle bracket survives', !/[<>]/.test(d.replace(/^<|>$/g,'')) || d.indexOf('%3C') >= 0, d);
ok('and it still parses as a link', roundTrip(weird) !== null, JSON.stringify(roundTrip(weird)));

console.log('\n' + passes + ' passed, ' + fails + ' failed\n');
process.exit(fails ? 1 : 0);
