#!/usr/bin/env node
/* ============================================================
   minimark — focus mode tests

   Focus mode dims everything but the paragraph you are in. Two things were
   wrong with it and neither showed up anywhere but in use.

   It did nothing at all in live view. staggerBlocks animates each block in
   with fill: 'both', and a filled Web Animation sits above the cascade for
   ever, so every block was pinned at opacity 1 and the focus rule could never
   apply. Switching to live view is what runs the stagger, so this was the
   normal path in. Note what that means for a test: asserting on the class is
   not enough, because the class was always right. These read computed
   opacity, which is the only thing that was actually wrong.

   And with no block open it lit the last paragraph in the file, because it
   asked the hidden source textarea where the caret was and that textarea's
   caret sits wherever the last whole-document assignment left it.

   Usage:  node tools/focus-test.js [resourcesDir]
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

const DOC = ['# Title', 'First paragraph here.', 'Second paragraph here.',
             'Third paragraph here.', 'Fourth paragraph here.'].join('\n\n');

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

  await page.addInitScript(() => {
    window.__sent = [];
    window.webkit = { messageHandlers: { mm: { postMessage: m => window.__sent.push(m) } } };
  });
  await page.goto(pageURL);
  await page.waitForFunction(() => window.App && window.__sent.some(m => m.type === 'ready'));

  const load = async (mode) => {
    await page.evaluate(a => { App.loadDoc(a.t, 'f.md', '/docs'); MM.setMode(a.m); },
                        { t: DOC, m: mode || 'live' });
    await page.waitForTimeout(500);
    await page.evaluate(() => { const t = document.querySelector('.blk-edit'); if (t) t.blur(); });
    await page.waitForTimeout(250);
  };
  /* The stagger runs 430ms with up to 280ms of delay; anything measured
     before that has finished is measuring the animation, not the rule. */
  const settle = () => page.waitForTimeout(900);
  const shape = () => page.evaluate(() => {
    const b = Array.from(document.querySelectorAll('#doc .blk'));
    return {
      lit: b.map((x, i) => x.classList.contains('cur') ? i : null).filter(x => x !== null),
      dimmed: b.map((x, i) => parseFloat(getComputedStyle(x).opacity) < 0.9 ? i : null)
              .filter(x => x !== null),
      bright: b.map((x, i) => parseFloat(getComputedStyle(x).opacity) > 0.9 ? i : null)
              .filter(x => x !== null)
    };
  });
  const focus = () => page.evaluate(() => App.command('focus'));
  const blockAt = i => page.evaluate(k => {
    const r = document.querySelectorAll('#doc .blk')[k].getBoundingClientRect();
    return { x: r.x + 40, y: r.y + r.height / 2 };
  }, i);

  console.log('live view\n');

  await load('live');
  let s = await shape();
  ok('nothing is dimmed before focus mode is on', s.dimmed.length === 0, JSON.stringify(s));

  await focus();
  await settle();
  s = await shape();
  /* The bug: this was all five blocks bright, for ever. */
  ok('turning it on actually dims the document', s.dimmed.length === 4, JSON.stringify(s));
  ok('and lights the first paragraph, not the last',
     s.bright.length === 1 && s.bright[0] === 0, JSON.stringify(s));

  const b3 = await blockAt(3);
  await page.mouse.click(b3.x, b3.y);
  await settle();
  s = await shape();
  ok('clicking a paragraph moves the light to it',
     s.bright.length === 1 && s.bright[0] === 3, JSON.stringify(s));

  await page.keyboard.type(' more');
  await settle();
  s = await shape();
  ok('and typing in it keeps it there',
     s.bright.length === 1 && s.bright[0] === 3, JSON.stringify(s));

  await page.keyboard.press('ArrowUp');
  await settle();
  s = await shape();
  ok('moving up a paragraph takes the light with it',
     s.bright.length === 1 && s.bright[0] === 2, JSON.stringify(s));

  /* The second bug: this used to jump to the last paragraph in the file. */
  await page.evaluate(() => { const t = document.querySelector('.blk-edit'); if (t) t.blur(); });
  await settle();
  s = await shape();
  ok('closing the paragraph leaves the light where you were',
     s.bright.length === 1 && s.bright[0] === 2, JSON.stringify(s));

  await focus();
  await settle();
  s = await shape();
  ok('turning it off brings the whole document back', s.dimmed.length === 0, JSON.stringify(s));

  console.log('\nsplit view\n');

  await load('split');
  await focus();
  await settle();
  const lines = await page.evaluate(() => {
    const l = Array.from(document.querySelectorAll('#hl .ln'));
    return {
      total: l.length,
      dimmed: l.filter(x => parseFloat(getComputedStyle(x).opacity) < 0.9).length
    };
  });
  ok('the source pane dims every line but the caret\'s',
     lines.total > 1 && lines.dimmed === lines.total - 1, JSON.stringify(lines));

  await focus();
  await settle();

  console.log('\nand back again\n');

  /* Switching modes runs the stagger again, which is what pinned the opacity
     the first time round. It has to survive a round trip. */
  await load('live');
  await focus();
  await settle();
  await page.evaluate(() => MM.setMode('split'));
  await page.waitForTimeout(600);
  await page.evaluate(() => MM.setMode('live'));
  await settle();
  s = await shape();
  ok('focus still dims after a trip through split view and back',
     s.dimmed.length === 4, JSON.stringify(s));

  ok('no uncaught errors anywhere in the run', errors.length === 0, errors.join('\n        '));

  await browser.close();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
