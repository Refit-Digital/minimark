#!/usr/bin/env node
/* ============================================================
   minimark — embed tests

   ![[chapter-two]] on a line of its own pulls that file in where it stands.

   The half that can be tested in a browser is the half that decides what a
   name means and what gets drawn: the shell owns the folder, so it is stubbed
   here and answers whatever the test wants it to. The path rules themselves
   are Swift and are tested from the Swift side.

   The tests that matter are the ones a naive "splice the file in before
   parsing" implementation would fail:

     - an embed inside a code fence is text about embeds, not an embed;
     - an embed with prose on the same line is prose;
     - an embed inside an embedded file is not resolved, so a file that
       embeds itself cannot hang the renderer;
     - the blocks the writer typed still map one to one onto the rendered
       blocks, because live view maps them back to source offsets;
     - every failure says which file and why, rather than sitting on the
       placeholder forever.

   Usage:  node tools/embed-test.js [resourcesDir]
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

/* The folder, as the shell would see it. The page asks for names; this is what
   comes back. */
const FILES = {
  'chapter-two.md': '## Chapter Two\n\nThe kestrel returned at dusk.\n',
  'notes.txt':      'Plain text, no markdown at all.\n',
  'figures.csv':    'Bird,Count,Note\nKestrel,3,"Two adults, one juvenile"\nBuzzard,1,""\n',
  'thin.csv':       'OnlyAHeader,AndNothingElse\n',
  'self.md':        'Before.\n\n![[self]]\n\nAfter.\n',
  'outer.md':       'Outer opens.\n\n![[chapter-two]]\n\nOuter closes.\n',
  'fenced.md':      'Writing about embeds:\n\n```\n![[chapter-two]]\n```\n',
  /* names used only by the batching test, so they are still unknown when it runs */
  'alpha.md':       'Alpha.\n',
  'beta.md':        'Beta.\n',
  /* asked for once, while the stub is refusing to answer */
  'waiting.md':     'Never arrives.\n'
};

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1080, height: 760 } });
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  /* One test embeds an image that is deliberately not there, to prove a
     missing image draws as a broken image rather than as an error message.
     WebKit logs that as a failed resource load, which is the expected result
     and not a fault in the page. */
  page.on('console', m => {
    if (m.type() !== 'error') return;
    if (/ERR_FILE_NOT_FOUND/.test(m.text())) return;
    errors.push('console: ' + m.text());
  });

  /* The stub shell. Answers embedRead the way minimark.swift does: a name with
     no extension is markdown, a name it will not resolve says why. */
  await page.addInitScript(files => {
    window.__sent = [];
    window.__answer = true;
    window.webkit = { messageHandlers: { mm: { postMessage: m => {
      window.__sent.push(m);
      if (m.type !== 'embedRead' || !window.__answer) return;
      const out = {};
      m.names.forEach(n => {
        if (n.indexOf('/') === 0 || n.indexOf('..') > -1) { out[n] = { error: 'outside' }; return; }
        const file = /\.[a-z0-9]+$/i.test(n) ? n : n + '.md';
        const key = file.split('/').pop();
        if (Object.prototype.hasOwnProperty.call(files, key)) out[n] = { text: files[key] };
        else out[n] = { error: 'missing' };
      });
      setTimeout(() => window.App.setEmbeds(out), 0);
    } } } };
  }, FILES);

  await page.goto(pageURL);
  await page.waitForFunction(() => window.App && window.__sent.some(m => m.type === 'ready'));

  const load = async (text, mode) => {
    await page.evaluate(a => { App.loadDoc(a.t, 'book.md', '/docs'); MM.setMode(a.m || 'live'); },
                        { t: text, m: mode });
    await page.waitForTimeout(350);
    await page.evaluate(() => { const ta = document.querySelector('.blk-edit'); if (ta) ta.blur(); });
    await page.waitForTimeout(250);
  };

  const figures = () => page.evaluate(() =>
    Array.from(document.querySelectorAll('#doc figure.embed')).map(f => ({
      name: f.getAttribute('data-embed'),
      body: f.querySelector('.embed-body') ? f.querySelector('.embed-body').innerHTML : '',
      text: f.querySelector('.embed-body') ? f.querySelector('.embed-body').textContent.trim() : '',
      caption: f.querySelector('figcaption') ? f.querySelector('figcaption').textContent : null,
      error: f.querySelector('.embed-error') ? f.querySelector('.embed-error').textContent : null
    })));
  const asked = () => page.evaluate(() =>
    window.__sent.filter(m => m.type === 'embedRead').map(m => m.names.join(',')));
  const docText = () => page.evaluate(() => document.querySelector('#doc').textContent);
  const blockCount = () => page.evaluate(() => document.querySelectorAll('#doc .blk').length);

  console.log('\nan embed on a line of its own\n');

  await load('Opening line.\n\n![[chapter-two]]\n\nClosing line.');
  let f = await figures();
  ok('the line becomes an embed', f.length === 1 && f[0].name === 'chapter-two',
     JSON.stringify(f.map(x => x.name)));
  ok('the file’s text is rendered into it', /kestrel returned at dusk/i.test(f[0].text),
     'body was: ' + f[0].text);
  ok('and rendered as markdown, not as text',
     /<h2/i.test(f[0].body), 'body was: ' + f[0].body.slice(0, 120));
  ok('the prose around it is untouched',
     (await docText()).indexOf('Opening line.') > -1 && (await docText()).indexOf('Closing line.') > -1);

  ok('the writer’s blocks still map one to one', (await blockCount()) === 3,
     'rendered ' + (await blockCount()) + ' blocks for 3 source blocks');

  console.log('\nwhat is not an embed\n');

  await load('Prose with ![[chapter-two]] in the middle of it.');
  f = await figures();
  ok('an embed with prose on the line is prose', f.length === 0,
     'got ' + f.length + ' embeds');

  await load('About embeds:\n\n```\n![[chapter-two]]\n```\n');
  f = await figures();
  ok('an embed inside a fence is text about embeds', f.length === 0,
     'got ' + f.length + ' embeds');
  ok('and the syntax survives verbatim for the reader',
     (await docText()).indexOf('![[chapter-two]]') > -1);

  console.log('\none level deep, so a cycle cannot form\n');

  await load('![[self]]');
  f = await figures();
  ok('a file that embeds itself renders once', f.length === 1);
  ok('and says the inner one was not expanded',
     /not expanded/i.test(f[0].text), 'body was: ' + f[0].text);
  ok('without recursing into it',
     f[0].body.indexOf('data-embed') === -1, 'body still holds a live embed');
  ok('the file’s own prose is still there',
     /Before\./.test(f[0].text) && /After\./.test(f[0].text));

  await load('![[outer]]');
  f = await figures();
  ok('a chapter embedded inside an embedded file is also left alone',
     /not expanded/i.test(f[0].text) && /Outer opens\./.test(f[0].text),
     'body was: ' + f[0].text);

  await load('![[fenced]]');
  f = await figures();
  ok('but an embed inside a fence inside an embedded file stays text',
     !/not expanded/i.test(f[0].text) && /!\[\[chapter-two\]\]/.test(f[0].text),
     'body was: ' + f[0].text);

  console.log('\nkinds\n');

  await load('![[notes.txt]]');
  f = await figures();
  ok('a .txt file embeds', /Plain text, no markdown/.test(f[0].text), 'body: ' + f[0].text);

  await load('![[figures.csv]]');
  f = await figures();
  ok('a CSV becomes a table', /<table/i.test(f[0].body), 'body: ' + f[0].body.slice(0, 120));
  ok('with the first row as its header', /<th[^>]*>Bird<\/th>/i.test(f[0].body),
     'body: ' + f[0].body.slice(0, 200));
  ok('and quoted commas kept inside one cell',
     /Two adults, one juvenile/.test(f[0].text), 'body: ' + f[0].text);
  const cells = await page.evaluate(() =>
    Array.from(document.querySelectorAll('#doc figure.embed tbody tr')).map(tr => tr.children.length));
  ok('every row has the header’s number of cells', cells.every(n => n === 3),
     'row widths: ' + cells.join(','));

  await load('![[thin.csv]]');
  f = await figures();
  ok('a CSV with no data rows says so', /header row/i.test(f[0].error || ''),
     'error was: ' + f[0].error);

  await load('![[diagram.png]]');
  f = await figures();
  ok('an image embeds without asking the shell for its text',
     /<img/i.test(f[0].body), 'body: ' + f[0].body);
  ok('resolved against the document’s folder',
     /file:\/\/\/docs\/diagram\.png/.test(f[0].body), 'body: ' + f[0].body);
  const askedForImage = (await asked()).some(a => a.indexOf('diagram.png') > -1);
  ok('and no round trip was spent on it', !askedForImage,
     'asked: ' + (await asked()).join(' | '));

  await load('![[archive.zip]]');
  f = await figures();
  ok('a kind minimark cannot embed says which kinds it can',
     /markdown, text, CSV and images/i.test(f[0].error || ''), 'error was: ' + f[0].error);

  console.log('\nwhen the shell says no\n');

  await load('![[no-such-note]]');
  f = await figures();
  ok('a missing file names itself', /no-such-note/.test(f[0].error || ''),
     'error was: ' + f[0].error);
  ok('rather than sitting on the placeholder', f[0].error !== null);

  await load('![[../secrets]]');
  f = await figures();
  ok('a name that climbs out is refused by the shell and said so',
     /outside/i.test(f[0].error || ''), 'error was: ' + f[0].error);

  console.log('\none round trip a render, not one an embed\n');

  await page.evaluate(() => { window.__sent.length = 0; });
  await load('![[alpha]]\n\n![[beta]]\n\n![[alpha]]');
  let batches = await asked();
  ok('three embeds, two distinct names, one batch', batches.length === 1,
     'batches: ' + JSON.stringify(batches));
  ok('and the repeated name is asked about once',
     batches.length === 1 && batches[0].split(',').length === 2,
     'batch was: ' + JSON.stringify(batches));

  await page.evaluate(() => { window.__sent.length = 0; });
  await page.evaluate(() => {
    MM.setText('![[alpha]]\n\n![[beta]]\n\n![[alpha]]\n\nOne more paragraph.',
               { immediate: true });
  });
  await page.waitForTimeout(400);
  ok('a re-render of what is already known asks nothing',
     (await asked()).length === 0, 'asked again: ' + JSON.stringify(await asked()));
  ok('and the embeds are still filled in from the cache',
     (await figures()).every(x => x.error === null && x.text.length > 0),
     JSON.stringify(await figures()));

  console.log('\ncaptions\n');

  await load('![[chapter-two|Where the kestrel comes back]]');
  f = await figures();
  ok('a caption after the pipe is drawn under the embed',
     f[0].caption === 'Where the kestrel comes back', 'caption: ' + f[0].caption);
  ok('and the file still resolves by its own name', f[0].name === 'chapter-two');

  console.log('\nwhile the answer is still out\n');

  await page.evaluate(() => { window.__answer = false; });
  await load('![[waiting]]');
  const waiting = await page.evaluate(() =>
    !!document.querySelector('#doc figure.embed .embed-wait'));
  ok('the placeholder names the file it is waiting for', waiting);
  await page.evaluate(() => { window.__answer = true; });

  console.log('\nsplit view\n');

  await load('![[chapter-two]]', 'split');
  f = await figures();
  ok('the preview renders the embed there too', f.length === 1 && /dusk/.test(f[0].text));
  const src = await page.evaluate(() => document.querySelector('#src').value);
  ok('and the source still holds what the writer typed', src.trim() === '![[chapter-two]]',
     'source was: ' + JSON.stringify(src));

  console.log('');
  ok('no uncaught errors anywhere in the run', errors.length === 0, errors.join('\n        '));

  await browser.close();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
