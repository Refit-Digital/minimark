/* Ports uniqueImageName + sanitiseFileBase from the Swift so the naming rules
   can be exercised against a real filesystem. If these diverge from the Swift
   the test is worthless, so they are transcribed line for line. */
var fs = require('fs'), path = require('path');

function sanitiseFileBase(s) {
  var ok = /[a-zA-Z0-9\-_]/;
  var cleaned = s.split('').map(function (c) { return ok.test(c) ? c : '-'; }).join('');
  var trimmed = cleaned.replace(/^-+/, '').replace(/-+$/, '');
  return trimmed === '' ? 'image' : trimmed;
}
function uniqueImageName(base, ext, dir) {
  var name = base + '.' + ext, n = 2;
  while (fs.existsSync(path.join(dir, name))) { name = base + '-' + n + '.' + ext; n += 1; }
  return name;
}

var fails = 0, passes = 0;
function ok(n, c, x) { if (c) { passes++; console.log('  PASS  ' + n); } else { fails++; console.log('  FAIL  ' + n + (x ? '  -> ' + x : '')); } }

var dir = '/tmp/imgtest/docfolder';
fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true });

console.log('\nfilename sanitising');
ok('spaces and punctuation become hyphens',
   sanitiseFileBase('My Holiday Photo (2).final') === 'My-Holiday-Photo--2--final',
   sanitiseFileBase('My Holiday Photo (2).final'));
ok('a name of pure punctuation falls back',
   sanitiseFileBase('!!!') === 'image', sanitiseFileBase('!!!'));
ok('leading and trailing hyphens are trimmed',
   sanitiseFileBase('  edge  ') === 'edge', sanitiseFileBase('  edge  '));
ok('unicode is replaced rather than passed through',
   sanitiseFileBase('café☕') === 'caf', sanitiseFileBase('café☕'));

console.log('\ncollisions never overwrite');
var got = [];
for (var i = 0; i < 4; i++) {
  var n = uniqueImageName('diagram', 'png', dir);
  fs.writeFileSync(path.join(dir, n), 'x');
  got.push(n);
}
ok('four drops of diagram.png give four distinct files',
   JSON.stringify(got) === JSON.stringify(['diagram.png','diagram-2.png','diagram-3.png','diagram-4.png']),
   got.join(', '));
ok('and all four are on disk', fs.readdirSync(dir).length === 4);

console.log('\nan existing unrelated file is not disturbed');
fs.writeFileSync(path.join(dir, 'notes.md'), '# hi');
var n2 = uniqueImageName('notes', 'png', dir);
ok('same stem, different extension, no collision', n2 === 'notes.png', n2);
ok('the markdown file still has its contents',
   fs.readFileSync(path.join(dir, 'notes.md'), 'utf8') === '# hi');

console.log('\n' + passes + ' passed, ' + fails + ' failed\n');
process.exit(fails ? 1 : 0);
