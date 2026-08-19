/* fixImages extracted from app.js and run against a real DOM. */
var fs = require('fs');
var { JSDOM } = require('jsdom');
var src = fs.readFileSync('/sessions/epic-zen-hopper/mnt/minimark/minimark.app/Contents/Resources/app.js','utf8');
var s = src.indexOf('  /* encodeURI leaves # and ? alone');
var e = src.indexOf('/* ---------------- blocks ----------------', s);
var body = src.slice(s, e);

var fails = 0, passes = 0;
function ok(n, c, x) { if (c) { passes++; console.log('  PASS  ' + n); } else { fails++; console.log('  FAIL  ' + n + (x ? '  -> ' + x : '')); } }

function run(html, docDir) {
  var dom = new JSDOM('<div id=r>' + html + '</div>');
  var state = { docDir: docDir };
  var fn = new Function('state', 'document', body + '; return fixImages;')(state, dom.window.document);
  fn(dom.window.document.getElementById('r'));
  return Array.prototype.map.call(
    dom.window.document.querySelectorAll('img'),
    function (i) { return i.getAttribute('src'); });
}

console.log('\nsaved document (docDir set)');
var r = run('<img src="picture.png"><img src="images/a.png"><img src="/Users/f/abs.png">' +
            '<img src="https://x.com/y.png"><img src="data:image/png;base64,AA">',
            '/Users/franco/Documents');
ok('a relative name resolves beside the document',
   r[0] === 'file:///Users/franco/Documents/picture.png', r[0]);
ok('a relative subfolder path resolves too',
   r[1] === 'file:///Users/franco/Documents/images/a.png', r[1]);
ok('an absolute path gets a file:// scheme', r[2] === 'file:///Users/f/abs.png', r[2]);
ok('a remote URL is left alone', r[3] === 'https://x.com/y.png', r[3]);
ok('a data URL is left alone', r[4] === 'data:image/png;base64,AA', r[4]);

console.log('\nunsaved document (docDir empty) — the case that was broken');
var u = run('<img src="picture.png"><img src="/Users/f/abs.png"><img src="https://x.com/y.png">', '');
ok('an absolute path still resolves with no document folder',
   u[0 + 1] === 'file:///Users/f/abs.png', u[1]);
ok('a remote URL still works', u[2] === 'https://x.com/y.png', u[2]);
ok('a relative path is left untouched rather than mangled',
   u[0] === 'picture.png', u[0]);

console.log('\nawkward paths');
var a = run('<img src="my photo.png"><img src="a&b.png">', '/Users/franco/My Docs');
ok('a space in the filename is encoded',
   a[0] === 'file:///Users/franco/My%20Docs/my%20photo.png', a[0]);
ok('an ampersand survives', a[1] === 'file:///Users/franco/My%20Docs/a&b.png', a[1]);

console.log('\ncharacters that would break a file URL');
var h = run('<img src="fig#2.png"><img src="what?.png">', '/Users/franco/Q?');
ok('a hash in the filename is escaped',
   h[0] === 'file:///Users/franco/Q%3F/fig%232.png', h[0]);
ok('a question mark in the filename is escaped',
   h[1] === 'file:///Users/franco/Q%3F/what%3F.png', h[1]);

console.log('\ntrailing slash on the document folder');
var t = run('<img src="p.png">', '/Users/franco/Docs///');
ok('duplicate slashes are collapsed', t[0] === 'file:///Users/franco/Docs/p.png', t[0]);

console.log('\n' + passes + ' passed, ' + fails + ' failed\n');
process.exit(fails ? 1 : 0);
