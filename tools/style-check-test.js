#!/usr/bin/env node
/* ============================================================
   minimark — style check tests

   Two halves, tested two ways.

   The matcher is pure and is tested directly, by loading the real
   style-check.js rather than a copy of its rules. That is deliberate: the
   image test suite already has a file that re-implements its subject "line
   for line" and concedes in its own header that it is worthless once the two
   drift. Nothing here can drift, because nothing here is a second copy.

   The marking is a DOM job and is tested in the browser: what gets marked,
   what is left alone, and above all what happens to the caret, because these
   marks sit inside the same rendered blocks the selection and click handlers
   measure their offsets against.

   Usage:  node tools/style-check-test.js [resourcesDir]
   ============================================================ */

const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const vm = require('vm');

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

/* ------------------------------------------------- the matcher, directly */
/* Run the shipped file in a sandbox with a window to hang itself off. No
   copy, no stub, no second dictionary. */
const sandbox = { window: {} };
vm.runInNewContext(fs.readFileSync(path.join(resDir, 'style-check.js'), 'utf8'), sandbox);
const MMStyle = sandbox.window.MMStyle;

const kinds = t => MMStyle.scan(t).map(h => h.kind + ':' + h.text.toLowerCase());

console.log('the matcher\n');

ok('finds a filler word', kinds('This is very good.').join() === 'filler:very');
ok('finds a cliché', kinds('At the end of the day it shipped.').join() === 'cliche:at the end of the day');
ok('finds a redundancy', kinds('Read the past history.').join() === 'redundancy:past history');

ok('is case insensitive', kinds('Very good, VERY good.').join() === 'filler:very,filler:very');

/* The one that catches a naive implementation: a dictionary word living
   inside a longer word is not that word. */
ok('does not fire inside a longer word',
   MMStyle.scan('I had to adjust the verystrong justification.').length === 0,
   JSON.stringify(kinds('I had to adjust the verystrong justification.')));

/* Longest-first alternation. "in order to" must come back as one filler, not
   as some shorter fragment plus a leftover. */
ok('prefers the longer phrase where two overlap',
   kinds('We did it in order to finish.').join() === 'filler:in order to',
   JSON.stringify(kinds('We did it in order to finish.')));

/* A phrase the writer broke across a line is still that phrase. */
ok('matches a phrase across a line break',
   kinds('At the end\nof the day.').join() === 'cliche:at the end\nof the day',
   JSON.stringify(kinds('At the end\nof the day.')));

ok('reports hits in document order',
   kinds('Very truly at the end of the day the past history.').join() ===
   'filler:very,cliche:at the end of the day,redundancy:past history',
   JSON.stringify(kinds('Very truly at the end of the day the past history.')));

ok('every hit carries a reason',
   MMStyle.scan('Very. At the end of the day. Past history.').every(h => h.why && h.why.length > 4));

ok('clean prose is left completely alone',
   MMStyle.scan('The cat sat on the mat and watched the rain come down.').length === 0,
   JSON.stringify(kinds('The cat sat on the mat and watched the rain come down.')));

const counts = MMStyle.counts();
ok('all three lists are populated',
   counts.filler > 40 && counts.cliche > 40 && counts.redundancy > 60,
   JSON.stringify(counts));

