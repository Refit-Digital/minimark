#!/usr/bin/env node
/* ============================================================
   minimark — tag and open-task tests

   #tags and `- [ ]` tasks are things the writer put in the document meaning
   to come back to them, which is what a heading is, so they are rows in the
   same field rather than a pane of their own.

   The tests that matter are the ones a regex over the whole document gets
   wrong:

     - `# Heading` is a heading and `#Heading` is a tag, because markdown says
       the space is what makes the difference;
     - a URL fragment is not a tag, and neither is a # inside code;
     - `#field` must not match the tag `#field-note`;
     - a done task is a record, not something to go to.

   Tags in other files come from the shell, which is stubbed. That it gathers
   them in the same pass as the backlinks, rather than in a scan of its own,
   is asserted on the message that goes out.

   Usage:  node tools/tag-task-test.js [resourcesDir]
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
  '# Kestrels',
  '',
  'Notes on the #kestrel, filed under #field-note.',
  '',
  'A link to http://example.com/birds#section is not a tag.',
  '',
  'Neither is `#hashtag` in code.',
  '',
  '```',
  'grep "#kestrel" notes.md',
  '```',
  '',
  '## To do',
  '',
  '- [ ] count the fledglings',
  '- [x] replace the camera',
  '- [ ] write it up',
  '',
  'Filed again under #kestrel.'
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

  const load = async (text, name) => {
    await page.evaluate(a => { App.loadDoc(a.t, a.n || 'birds.md', '/docs'); MM.setMode('live'); },
                        { t: text, n: name });
    await page.waitForTimeout(350);
    await page.evaluate(() => { const ta = document.querySelector('.blk-edit'); if (ta) ta.blur(); });
    await page.waitForTimeout(200);
  };
  const openField = async (key) => {
    await page.evaluate(() => {
      const w = document.querySelector('#pickerWrap');
      if (w.classList.contains('open')) document.querySelector('#pickerInput')
        .dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    await page.waitForTimeout(60);
    await page.keyboard.press(key || 'Meta+k');
    await page.waitForTimeout(160);
  };
  const type = async text => {
    await page.evaluate(t => {
      const i = document.querySelector('#pickerInput');
      i.value = t;
      i.dispatchEvent(new Event('input', { bubbles: true }));
    }, text);
    await page.waitForTimeout(70);
  };
  const rows = () => page.evaluate(() =>
    Array.from(document.querySelectorAll('#pickerList .pk')).map(n => ({
      title: n.querySelector('.pk-t') ? n.querySelector('.pk-t').textContent : '',
      key: n.querySelector('.pk-k') ? n.querySelector('.pk-k').textContent : ''
    })));
  const titles = async () => (await rows()).map(r => r.title);
  const sent = t => page.evaluate(x => window.__sent.filter(m => m.type === x), t);
  const opened = () => page.evaluate(() =>
    window.__sent.filter(m => m.type === 'openRecent').map(m => m.path));

  await load(DOC);

  console.log('\nwhat counts as a tag\n');

  await openField();
  let t = await titles();
  ok('a tag in prose is a row', t.includes('#kestrel'), JSON.stringify(t.slice(0, 12)));
  ok('a hyphenated tag is one tag', t.includes('#field-note'), JSON.stringify(t.slice(0, 12)));
  ok('a heading is not a tag', !t.includes('#Kestrels'), JSON.stringify(t.slice(0, 12)));
  ok('a URL fragment is not a tag', !t.includes('#section'), JSON.stringify(t.slice(0, 12)));
  ok('a # in a code span is not a tag', !t.includes('#hashtag'), JSON.stringify(t.slice(0, 12)));
  ok('nor is one inside a fence',
     !t.some(x => x === '#kestrel"'), JSON.stringify(t.slice(0, 12)));

  let r = await rows();
  ok('a tag used twice says so',
     r.find(x => x.title === '#kestrel').key === '2×',
     JSON.stringify(r.filter(x => x.title.indexOf('#') === 0)));
  ok('a tag used once says nothing',
     r.find(x => x.title === '#field-note').key === '',
     JSON.stringify(r.filter(x => x.title.indexOf('#') === 0)));

  console.log('\nopen tasks\n');

  t = await titles();
  ok('an open task is a row', t.includes('count the fledglings'), JSON.stringify(t.slice(0, 14)));
  ok('and so is the other one', t.includes('write it up'));
  ok('a done task is not', !t.includes('replace the camera'), JSON.stringify(t.slice(0, 14)));
  r = await rows();
  ok('a task row says what it is',
     r.find(x => x.title === 'write it up').key === 'To do');

  console.log('\nthe sigils\n');

  await type('#');
  t = await titles();
  ok('# takes headings and tags together',
     t.includes('Kestrels') && t.includes('#kestrel'), JSON.stringify(t));
  ok('with the outline still first', t[0] === 'Kestrels', 'first row: ' + t[0]);
  ok('and nothing else', !t.includes('Toggle Zen mode'), JSON.stringify(t));

  await type('#kestrel');
  t = await titles();
  ok('typing the # somebody wrote finds their tag', t.includes('#kestrel'), JSON.stringify(t));

  await type('[');
  t = await titles();
  ok('[ takes the open tasks', t.includes('count the fledglings') && t.includes('write it up'),
     JSON.stringify(t));
  ok('and only those', !t.includes('#kestrel') && !t.includes('Kestrels'), JSON.stringify(t));
  ok('the done one stays out', !t.includes('replace the camera'), JSON.stringify(t));

  await type('>zen');
  t = await titles();
  ok('the command sigil still drops both', !t.includes('#kestrel') &&
     !t.includes('write it up'), JSON.stringify(t));

  console.log('\nempty states say which kind\n');

  await load('Just prose, nothing marked.');
  await openField();
  await type('[');
  ok('nothing left to do says so', (await page.evaluate(() => {
    const n = document.querySelector('#pickerList .pk-empty');
    return n ? n.textContent : null;
  })) === 'Nothing left to do in this document');

  console.log('\ntags ride the backlink scan\n');

  /* A different document, because a scan already went out for birds.md at
     the top of this run and was never answered: the field does not ask twice
     while one is still out, which is the behaviour the backlink suite tests. */
  await page.evaluate(() => { window.__sent.length = 0; });
  await load(DOC, 'birds-again.md');
  await openField();
  const scans = await sent('backlinks');
  ok('one scan goes out, not two', scans.length === 1, JSON.stringify(scans));
  ok('and it carries this document’s tags',
     scans[0].tags && scans[0].tags.indexOf('kestrel') > -1 &&
     scans[0].tags.indexOf('field-note') > -1, JSON.stringify(scans[0]));
  ok('deduplicated, since the document uses one of them twice',
     scans[0].tags.length === 2, JSON.stringify(scans[0].tags));

  await page.evaluate(() => {
    App.setBacklinks({
      links: [], mentions: [],
      tags: { kestrel: [{ name: 'other notes.md', path: '/docs/other notes.md' }] }
    });
  });
  await page.waitForTimeout(120);

  t = await titles();
  ok('a file carrying the tag appears', t.includes('other notes.md'), JSON.stringify(t.slice(0, 14)));
  r = await rows();
  ok('labelled with the tag it was found under',
     r.find(x => x.title === 'other notes.md').key === '#kestrel',
     JSON.stringify(r.filter(x => x.title === 'other notes.md')));

  await page.evaluate(() => { window.__sent.length = 0; });
  await type('#kestrel');
  await page.evaluate(() => {
    const n = Array.from(document.querySelectorAll('#pickerList .pk'))
      .find(x => x.querySelector('.pk-t').textContent === 'other notes.md');
    n.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
  });
  await page.waitForTimeout(250);
  ok('and opens that file', (await opened())[0] === '/docs/other notes.md',
     JSON.stringify(await opened()));

  console.log('');
  ok('no uncaught errors anywhere in the run', errors.length === 0, errors.join('\n        '));

  await browser.close();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
