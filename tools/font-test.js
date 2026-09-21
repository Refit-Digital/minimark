#!/usr/bin/env node
/* ============================================================
   minimark — typeface tests

   Three faces of one family, and a draft that looks like a draft.

   The assertion that matters is not that the CSS names a font: it is that
   the font file behind the name actually loaded. A @font-face pointing at a
   path that is not there fails silently and falls back to the stack, which
   looks almost right and is the reason this suite exists rather than a
   grep of styles.css.

   The rest guards the decisions: three rather than five, Duo by default
   because a monospaced draft reads as unfinished, and an old preference
   naming one of the five faces that are gone landing on the default rather
   than on nothing.

   Usage:  node tools/font-test.js [resourcesDir]
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

const FACES = ['iA Writer Duo', 'iA Writer Mono', 'iA Writer Quattro'];

(async () => {
  console.log('the files\n');

  const fontDir = path.join(resDir, 'fonts');
  const want = ['iAWriterMonoV.ttf', 'iAWriterMonoV-Italic.ttf',
                'iAWriterDuoV.ttf', 'iAWriterDuoV-Italic.ttf',
                'iAWriterQuattroV.ttf', 'iAWriterQuattroV-Italic.ttf'];
  for (const f of want) {
    const p = path.join(fontDir, f);
    const size = fs.existsSync(p) ? fs.statSync(p).size : 0;
    ok(`${f} ships, and is a real file`, size > 20000, `${size} bytes`);
  }
  ok('the upstream licence ships beside them',
     fs.existsSync(path.join(fontDir, 'LICENSE.md')));
  ok('and the OFL is reproduced in NOTICES',
     /SIL Open Font License/.test(fs.readFileSync(path.join(resDir, '..', '..', '..', 'NOTICES'), 'utf8')));

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
  await page.evaluate(() => document.fonts.ready);

  console.log('\nthey actually load\n');

  for (const face of FACES) {
    const loaded = await page.evaluate(async f => {
      await document.fonts.load('400 16px "' + f + '"');
      return document.fonts.check('400 16px "' + f + '"');
    }, face);
    ok(`${face} loads`, loaded);
  }
  const italic = await page.evaluate(async () => {
    await document.fonts.load('italic 400 16px "iA Writer Duo"');
    return document.fonts.check('italic 400 16px "iA Writer Duo"');
  });
  ok('and so does an italic', italic);
  const bold = await page.evaluate(async () => {
    await document.fonts.load('700 16px "iA Writer Duo"');
    return document.fonts.check('700 16px "iA Writer Duo"');
  });
  ok('and a bold, from the same variable file', bold);

  console.log('\nthree, not five\n');

  const fonts = await page.evaluate(() => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true, bubbles: true }));
    const i = document.querySelector('#pickerInput');
    i.value = 'Font:';
    i.dispatchEvent(new Event('input', { bubbles: true }));
    return Array.from(document.querySelectorAll('#pickerList .pk'))
      .map(n => n.querySelector('.pk-t').textContent)
      .filter(x => x.indexOf('Font: ') === 0);
  });
  ok('three faces are offered', fonts.length === 3, JSON.stringify(fonts));
  ok('and they are the three', fonts.join('|') === 'Font: Duo|Font: Mono|Font: Quattro',
     JSON.stringify(fonts));
  ok('the unrelated five are gone',
     !fonts.some(f => /Avenir|Iowan|New York|System/.test(f)), JSON.stringify(fonts));

  await page.keyboard.press('Escape');
  await page.waitForTimeout(100);

  console.log('\nthe default is a draft face\n');

  const prose = () => page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue('--prose').trim());
  ok('the document is set in Duo by default', /iA Writer Duo/.test(await prose()),
     await prose());

  const rendered = await page.evaluate(async () => {
    App.loadDoc('Some prose to measure.', 'note.md', '/docs');
    await new Promise(r => setTimeout(r, 300));
    const p = document.querySelector('#doc p');
    return p ? getComputedStyle(p).fontFamily : null;
  });
  ok('and the rendered text uses it', /iA Writer Duo/.test(rendered || ''), rendered);

  const code = await page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue('--mono').trim());
  ok('code is set in Mono', /iA Writer Mono/.test(code), code);

  console.log('\na preference from when there were five\n');

  await page.evaluate(() => { App.setPrefs({ font: 'avenir' }); });
  await page.waitForTimeout(200);
  ok('an id that is no longer offered falls back to the default',
     /iA Writer Duo/.test(await prose()), await prose());

  await page.evaluate(() => { App.setPrefs({ font: 'quattro' }); });
  await page.waitForTimeout(200);
  ok('while one that is offered is honoured', /iA Writer Quattro/.test(await prose()),
     await prose());

  console.log('');
  ok('no uncaught errors anywhere in the run', errors.length === 0, errors.join('\n        '));

  await browser.close();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
