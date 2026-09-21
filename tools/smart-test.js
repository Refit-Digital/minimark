#!/usr/bin/env node
/* ============================================================
   minimark — smart punctuation tests

   The file keeps `"` and `--`; the page gets “ ” and —. So every test here
   is really two assertions: the page changed, and the file did not.

   The rest is the rule itself, and the cases worth their own test are the
   ones that cost somebody something when they are wrong:

     - code is literal, in a span and in a fence, and so is an equation;
     - `--flag` is a flag, not an em dash, for anybody writing about a
       command line without reaching for backticks;
     - a quote that opens in one text node and closes in another still faces
       the right way, which is what `"a <em>b</em> c"` is;
     - a link's href is not prose.

   Usage:  node tools/smart-test.js [resourcesDir]
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

  await page.addInitScript(() => {
    window.__sent = [];
    window.webkit = { messageHandlers: { mm: { postMessage: m => window.__sent.push(m) } } };
  });
  await page.goto(pageURL);
  await page.waitForFunction(() => window.App && window.__sent.some(m => m.type === 'ready'));

  const load = async (text, mode) => {
    await page.evaluate(a => { App.loadDoc(a.t, 'note.md', '/docs'); MM.setMode(a.m || 'live'); },
                        { t: text, m: mode });
    await page.waitForTimeout(400);
    await page.evaluate(() => { const ta = document.querySelector('.blk-edit'); if (ta) ta.blur(); });
    await page.waitForTimeout(250);
  };
  const shown = () => page.evaluate(() => document.querySelector('#doc').textContent);
  const html = () => page.evaluate(() => document.querySelector('#doc').innerHTML);
  const exported = () => page.evaluate(() => App.getHTML());
  const source = () => page.evaluate(() => MM.state ? MM.state.text : null);
  const rule = (t) => page.evaluate(x => MM.smarten(x, ''), t);
  const command = async title => {
    await page.evaluate(t => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true, bubbles: true }));
      const input = document.querySelector('#pickerInput');
      input.value = t;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      const row = Array.from(document.querySelectorAll('#pickerList .pk'))
        .find(x => x.querySelector('.pk-t').textContent === t);
      if (!row) throw new Error('no command called ' + t);
      row.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    }, title);
    await page.waitForTimeout(400);
  };

  console.log('\nthe rule itself\n');

  ok('straight quotes face the right way',
     (await rule('He said "hello" to her.')) === 'He said “hello” to her.',
     await rule('He said "hello" to her.'));
  ok('an apostrophe is an apostrophe',
     (await rule("don't")) === 'don’t', await rule("don't"));
  ok('and so is the one after a plural',
     (await rule("dogs' bones")) === 'dogs’ bones', await rule("dogs' bones"));
  ok('a decade keeps its leading mark the right way round',
     (await rule("the '90s")) === 'the ’90s', await rule("the '90s"));
  ok('a single-quoted phrase opens and closes',
     (await rule("say 'this' now")) === 'say ‘this’ now', await rule("say 'this' now"));
  ok('two hyphens between words are an em dash',
     (await rule('a--b')) === 'a—b', await rule('a--b'));
  ok('and between spaces too',
     (await rule('a -- b')) === 'a — b', await rule('a -- b'));
  ok('but --flag is a flag', (await rule('use --flag here')) === 'use --flag here',
     await rule('use --flag here'));
  ok('three hyphens are an em dash as well',
     (await rule('wait--- what')) === 'wait— what', await rule('wait--- what'));
  ok('three dots are an ellipsis',
     (await rule('well... maybe')) === 'well… maybe', await rule('well... maybe'));

  console.log('\nthe page is typeset, the file is not\n');

  const DOC = 'He said "hello"--then left.';
  await load(DOC);
  ok('the rendered page is typeset', /“hello”—then/.test(await shown()),
     JSON.stringify(await shown()));
  ok('and the file is untouched', (await source()) === DOC, JSON.stringify(await source()));

  await load(DOC, 'split');
  const src = await page.evaluate(() => document.querySelector('#src').value);
  ok('the source pane shows what was typed', src === DOC, JSON.stringify(src));
  ok('while the preview beside it is typeset', /“hello”/.test(await shown()));

  ok('export is typeset too', /“hello”—then/.test(await exported()),
     (await exported()).slice(0, 120));

  console.log('\nwhat stays literal\n');

  await load('Prose "here".\n\n`code "x" a--b`\n\n```\nfence "y" c--d\n```\n');
  let h = await html();
  ok('a code span keeps its straight quotes', /code "x" a--b/.test(h),
     h.slice(0, 200));
  ok('and so does a fence', /fence "y" c--d/.test(h), h.slice(0, 300));
  ok('while the prose around them is typeset', /Prose “here”/.test(await shown()));

  await load('See [the "page"](http://example.com/a--b).');
  h = await html();
  ok('a link href is not prose', /href="http:\/\/example\.com\/a--b"/.test(h),
     h.slice(0, 200));
  ok('but its label is', /“page”/.test(await shown()), await shown());

  await load('Maths $a--b$ stays put.');
  ok('an equation is not rewritten', !/—/.test(await shown()), await shown());

  console.log('\nacross markup\n');

  await load('A "quote with *emphasis* inside" it.');
  const t = await shown();
  ok('a quote that opens and closes in different nodes still faces right',
     /“quote with emphasis inside”/.test(t), JSON.stringify(t));

  console.log('\nturning it off\n');

  await load(DOC);
  await command('Smart punctuation');
  ok('the page now reads as the file does', /"hello"--then/.test(await shown()),
     JSON.stringify(await shown()));
  ok('and the file still has not moved', (await source()) === DOC);

  const pref = await page.evaluate(() => {
    const p = window.__sent.filter(m => m.type === 'pref' && m.key === 'smart');
    return p.length ? p[p.length - 1].value : null;
  });
  ok('which is remembered', pref === '0', 'pref was: ' + pref);

  await command('Smart punctuation');
  ok('and on again', /“hello”/.test(await shown()), JSON.stringify(await shown()));

  console.log('');
  ok('no uncaught errors anywhere in the run', errors.length === 0, errors.join('\n        '));

  await browser.close();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
