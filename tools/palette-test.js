#!/usr/bin/env node
/* ============================================================
   minimark — picker tests

   ⌘K and ⌘R used to be two pickers over two lists, and the writer had to
   know which kind of thing they wanted before typing for it. They are one
   field now: commands, headings, recent documents and the document's own
   text, with a leading >, # or / to look for only one kind. What follows
   drives the real web layer in a headless browser against a stand-in shell.

   Usage:  node tools/palette-test.js [resourcesDir]
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
const eq = (name, got, want) =>
  ok(name, JSON.stringify(got) === JSON.stringify(want),
     `got ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`);

const shell = () => {
  window.__sent = [];
  window.webkit = { messageHandlers: { mm: { postMessage: m => { window.__sent.push(m); } } } };
};

const DOC = [
  '# Quarterly plan',
  '',
  'The intro mentions a quokka once.',
  '',
  '## Budget',
  '',
  'The budget line: quokka feed, and a zen garden.',
  '',
  '## Zen and focus',
  '',
  'Closing words.',
  ''
].join('\n');

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1080, height: 720 } });
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  await page.addInitScript(shell);
  await page.goto(pageURL);
  await page.waitForFunction(() => window.App && window.__sent.some(m => m.type === 'ready'));
  await page.evaluate(t => { App.loadDoc(t, 'plan.md', '/docs'); MM.setMode('split'); }, DOC);
  await page.evaluate(() => App.setRecents([
    { name: 'Letters.md', path: '/docs/Letters.md' },
    { name: 'Quokka facts.md', path: '/docs/Quokka facts.md' }
  ]));
  await page.waitForTimeout(200);

  const rows = () => page.evaluate(() => Array.from(document.querySelectorAll('#pickerList .pk')).map(n => ({
    title: n.querySelector('.pk-t').textContent,
    key: (n.querySelector('.pk-k') || {}).textContent || '',
    hint: (n.querySelector('.pk-hint') || {}).textContent || '',
    heading: !!n.querySelector('.pk-h')
  })));
  const isOpen = () => page.evaluate(() => document.querySelector('#pickerWrap').classList.contains('open'));
  const empty = () => page.evaluate(() => (document.querySelector('#pickerList .pk-empty') || {}).textContent || '');
  const query = async (s) => { await page.fill('#pickerInput', s); await page.waitForTimeout(20); return rows(); };
  const choose = async (title) => {
    const list = await rows();
    const at = list.findIndex(r => r.title === title);
    for (let i = 0; i < at; i++) await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(250);
    return at;
  };

  console.log('opening');
  await page.keyboard.press('Meta+k');
  await page.waitForTimeout(80);
  ok('⌘K opens the field', await isOpen());
  eq('with nothing in it', await page.inputValue('#pickerInput'), '');
  ok('and says what it can find', await page.evaluate(() => !!document.querySelector('#pickerList .pk-tip')));
  let list = await rows();
  eq('with nothing typed the commands lead, as they always have', list[0].title, 'Switch to Split view');

  console.log('\none field');
  list = await query('budget');
  eq('a heading that matches by name comes first', [list[0].title, list[0].heading], ['Budget', true]);
  const textRows = list.filter(r => r.key === 'Text');
  eq('and the text after it', textRows.map(r => r.hint), ['line 7']);
  ok('text results come after everything matched by name',
     list.findIndex(r => r.key === 'Text') > list.findIndex(r => r.heading));
  ok('the tip goes once something is typed', await page.evaluate(() => !document.querySelector('#pickerList .pk-tip')));

  list = await query('quokka');
  eq('a recent document matches by name', list[0].title, 'Quokka facts.md');
  eq('every place the text occurs is listed, with its line', list.filter(r => r.key === 'Text').map(r => r.hint),
     ['line 3', 'line 7']);
  eq('two characters are not enough to search the text', (await query('qu')).filter(r => r.key === 'Text'), []);

  console.log('\nsigils');
  list = await query('>zen');
  eq('> is commands only', [list[0].title, list.some(r => r.heading || r.key === 'Text')], ['Toggle Zen mode', false]);
  list = await query('#');
  eq('# is headings only, in document order', list.map(r => r.title), ['Quarterly plan', 'Budget', 'Zen and focus']);
  eq('# narrows by name', (await query('#zen')).map(r => r.title), ['Zen and focus']);
  eq('/ is recent documents only', (await query('/quokka')).map(r => r.title), ['Quokka facts.md']);
  await query('>quokka');
  eq('a sigil with nothing to show says so', await empty(), 'Nothing found');

  console.log('\ngoing places');
  await query('#zen');
  await choose('Zen and focus');
  ok('Enter closes the field', !(await isOpen()));
  eq('a heading puts the caret at it', await page.evaluate(() => document.activeElement.selectionStart),
     DOC.indexOf('## Zen'));

  await page.keyboard.press('Meta+r');
  await page.waitForTimeout(80);
  ok('⌘R opens the same field', await isOpen());
  eq('already narrowed to headings', await page.inputValue('#pickerInput'), '#');
  eq('and lists them', (await rows()).map(r => r.title), ['Quarterly plan', 'Budget', 'Zen and focus']);

  await query('/quokka');
  await choose('Quokka facts.md');
  ok('a recent document asks the shell to open it',
     await page.evaluate(() => window.__sent.some(m => m.type === 'openRecent' && JSON.stringify(m).includes('Quokka facts.md'))));

  await page.keyboard.press('Meta+k');
  await page.waitForTimeout(80);
  await query('quokka feed');
  await choose((await rows()).find(r => r.key === 'Text').title);
  eq('split view: a text result selects the match', await page.evaluate(() => {
    const a = document.activeElement;
    return [a.selectionStart, a.value.slice(a.selectionStart, a.selectionEnd)];
  }), [DOC.indexOf('quokka feed'), 'quokka feed']);

  await page.evaluate(() => MM.setMode('live'));
  await page.waitForTimeout(300);
  await page.keyboard.press('Meta+k');
  await page.waitForTimeout(80);
  await query('zen garden');
  await choose((await rows()).find(r => r.key === 'Text').title);
  eq('live view: the block opens with the match selected', await page.evaluate(() => {
    const a = document.activeElement;
    return [a.classList.contains('blk-edit'), a.value.slice(a.selectionStart, a.selectionEnd)];
  }), [true, 'zen garden']);

  await page.keyboard.press('Meta+k');
  await page.waitForTimeout(80);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(80);
  ok('Escape closes it', !(await isOpen()));

  console.log('\na document with no headings');
  await page.evaluate(() => { App.loadDoc('Just a line.\n', 'note.md', '/docs'); MM.setMode('split'); });
  await page.waitForTimeout(200);
  await page.keyboard.press('Meta+r');
  await page.waitForTimeout(80);
  eq('⌘R says there are none, in the field rather than a toast', await empty(), 'No headings yet');
  await page.keyboard.press('Escape');

  ok('no uncaught errors anywhere in the run', errors.length === 0, errors.join('\n        '));

  await browser.close();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
