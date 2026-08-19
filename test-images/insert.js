/* Drives App.insertImages against a stubbed editor to check target selection,
   separator handling and the detached-node guard. */
var fs = require('fs');
var { JSDOM } = require('jsdom');
var ui = fs.readFileSync('/sessions/epic-zen-hopper/mnt/minimark/minimark.app/Contents/Resources/ui.js','utf8');

var s = ui.indexOf('    insertImages: function (paths, at) {');
var e = ui.indexOf('    /* Kept for the original single-image bridge contract. */');
var mdS = ui.indexOf('  function mdDestination(p)'), mdE = ui.indexOf('  function humanSpan(ms)');

var fails = 0, passes = 0;
function ok(n, c, x) { if (c) { passes++; console.log('  PASS  ' + n); } else { fails++; console.log('  FAIL  ' + n + (x ? '  -> ' + x : '')); } }

function build(opts) {
  var dom = new JSDOM('<textarea id=t></textarea><textarea id=orphan></textarea>');
  var doc = dom.window.document;
  var ta = doc.getElementById('t');
  ta.value = opts.value || '';
  ta.setSelectionRange(opts.caret == null ? ta.value.length : opts.caret,
                       opts.caret == null ? ta.value.length : opts.caret);
  var orphan = doc.getElementById('orphan');
  if (opts.detach) orphan.remove();

  var toasts = [];
  var state = { pasteTarget: opts.pasteTarget === 'live' ? ta
                           : opts.pasteTarget === 'dead' ? orphan : null };
  var MM = {
    textareaForInsert: function (at) { calls.push(at); return opts.fallback === false ? null : ta; },
    replaceRange: function (t, from, to, text) {
      t.value = t.value.slice(0, from) + text + t.value.slice(to);
    }
  };
  var calls = [];
  var src = 'var mdDestination;' + ui.slice(mdS, mdE) +
            '; return { insertImages: function (paths, at) {' +
            ui.slice(s + '    insertImages: function (paths, at) {'.length,
                     ui.lastIndexOf('},', e)) + '} };';
  var api = new Function('state','MM','toast','document', src)(
    state, MM, function (m) { toasts.push(m); }, doc);
  return { api: api, ta: ta, state: state, toasts: toasts, calls: calls };
}

console.log('\nseparation from surrounding text');
var c = build({ value: 'Some existing text' });
c.api.insertImages(['a.png'], null);
ok('an image is not glued onto the end of a paragraph',
   c.ta.value === 'Some existing text\n\n![](a.png)', JSON.stringify(c.ta.value));

c = build({ value: 'Line\n' });
c.api.insertImages(['a.png'], null);
ok('one existing newline is topped up to a blank line',
   c.ta.value === 'Line\n\n![](a.png)', JSON.stringify(c.ta.value));

c = build({ value: 'Para\n\n' });
c.api.insertImages(['a.png'], null);
ok('an existing blank line is not doubled',
   c.ta.value === 'Para\n\n![](a.png)', JSON.stringify(c.ta.value));

c = build({ value: '' });
c.api.insertImages(['a.png'], null);
ok('an empty block gets no leading blank line',
   c.ta.value === '![](a.png)', JSON.stringify(c.ta.value));

console.log('\nmultiple files');
c = build({ value: '' });
c.api.insertImages(['a.png','b.png','c.png'], null);
ok('three images are blank-line separated',
   c.ta.value === '![](a.png)\n\n![](b.png)\n\n![](c.png)', JSON.stringify(c.ta.value));
ok('and the toast counts them', c.toasts[0] === '3 images added', c.toasts[0]);

console.log('\npasteTarget handling');
c = build({ value: '', pasteTarget: 'live' });
c.api.insertImages(['a.png'], null);
ok('a live pasteTarget is used', c.ta.value.indexOf('a.png') >= 0);
ok('and is cleared afterwards', c.state.pasteTarget === null);

c = build({ value: 'x', pasteTarget: 'dead', detach: true });
c.api.insertImages(['a.png'], null);
ok('a detached pasteTarget is rejected rather than written into',
   c.ta.value.indexOf('a.png') >= 0, JSON.stringify(c.ta.value));
ok('the stale target is cleared', c.state.pasteTarget === null);

c = build({ value: '', pasteTarget: 'live' });
c.api.insertImages(['a.png'], { x: 10, y: 20 });
ok('a drop point overrides a stale pasteTarget', c.calls.length === 1 && c.calls[0].x === 10,
   JSON.stringify(c.calls));

console.log('\nnothing to insert into');
c = build({ value: '', fallback: false });
c.api.insertImages(['a.png'], null);
ok('no crash, and the user is told', c.toasts[0] === 'Could not place the image', c.toasts[0]);

console.log('\nempty input');
c = build({ value: 'x' });
c.api.insertImages([], null);
ok('an empty list does nothing', c.ta.value === 'x' && c.toasts.length === 0);

console.log('\n' + passes + ' passed, ' + fails + ' failed\n');
process.exit(fails ? 1 : 0);
