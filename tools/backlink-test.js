#!/usr/bin/env node
/* ============================================================
   minimark — backlink tests

   "What links here", as a section of the one field rather than a panel.

   The folder is the shell's, so it is stubbed here and answers whatever the
   test wants. What is testable in a browser is the part that has actually
   gone wrong in features shaped like this one:

     - the answer outlives the question. A tab switch while the scan is out
       must not show one document's backlinks under another's name, with
       every row opening the wrong file;
     - the field must not scan the folder every time somebody reaches for a
       command, and must not go stale forever either;
     - links and mentions have to be told apart, since the mentions are the
       half worth having and the half that is only a guess.

   The scan itself is Swift and is tested from the Swift side.

   Usage:  node tools/backlink-test.js [resourcesDir]
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

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1080, height: 760 } });
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

  /* The stub shell. It does not answer on its own: each test decides when the
     scan comes back, which is the only way to test what the field does while
     it is still out. */
  await page.addInitScript(() => {
    window.__sent = [];
    window.webkit = { messageHandlers: { mm: { postMessage: m => window.__sent.push(m) } } };
  });
  await page.goto(pageURL);
  await page.waitForFunction(() => window.App && window.__sent.some(m => m.type === 'ready'));

  const load = async (name) => {
    await page.evaluate(n => { App.loadDoc('# ' + n + '\n\nSome prose.', n + '.md', '/docs'); },
                        name);
    await page.waitForTimeout(300);
  };
  const answer = (links, mentions) => page.evaluate(a => {
    App.setBacklinks({
      links: a.l.map(n => ({ name: n, path: '/docs/' + n })),
      mentions: a.m.map(n => ({ name: n, path: '/docs/' + n }))
    });
  }, { l: links, m: mentions });

  const openField = async (key) => {
    await page.evaluate(() => {
      const w = document.querySelector('#pickerWrap');
      if (w.classList.contains('open')) document.querySelector('#pickerInput')
        .dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    await page.waitForTimeout(60);
    await page.keyboard.press(key || 'Meta+k');
    await page.waitForTimeout(150);
  };
  const type = async text => {
    await page.evaluate(t => {
      const i = document.querySelector('#pickerInput');
      i.value = t;
      i.dispatchEvent(new Event('input', { bubbles: true }));
    }, text);
    await page.waitForTimeout(60);
  };
  const rows = () => page.evaluate(() =>
    Array.from(document.querySelectorAll('#pickerList .pk')).map(n => ({
      title: n.querySelector('.pk-t') ? n.querySelector('.pk-t').textContent : '',
      key: n.querySelector('.pk-k') ? n.querySelector('.pk-k').textContent : ''
    })));
  const titles = async () => (await rows()).map(r => r.title);
  const scans = () => page.evaluate(() =>
    window.__sent.filter(m => m.type === 'backlinks').length);
  const opened = () => page.evaluate(() =>
    window.__sent.filter(m => m.type === 'openRecent').map(m => m.path));
  const clear = () => page.evaluate(() => { window.__sent.length = 0; });

  console.log('\nasked for when the field opens, not on every render\n');

  await load('kestrels');
  await clear();
  await openField();
  ok('opening the field asks the shell to scan', (await scans()) === 1,
     'scans: ' + await scans());

  await answer(['field notes.md'], ['bird list.md']);
  await page.waitForTimeout(80);

  let t = await titles();
  ok('a file that links here is in the list', t.includes('field notes.md'),
     'got: ' + t.join(' | '));
  ok('and one that only mentions it is too', t.includes('bird list.md'),
     'got: ' + t.join(' | '));

  let r = await rows();
  ok('the two are told apart',
     r.find(x => x.title === 'field notes.md').key === 'Links here' &&
     r.find(x => x.title === 'bird list.md').key === 'Mentions',
     JSON.stringify(r.filter(x => x.key === 'Links here' || x.key === 'Mentions')));

  ok('the answer arrives into a field that is already open',
     (await page.evaluate(() => document.querySelector('#pickerWrap').classList.contains('open'))));

  await clear();
  await openField();
  ok('reopening straight away does not scan again', (await scans()) === 0,
     'scans: ' + await scans());
  ok('and the answer is still there', (await titles()).includes('field notes.md'));

  console.log('\nreachable by typing, and by the sigil\n');

  await type('field');
  t = await titles();
  ok('a backlink is reachable by typing part of its name', t.includes('field notes.md'),
     'got: ' + t.join(' | '));

  await type('links here');
  t = await titles();
  ok('and by what it is', t.includes('field notes.md'), 'got: ' + t.join(' | '));

  await type('<');
  t = await titles();
  ok('< shows what links here', t.includes('field notes.md') && t.includes('bird list.md'));
  ok('and nothing else', !t.includes('Toggle Zen mode'), 'got: ' + t.join(' | '));

  await type('>zen');
  t = await titles();
  ok('and the command sigil still drops them', !t.includes('field notes.md'),
     'got: ' + t.join(' | '));

  console.log('\nopening one\n');

  await clear();
  await type('<');
  await page.evaluate(() => {
    const n = Array.from(document.querySelectorAll('#pickerList .pk'))
      .find(x => x.querySelector('.pk-t').textContent === 'field notes.md');
    n.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
  });
  await page.waitForTimeout(250);
  ok('clicking one opens that file', (await opened())[0] === '/docs/field notes.md',
     JSON.stringify(await opened()));

  console.log('\nthe answer belongs to the document it was about\n');

  await load('buzzards');
  await clear();
  await openField();
  t = await titles();
  ok('another document does not inherit the last one’s backlinks',
     !t.includes('field notes.md') && !t.includes('bird list.md'),
     'got: ' + t.join(' | '));
  ok('and a new scan goes out for it', (await scans()) === 1, 'scans: ' + await scans());

  /* The race: the answer for buzzards lands after the writer has gone back to
     kestrels. It must not be shown under the wrong document. */
  await load('kestrels');
  await answer(['buzzard notes.md'], []);
  await page.waitForTimeout(80);
  await openField();
  t = await titles();
  ok('an answer that lands after a tab switch is not shown',
     !t.includes('buzzard notes.md'), 'got: ' + t.join(' | '));

  console.log('\nnothing to say\n');

  await load('alone');
  await openField();
  await answer([], []);
  await page.waitForTimeout(80);
  r = await rows();
  ok('a document nothing points at adds no rows',
     !r.some(x => x.key === 'Links here' || x.key === 'Mentions'));
  ok('and the field is otherwise unchanged',
     (await titles()).includes('Toggle Zen mode'));

  await type('<');
  ok('the sigil says so rather than showing an empty list',
     (await page.evaluate(() => {
       const n = document.querySelector('#pickerList .pk-empty');
       return n ? n.textContent : null;
     })) !== null);

  await page.keyboard.press('Escape');
  await page.waitForTimeout(100);

  console.log('');
  ok('no uncaught errors anywhere in the run', errors.length === 0, errors.join('\n        '));

  await browser.close();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