/* ------------------------------------------------------- the marking, live */
const DOC = [
  'This is very good and at the end of the day it works.',
  'Read the past history first.',
  '```\nvar just = 1; // very much code\n```',
  'Nothing wrong with this sentence at all.'
].join('\n\n');

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
    await page.evaluate(a => { App.loadDoc(a.t, 'p.md', '/docs'); MM.setMode(a.m); },
                        { t: text, m: mode || 'live' });
    await page.waitForTimeout(350);
    await page.evaluate(() => { const ta = document.querySelector('.blk-edit'); if (ta) ta.blur(); });
    await page.waitForTimeout(150);
  };
  const toggle = () => page.evaluate(() => App.command('styleCheck'));
  /* the repaint is debounced behind the render on purpose; wait it out */
  const settle = () => page.waitForTimeout(500);
  const marks = () => page.evaluate(() =>
    Array.from(document.querySelectorAll('#doc mark.smark')).map(m => ({
      kind: m.className.replace('smark smark-', ''), text: m.textContent, why: m.title
    })));

  console.log('\nthe marking\n');

  await load(DOC);
  ok('nothing is marked until it is turned on', (await marks()).length === 0);

  await toggle();
  await settle();
  let m = await marks();
  ok('turning it on marks the prose', m.length === 3, JSON.stringify(m));
  ok('one of each category',
     m.map(x => x.kind).sort().join() === 'cliche,filler,redundancy', JSON.stringify(m));
  ok('each mark carries its reason as a tooltip', m.every(x => x.why && x.why.indexOf(':') > 0),
     JSON.stringify(m));

  /* The one that matters most. "just" and "very" inside a code fence are a
     variable name and a comment, not prose, and marking them is the fastest
     way to get the whole feature switched off. */
  ok('code is left alone', !m.some(x => x.text === 'just'), JSON.stringify(m));

  /* And the second one that matters: these marks live inside the same blocks
     the click handler measures a caret against, so a mark must not move the
     caret. Click a known character and check where the caret lands. */
  const caret = await page.evaluate(() => {
    const blk = document.querySelectorAll('#doc .blk')[1];
    const r = blk.getBoundingClientRect();
    return { x: r.x + 3, y: r.y + r.height / 2 };
  });
  await page.mouse.click(caret.x, caret.y);
  await page.waitForTimeout(250);
  const where = await page.evaluate(() => {
    const ed = document.querySelector('.blk.editing');
    const ta = ed && ed.querySelector('.blk-edit');
    return ta ? { i: ed.dataset.i, caret: ta.selectionStart, value: ta.value } : null;
  });
  ok('a marked block still opens with the caret where it was clicked',
     !!where && where.i === '1' && where.caret <= 1 && where.value === 'Read the past history first.',
     JSON.stringify(where));
  ok('and the block being written in carries no marks at all',
     await page.evaluate(() => !document.querySelector('.blk.editing mark.smark')));

  await page.evaluate(() => { const ta = document.querySelector('.blk-edit'); if (ta) ta.blur(); });
  await settle();

  /* Editing the document must not leave stale marks welded into the text. */
  const before = await page.evaluate(() => document.querySelector('#src').value);
  await page.evaluate(() => App.command('styleCheck'));
  await settle();
  ok('turning it off takes every mark out again', (await marks()).length === 0);
  ok('and gives the text back exactly as it was',
     await page.evaluate(() => document.querySelector('#src').value) === before);
  ok('and the document itself was never touched', before === DOC, JSON.stringify(before));

  /* The count in the status bar, and stepping through with it. */
  await toggle();
  await settle();
  const st = await page.evaluate(() => {
    const s = document.querySelector('#stStyle');
    return { hidden: s.hidden, text: s.textContent, title: s.title };
  });
  ok('the count appears in the status bar', !st.hidden && st.text.indexOf('3') === 0,
     JSON.stringify(st));
  ok('and breaks down by category in its tooltip',
     /filler/.test(st.title) && /cliché/.test(st.title) && /redundancy/.test(st.title),
     JSON.stringify(st));

  await page.click('#stStyle');
  await page.waitForTimeout(200);
  ok('clicking it steps to a hit',
     await page.evaluate(() => !!document.querySelector('#doc mark.smark.cur')));
  await page.click('#stStyle');
  await page.waitForTimeout(200);
  ok('and only ever one is current',
     await page.evaluate(() => document.querySelectorAll('#doc mark.smark.cur').length) === 1);

  /* It has to survive the document being rebuilt under it, which happens on
     every commit, every tab switch and every external change. */
  await load(DOC);
  await settle();
  ok('it is still on after the document is reloaded, and repaints',
     (await marks()).length === 3, JSON.stringify(await marks()));

  ok('the toggle is remembered',
     await page.evaluate(() =>
       window.__sent.some(x => x.type === 'pref' && x.key === 'styleCheck' && x.value === '1')));

  ok('no uncaught errors anywhere in the run', errors.length === 0, errors.join('\n        '));

  await browser.close();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
