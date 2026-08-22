#!/usr/bin/env node
/* ============================================================
   minimark — wikilink tests

   [[Another note]] and [[Another note|called something else here]].

   The parsing is a marked extension rather than a regex pass, so the tests
   that matter are the ones a regex pass would fail: a wikilink inside a code
   span, inside a fence, and next to an ordinary markdown link. Those are the
   reason the extension exists, and without them here the next person to
   "simplify" it back into a `.replace()` would see a green suite.

   The other half is the shell's, and it is not reachable from a browser: what
   a name resolves to on disk, and what happens when the file is not there.
   What is testable here is that the page sends the name and nothing else, and
   that the sanitiser lets exactly the one attribute through that the click
   handler reads.

   Usage:  node tools/wikilink-test.js [resourcesDir]
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
    await page.evaluate(a => { App.loadDoc(a.t, 'note.md', '/docs'); MM.setMode(a.m); },
                        { t: text, m: mode || 'live' });
    await page.waitForTimeout(400);
    await page.evaluate(() => { const ta = document.querySelector('.blk-edit'); if (ta) ta.blur(); });
    await page.waitForTimeout(200);
  };
  const links = () => page.evaluate(() =>
    Array.from(document.querySelectorAll('#doc a.wikilink')).map(a => ({
      target: a.getAttribute('data-wiki'), label: a.textContent, href: a.getAttribute('href')
    })));
  const drain = () => page.evaluate(() => { const s = window.__sent; window.__sent = []; return s; });

  console.log('parsing\n');

  await load('See [[Another note]] for more.');
  let l = await links();
  ok('a bare wikilink renders', l.length === 1 && l[0].target === 'Another note', JSON.stringify(l));
  ok('and shows its target as the label', l.length === 1 && l[0].label === 'Another note', JSON.stringify(l));

  await load('See [[Another note|the other one]] for more.');
  l = await links();
  ok('a piped wikilink keeps the target', l.length === 1 && l[0].target === 'Another note', JSON.stringify(l));
  ok('and shows the label instead', l.length === 1 && l[0].label === 'the other one', JSON.stringify(l));

  /* The reason this is a marked extension and not a regex. */
  await load('Write it as `[[Another note]]` in your document.');
  ok('a wikilink in a code span is left as text', (await links()).length === 0,
     JSON.stringify(await links()));

  await load('```\n[[Another note]]\n```');
  ok('a wikilink in a fence is left as text', (await links()).length === 0,
     JSON.stringify(await links()));

  await load('An [ordinary](https://example.com) link and a [[Wiki one]].');
  l = await links();
  ok('an ordinary link beside one is untouched',
     l.length === 1 && l[0].target === 'Wiki one' &&
     await page.evaluate(() => document.querySelectorAll('#doc a:not(.wikilink)').length) === 1,
     JSON.stringify(l));

  await load('Not a link: [[]] and [[ ]] and [single].');
  ok('an empty target is not a link', (await links()).length === 0, JSON.stringify(await links()));

  await load('Two [[First]] and [[Second|second one]] on a line.');
  l = await links();
  ok('two on one line both come through',
     l.length === 2 && l[0].target === 'First' && l[1].target === 'Second', JSON.stringify(l));

  /* A wikilink is not a URL and must not be given one, or the browser and the
     sanitiser both start having opinions about a filename. */
  ok('a wikilink carries no href at all', l.every(x => x.href === null), JSON.stringify(l));

  console.log('\nthe sanitiser\n');

  /* data-wiki is on the allowlist, which means a document's own raw HTML can
     carry it. That is fine and is checked here rather than assumed: what
     matters is that nothing else rides along with it. */
  await load('<a class="wikilink" data-wiki="Note" onclick="alert(1)" href="javascript:alert(1)">x</a>');
  const raw = await page.evaluate(() => {
    const a = document.querySelector('#doc a');
    return a ? { wiki: a.getAttribute('data-wiki'), onclick: a.getAttribute('onclick'),
                 href: a.getAttribute('href') } : null;
  });
  ok('data-wiki survives the sanitiser', !!raw && raw.wiki === 'Note', JSON.stringify(raw));
  ok('and the handler and the javascript: href do not',
     !!raw && raw.onclick === null && raw.href === null, JSON.stringify(raw));

  console.log('\nfollowing one\n');

  await load('See [[Another note]] for more.');
  await drain();
  await page.click('#doc a.wikilink');
  await page.waitForTimeout(250);
  let sent = (await drain()).filter(m => m.type === 'openWiki');
  ok('clicking one in live view asks the shell to open it',
     sent.length === 1 && sent[0].name === 'Another note', JSON.stringify(sent));
  ok('and does not open the block for editing instead',
     await page.evaluate(() => !document.querySelector('.blk.editing')));

  await load('See [[Another note]] for more.', 'split');
  await drain();
  await page.click('#doc a.wikilink');
  await page.waitForTimeout(250);
  sent = (await drain()).filter(m => m.type === 'openWiki');
  ok('and clicking one in split view does the same',
     sent.length === 1 && sent[0].name === 'Another note', JSON.stringify(sent));

  /* Selecting text that happens to end on a link is not clicking the link. */
  await load('See [[Another note]] for more.');
  await drain();
  await page.evaluate(() => {
    const a = document.querySelector('#doc a.wikilink');
    const r = document.createRange(); r.selectNodeContents(a);
    const s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
  });
  await page.evaluate(() => {
    document.querySelector('#doc a.wikilink')
      .dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  });
  await page.waitForTimeout(200);
  ok('a selection ending on one does not follow it',
     (await drain()).filter(m => m.type === 'openWiki').length === 0);

  console.log('\nthe source pane\n');

  await load('See [[Another note|elsewhere]] now.', 'split');
  const tinted = await page.evaluate(() => {
    const hl = document.querySelector('#hl');
    return hl ? hl.textContent.indexOf('[[Another note|elsewhere]]') > -1 : false;
  });
  ok('the source pane still shows the markdown exactly as written', tinted);
  ok('and tints it as a link rather than leaving the brackets bare',
     await page.evaluate(() =>
       Array.from(document.querySelectorAll('#hl .t-link')).some(n => n.textContent === 'Another note')));

  ok('no uncaught errors anywhere in the run', errors.length === 0, errors.join('\n        '));

  await browser.close();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
