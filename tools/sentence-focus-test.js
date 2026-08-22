#!/usr/bin/env node
/* ============================================================
   minimark — sentence focus tests

   Focus mode can light the sentence rather than the paragraph. Two halves:

   The splitter is pure and is tested directly against the shipped function.
   It will never be right about every sentence in English, so what is asserted
   is the set of things it must not get wrong: an abbreviation is not the end
   of a sentence, nor is an initial, nor a decimal point.

   The drawing is the interesting half, and it works the only way it can:
   you cannot dim part of a textarea, so the text is drawn twice — once in a
   layer where each sentence is its own element, once in the transparent
   textarea over the top. The failure mode that matters is the two layers
   drifting apart, because a caret that sits a line away from the text it is
   typing is worse than no focus mode at all. That is measured here as
   geometry, not as classes.

   Usage:  node tools/sentence-focus-test.js [resourcesDir]
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

const P1 = 'One sentence. Two sentences here. And a third one to finish.';

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1100, height: 760 } });
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

  await page.addInitScript(() => {
    window.__sent = [];
    window.webkit = { messageHandlers: { mm: { postMessage: m => window.__sent.push(m) } } };
  });
  await page.goto(pageURL);
  await page.waitForFunction(() => window.App && window.__sent.some(m => m.type === 'ready'));

  const split = t => page.evaluate(x => MM.sentences(x).map(r => x.slice(r[0], r[1])), t);

  console.log('the splitter\n');

  ok('splits on a full stop',
     JSON.stringify(await split('One. Two.')) === '["One. ","Two."]',
     JSON.stringify(await split('One. Two.')));

  ok('and on ? and !',
     (await split('Really? Yes! Good.')).length === 3,
     JSON.stringify(await split('Really? Yes! Good.')));

  ok('treats a run of terminators as one ending',
     (await split('What?! Fine.')).length === 2, JSON.stringify(await split('What?! Fine.')));

  ok('keeps an ellipsis together',
     (await split('Wait... no.')).length === 2, JSON.stringify(await split('Wait... no.')));

  /* The three that a naive split-on-full-stop gets wrong. */
  ok('an abbreviation is not the end of a sentence',
     (await split('Dr. Foster went to Gloucester.')).length === 1,
     JSON.stringify(await split('Dr. Foster went to Gloucester.')));

  ok('nor is e.g. or i.e.',
     (await split('Some things, e.g. this one, are fine.')).length === 1,
     JSON.stringify(await split('Some things, e.g. this one, are fine.')));

  ok('nor an initial',
     (await split('J. R. Hartley wrote it.')).length === 1,
     JSON.stringify(await split('J. R. Hartley wrote it.')));

  ok('nor a decimal point',
     (await split('It cost 3.50 in the end.')).length === 1,
     JSON.stringify(await split('It cost 3.50 in the end.')));

  ok('a closing quote belongs to the sentence it ends',
     JSON.stringify(await split('He said "no." Then he left.')) ===
     '["He said \\"no.\\" ","Then he left."]',
     JSON.stringify(await split('He said "no." Then he left.')));

  ok('text with no terminator at all is one sentence',
     (await split('a heading with no full stop')).length === 1);

  ok('empty text does not explode', (await split('')).length === 1);

  /* The caret on a boundary belongs to what it is about to type. */
  const at = (t, pos) => page.evaluate(a => MM.sentenceAt(MM.sentences(a.t), a.p), { t, p: pos });
  ok('the caret just after a full stop is in the sentence it is starting',
     await at('One. Two.', 5) === 1, String(await at('One. Two.', 5)));
  ok('and in the middle of one it is in that one',
     await at('One. Two.', 1) === 0, String(await at('One. Two.', 1)));

  console.log('\nlive view\n');

  const load = async (mode, text) => {
    await page.evaluate(a => { App.loadDoc(a.t, 'f.md', '/docs'); MM.setMode(a.m); },
                        { t: text, m: mode });
    await page.waitForTimeout(500);
    await page.evaluate(() => { const t = document.querySelector('.blk-edit'); if (t) t.blur(); });
    await page.waitForTimeout(250);
  };
  const settle = () => page.waitForTimeout(700);

  await load('live', '# Title\n\n' + P1 + '\n\nAnother paragraph entirely.');
  await page.evaluate(() => { App.command('focus'); App.command('focusSentence'); });
  await settle();

  /* No block open: there is no caret, so there is no sentence, and it falls
     back to the paragraph rather than guessing. */
  ok('with nothing open there is no mirror and no sentence spans',
     await page.evaluate(() => !document.querySelector('.blk-hl')));

  const box = await page.evaluate(() => {
    const r = document.querySelectorAll('#doc .blk')[1].getBoundingClientRect();
    return { x: r.x + 40, y: r.y + r.height / 2 };
  });
  await page.mouse.click(box.x, box.y);
  await settle();

  ok('opening a block builds the mirror',
     await page.evaluate(() => !!document.querySelector('.blk-hl')));

  const spans = () => page.evaluate(() =>
    Array.from(document.querySelectorAll('.blk-hl .sn')).map(s => ({
      text: s.textContent, cur: s.classList.contains('cur'),
      opacity: parseFloat(getComputedStyle(s).opacity)
    })));
  let sn = await spans();
  ok('one span per sentence', sn.length === 3, JSON.stringify(sn.map(x => x.text)));
  ok('exactly one is lit', sn.filter(x => x.cur).length === 1, JSON.stringify(sn));
  ok('and the others are actually dimmed',
     sn.filter(x => !x.cur).every(x => x.opacity < 0.5), JSON.stringify(sn));

  /* The mirror is only useful if the textarea over it is invisible. */
  const layers = await page.evaluate(() => {
    const ta = document.querySelector('.blk-edit');
    const hl = document.querySelector('.blk-hl');
    const t = ta.getBoundingClientRect(), h = hl.getBoundingClientRect();
    const cs = getComputedStyle(ta);
    return {
      textTransparent: cs.color === 'rgba(0, 0, 0, 0)' || cs.color === 'transparent',
      caretVisible: cs.caretColor !== cs.color,
      dx: Math.abs(t.left - h.left), dy: Math.abs(t.top - h.top),
      dw: Math.abs(t.width - h.width), dh: Math.abs(t.height - h.height)
    };
  });
  ok('the textarea gives up its text to the mirror', layers.textTransparent, JSON.stringify(layers));
  ok('but keeps its caret', layers.caretVisible, JSON.stringify(layers));
  /* This is the assertion the whole feature rests on. */
  ok('and the two layers sit exactly on top of each other',
     layers.dx < 1 && layers.dy < 1 && layers.dw < 1 && layers.dh < 2, JSON.stringify(layers));

  /* Moving the caret moves the light. */
  await page.evaluate(() => {
    const ta = document.querySelector('.blk-edit');
    ta.setSelectionRange(0, 0);
    ta.dispatchEvent(new Event('select', { bubbles: true }));
  });
  await settle();
  sn = await spans();
  ok('putting the caret in the first sentence lights the first',
     sn[0].cur && !sn[1].cur, JSON.stringify(sn.map(x => x.cur)));

  await page.evaluate(() => {
    const ta = document.querySelector('.blk-edit');
    ta.setSelectionRange(ta.value.length, ta.value.length);
    ta.dispatchEvent(new Event('select', { bubbles: true }));
  });
  await settle();
  sn = await spans();
  ok('and at the end, the last', sn[sn.length - 1].cur, JSON.stringify(sn.map(x => x.cur)));

  /* Typing has to keep the mirror in step, or it is worse than useless. */
  await page.keyboard.type(' Extra.');
  await settle();
  sn = await spans();
  ok('typing a new sentence extends the mirror and lights it',
     sn.length === 4 && sn[3].cur, JSON.stringify(sn.map(x => x.text)));
  const mirrored = await page.evaluate(() => {
    const ta = document.querySelector('.blk-edit');
    const hl = document.querySelector('.blk-hl');
    return ta.value === hl.textContent.replace(/\n$/, '');
  });
  ok('and the mirror says exactly what the textarea says', mirrored);

  console.log('\nback to paragraph\n');

  await page.evaluate(() => App.command('focusParagraph'));
  await settle();
  ok('switching back tears the mirror down',
     await page.evaluate(() => !document.querySelector('.blk-hl')));
  ok('and the textarea takes its own text back',
     await page.evaluate(() => {
       const c = getComputedStyle(document.querySelector('.blk-edit')).color;
       return c !== 'rgba(0, 0, 0, 0)' && c !== 'transparent';
     }));

  console.log('\nsplit view\n');

  await load('split', P1 + '\n\nAnother line entirely.');
  await page.evaluate(() => {
    const ta = document.querySelector('#src');
    ta.focus(); ta.setSelectionRange(20, 20);
    MM.markCurrentLine();
  });
  await page.evaluate(() => { App.command('focus'); App.command('focusSentence'); });
  await settle();
  const srcSpans = await page.evaluate(() =>
    Array.from(document.querySelectorAll('#hl .ln.cur .sn')).map(s => ({
      text: s.textContent, cur: s.classList.contains('cur'),
      opacity: parseFloat(getComputedStyle(s).opacity)
    })));
  ok('the caret\'s line is split into sentences', srcSpans.length === 3,
     JSON.stringify(srcSpans.map(x => x.text)));
  ok('one of them is lit and the rest are dimmed',
     srcSpans.filter(x => x.cur).length === 1 &&
     srcSpans.filter(x => !x.cur).every(x => x.opacity < 0.5), JSON.stringify(srcSpans));

  /* And the source text itself must come through untouched — the spans go in
     around the syntax tint, not through it. */
  ok('the line still reads exactly as written',
     await page.evaluate(() => document.querySelector('#hl .ln.cur').textContent) ===
     P1, await page.evaluate(() => document.querySelector('#hl .ln.cur').textContent));

  await page.evaluate(() => App.command('focusParagraph'));
  await settle();
  ok('and switching back leaves no spans behind',
     await page.evaluate(() => document.querySelectorAll('#hl .sn').length) === 0);
  ok('with the text still intact',
     await page.evaluate(() => document.querySelector('#hl .ln.cur').textContent) === P1);

  ok('the level is remembered',
     await page.evaluate(() =>
       window.__sent.some(x => x.type === 'pref' && x.key === 'focusLevel')));

  ok('no uncaught errors anywhere in the run', errors.length === 0, errors.join('\n        '));

  await browser.close();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
