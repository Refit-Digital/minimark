#!/usr/bin/env node
/* ============================================================
   minimark — picker tests

   One field reaching commands, this document's headings and the recent
   files. The tests that matter are the ones a flat "concatenate three
   lists" implementation would fail:

     - a heading and a command are both reachable from the same field,
       without the writer saying which kind they meant;
     - the sigils narrow to exactly one kind, and the sigil itself is not
       part of the query;
     - ⌘R still lands on the outline, because that is the shortcut people
       already have in their fingers;
     - find is offered rather than absorbed, and is offered last, so it
       never takes the selection off a real result.

   Find itself keeps its own bar, so the handoff is tested by what reaches
   the find field, not by what the picker draws.

   Usage:  node tools/picker-test.js [resourcesDir]
   ============================================================ */

const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

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
const pageURL = 'file://' + path.join(resDir, 'index.html');

let passed = 0, failed = 0;
const ok = (name, cond, detail) => {
  if (cond) { passed++; console.log(`  ok    ${name}`); }
  else { failed++; console.log(`  FAIL  ${name}${detail ? '\n        ' + detail : ''}`); }
};

const DOC = [
  '# Introduction',
  '',
  'Some opening prose about kestrels.',
  '',
  '## Method',
  '',
  'More prose, mentioning kestrels a second time.',
  '',
  '### Deep detail',
  '',
  'Closing words.'
].join('\n');

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1080, height: 760 } });
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

  await page.addInitScript(() => {
    window.__sent = [];
    window.webkit = { messageHandlers: { mm: { postMessage: m => window.__sent.push(m) } } };
  });
  await page.goto(pageURL);
  await page.waitForFunction(() => window.App && window.__sent.some(m => m.type === 'ready'));

  await page.evaluate(t => { App.loadDoc(t, 'note.md', '/docs'); MM.setMode('split'); }, DOC);
  await page.waitForTimeout(400);

  /* the recent list is the shell's, so hand the page one the way the shell does */
  await page.evaluate(() => {
    if (App.setRecents) App.setRecents([{ name: 'Kestrel notes.md', path: '/docs/Kestrel notes.md' }]);
  });

  const isOpen = () => page.evaluate(() =>
    document.querySelector('#pickerWrap').classList.contains('open'));
  const field = () => page.evaluate(() => document.querySelector('#pickerInput').value);
  const rows = () => page.evaluate(() =>
    Array.from(document.querySelectorAll('#pickerList .pk')).map(n => ({
      title: n.querySelector('.pk-t') ? n.querySelector('.pk-t').textContent : '',
      level: n.querySelector('.pk-h') ? n.querySelector('.pk-h').textContent : '',
      key: n.querySelector('.pk-k') ? n.querySelector('.pk-k').textContent : '',
      sel: n.classList.contains('sel')
    })));
  const empty = () => page.evaluate(() => {
    const n = document.querySelector('#pickerList .pk-empty');
    return n ? n.textContent : null;
  });

  const openWith = async key => {
    await page.evaluate(() => {
      const w = document.querySelector('#pickerWrap');
      if (w.classList.contains('open')) document.querySelector('#pickerInput')
        .dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    await page.waitForTimeout(60);
    await page.keyboard.press(key);
    await page.waitForTimeout(120);
  };
  const type = async text => {
    await page.evaluate(t => {
      const i = document.querySelector('#pickerInput');
      i.value = t;
      i.dispatchEvent(new Event('input', { bubbles: true }));
    }, text);
    await page.waitForTimeout(60);
  };
  const titles = async () => (await rows()).map(r => r.title);

  console.log('\none field, three kinds\n');

  await openWith('Meta+k');
  ok('⌘K opens the picker', await isOpen());
  ok('and the field starts empty', (await field()) === '');

  let t = await titles();
  ok('the document’s headings are in it without typing anything',
     t.includes('Introduction') && t.includes('Method') && t.includes('Deep detail'),
     'got: ' + t.slice(0, 8).join(' | '));
  ok('commands are in the same list', t.includes('Toggle Zen mode'),
     'got: ' + t.slice(0, 8).join(' | '));
  ok('and so are the recent files', t.includes('Kestrel notes.md'),
     'got: ' + t.slice(-4).join(' | '));

  ok('the outline comes first, so an empty field shows where you are',
     t[0] === 'Introduction', 'first row was: ' + t[0]);

  let r = await rows();
  ok('a heading row carries its level', r.find(x => x.title === 'Method').level === 'H2');
  ok('a deeper heading carries the deeper level',
     r.find(x => x.title === 'Deep detail').level === 'H3');
  ok('a recent file row says so', r.find(x => x.title === 'Kestrel notes.md').key === 'Recent');

  console.log('\ntyping, with nothing said about which kind\n');

  await type('meth');
  t = await titles();
  ok('a heading is reachable by typing part of it', t.includes('Method'), 'got: ' + t.join(' | '));

  await type('zen');
  t = await titles();
  ok('and a command is reachable from the same field', t.includes('Toggle Zen mode'),
     'got: ' + t.join(' | '));
  ok('the command outranks the find handoff', t[0] === 'Toggle Zen mode', 'got: ' + t[0]);

  await type('kestrel');
  t = await titles();
  ok('and a recent file is reachable too', t.includes('Kestrel notes.md'),
     'got: ' + t.join(' | '));

  console.log('\nsigils narrow to one kind\n');

  await type('#');
  t = await titles();
  ok('# shows every heading', t.includes('Introduction') && t.includes('Method'));
  ok('and nothing else', !t.includes('Toggle Zen mode') && !t.includes('Kestrel notes.md'),
     'got: ' + t.join(' | '));

  await type('#deep');
  t = await titles();
  ok('the sigil is not part of the query', t.includes('Deep detail'), 'got: ' + t.join(' | '));
  ok('and it still excludes the other kinds', !t.some(x => x.indexOf('Toggle') === 0),
     'got: ' + t.join(' | '));

  await type('>zen');
  t = await titles();
  ok('> keeps commands', t.includes('Toggle Zen mode'), 'got: ' + t.join(' | '));

  await type('>intro');
  t = await titles();
  ok('and drops headings even when they match', !t.includes('Introduction'),
     'got: ' + t.join(' | '));

  await type('/kestrel');
  t = await titles();
  ok('/ keeps the recent files', t.includes('Kestrel notes.md'), 'got: ' + t.join(' | '));
  ok('and drops the rest', !t.includes('Toggle Zen mode'), 'got: ' + t.join(' | '));

  console.log('\nfind is offered, not absorbed\n');

  await type('kestrels');
  t = await titles();
  const fi = t.findIndex(x => x.indexOf('Find') === 0);
  ok('typing offers to hand the query to find', fi > -1, 'got: ' + t.join(' | '));
  ok('and offers it last, so it never takes the selection', fi === t.length - 1,
     `find at ${fi} of ${t.length}`);
  r = await rows();
  ok('the first row is still selected', r[0].sel);

  await type('#kestrels');
  t = await titles();
  ok('a sigil suppresses the handoff', !t.some(x => x.indexOf('Find') === 0),
     'got: ' + t.join(' | '));

  await type('k');
  t = await titles();
  ok('one character is too little to offer it', !t.some(x => x.indexOf('Find') === 0),
     'got: ' + t.join(' | '));

  console.log('\nthe handoff reaches the find bar\n');

  await type('kestrels');
  await page.evaluate(() => {
    const n = Array.from(document.querySelectorAll('#pickerList .pk'))
      .find(x => x.querySelector('.pk-t').textContent.indexOf('Find') === 0);
    n.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
  });
  await page.waitForTimeout(300);

  ok('the picker closes', !(await isOpen()));
  ok('the find bar opens', await page.evaluate(() =>
    document.querySelector('#find').classList.contains('open')));
  ok('with the query already in it', (await page.evaluate(() =>
    document.querySelector('#findInput').value)) === 'kestrels');
  ok('and it has found both mentions', (await page.evaluate(() =>
    document.querySelector('#findCount').textContent)) === '1/2',
    'count read: ' + (await page.evaluate(() => document.querySelector('#findCount').textContent)));

  await page.keyboard.press('Escape');
  await page.waitForTimeout(150);

  console.log('\n⌘R still goes to the outline\n');

  await openWith('Meta+r');
  ok('⌘R opens the same field', await isOpen());
  ok('with the heading sigil already typed', (await field()) === '#');
  t = await titles();
  ok('so it lands on the outline', t[0] === 'Introduction', 'got: ' + t[0]);
  ok('and shows only headings', !t.includes('Toggle Zen mode'), 'got: ' + t.join(' | '));

  await page.keyboard.press('Escape');
  await page.waitForTimeout(120);

  console.log('\na document with no headings\n');

  await page.evaluate(() => { App.loadDoc('Just prose, no headings at all.', 'flat.md', '/docs'); });
  await page.waitForTimeout(300);
  await openWith('Meta+r');
  ok('⌘R still opens rather than refusing with a toast', await isOpen());
  /* `#` reaches tags as well as headings, so the empty state names both. */
  ok('and says so in the list', (await empty()) === 'No headings or tags in this document',
     'empty state read: ' + await empty());

  await type('zen');
  t = await titles();
  ok('and clearing the sigil gets you back to everything', t.includes('Toggle Zen mode'),
     'got: ' + t.join(' | '));

  await page.keyboard.press('Escape');
  await page.waitForTimeout(120);

  console.log('');
  ok('no uncaught errors anywhere in the run', errors.length === 0, errors.join('\n        '));

  await browser.close();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
