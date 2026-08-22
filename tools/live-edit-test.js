#!/usr/bin/env node
/* ============================================================
   minimark — live view editing tests

   Three things live view got wrong, and the tests that hold them fixed:

     1. a selection spanning rendered blocks could not be deleted, typed
        over, cut or copied as markdown, because only the open block is a
        field and nothing was listening to the document's own selection;
     2. selecting upwards out of an open block closed it and threw the
        selection away, because a textarea's selection is invisible to
        window.getSelection() and the guard that asks it waved the drag on;
     3. there was no way to delete a paragraph without opening it and
        emptying it by hand.

   Same shape as tabs-test.js: the real web layer in a headless browser with
   a stand-in shell, driven the way a person would drive it and read back off
   the DOM, so nothing here can pass by agreeing with itself.

   Usage:  node tools/live-edit-test.js [resourcesDir]
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

/* P2 is deliberately long: an upward drag needs more than one line of block
   to travel through before it reaches the top edge, which is where the bug
   was. */
const P1 = 'First paragraph, short.';
const P2 = 'Second paragraph, the one we drag out of. Long enough that it wraps onto more than one line inside the measure column, so an upward drag has somewhere to travel before it leaves the top edge.';
const P3 = 'Third paragraph, also short.';
const DOC = [P1, P2, P3].join('\n\n');

/* markup, so a splice that used rendered offsets where it needed source ones
   would land in the wrong place and show it */
const MARKED = '# A heading here\n\nSome **bold** words follow.';

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

  const src = () => page.evaluate(() => document.querySelector('#src').value);
  const undo = () => page.evaluate(() => MM.undo());
  /* Arriving in live view opens the block the caret is in, which is what a
     writer wants and what every test below would otherwise have to work
     around. Let it go, so each test starts from a document at rest. */
  const load = async (text, mode) => {
    await page.evaluate((a) => { App.loadDoc(a.t, 'p.md', '/docs'); MM.setMode(a.m); },
                        { t: text, m: mode || 'live' });
    await page.waitForTimeout(350);
    await page.evaluate(() => { const ta = document.querySelector('.blk-edit'); if (ta) ta.blur(); });
    await page.waitForTimeout(150);
  };
  const reset = () => load(DOC);

  /* A selection running from inside the first block into the second, given in
     rendered characters — which is what a person selects with a pointer. */
  const select = async (i0, off0, i1, off1) => {
    /* wait for the render rather than guessing at it: a block that is still a
       bare element has no text node to put an offset in */
    try {
      await page.waitForFunction(ks => ks.every(k => {
        const b = document.querySelectorAll('#doc .blk')[k];
        if (!b) return false;
        return !!document.createTreeWalker(b, NodeFilter.SHOW_TEXT).nextNode();
      }), [i0, i1], { timeout: 3000 });
    } catch (err) {
      console.log('        blocks were: ' +
        await page.evaluate(() => Array.from(document.querySelectorAll('#doc .blk'))
          .map(b => b.outerHTML.slice(0, 90)).join(' | ')));
      throw err;
    }
    return page.evaluate(a => {
      const b = document.querySelectorAll('#doc .blk');
      const node = k => document.createTreeWalker(b[k], NodeFilter.SHOW_TEXT).nextNode();
      const r = document.createRange();
      r.setStart(node(a.i0), a.off0);
      r.setEnd(node(a.i1), a.off1);
      const s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
    }, { i0, off0, i1, off1 });
  };

  const selectWhole = i => page.evaluate(k => {
    const r = document.createRange();
    r.selectNodeContents(document.querySelectorAll('#doc .blk')[k]);
    const s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
  }, i);

  const blockBox = i => page.evaluate(k => {
    const r = document.querySelectorAll('#doc .blk')[k].getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  }, i);

  // ------------------------------------------- a selection across blocks
  console.log('a selection across rendered blocks\n');

  await reset();
  await select(0, 6, 1, 15);
  await page.keyboard.press('Backspace');
  await page.waitForTimeout(250);
  ok('backspace takes the span out and joins what is left',
     await src() === 'First ' + P2.slice(15) + '\n\n' + P3, JSON.stringify(await src()));

  ok('and leaves the writer in the joined block, caret at the join',
     JSON.stringify(await page.evaluate(() => {
       const ed = document.querySelector('.blk.editing');
       const ta = ed && ed.querySelector('.blk-edit');
       return ta ? [ed.dataset.i, ta.selectionStart] : null;
     })) === '["0",6]');

  await undo(); await page.waitForTimeout(250);
  ok('undo puts it back', await src() === DOC, JSON.stringify(await src()));

  await reset();
  await select(0, 6, 1, 15);
  await page.keyboard.press('Delete');
  await page.waitForTimeout(250);
  ok('so does delete', await src() === 'First ' + P2.slice(15) + '\n\n' + P3);

  await reset();
  await select(0, 6, 1, 15);
  await page.keyboard.type('Z');
  await page.waitForTimeout(250);
  ok('typing replaces it', await src() === 'First Z' + P2.slice(15) + '\n\n' + P3,
     JSON.stringify(await src()));

  /* Both separators come out with the block, and what is left has to meet
     across one gap rather than a run of blank lines. */
  await reset();
  await selectWhole(1);
  await page.keyboard.press('Backspace');
  await page.waitForTimeout(250);
  ok('a whole block out leaves one gap, not a run of blank lines',
     await src() === P1 + '\n\n' + P3, JSON.stringify(await src()));

  /* The offsets are source offsets, not rendered ones. Deleting from four
     characters into a heading — which is two characters of '# ' plus two of
     text — must keep the '# ', and the bold that follows must survive whole. */
  await load(MARKED);
  await select(0, 2, 1, 5);
  await page.keyboard.press('Backspace');
  await page.waitForTimeout(250);
  ok('the span is measured in the markdown, not in what it renders to',
     await src() === '# A **bold** words follow.', JSON.stringify(await src()));

  // ------------------------------------------------- what must not happen
  await reset();
  await select(0, 6, 1, 15);
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Shift');
  await page.waitForTimeout(200);
  ok('navigating with a selection up does not touch the document',
     await src() === DOC, JSON.stringify(await src()));

  await load(DOC, 'split');
  await select(0, 6, 1, 15);
  await page.keyboard.press('Backspace');
  await page.waitForTimeout(250);
  ok('and none of this happens in split view, where the textarea owns it',
     await src() === DOC, JSON.stringify(await src()));

  // ------------------------------------------------------- the clipboard
  await reset();
  await select(0, 6, 1, 15);
  const copied = await page.evaluate(() => {
    const dt = new DataTransfer();
    document.dispatchEvent(new ClipboardEvent('copy',
      { clipboardData: dt, bubbles: true, cancelable: true }));
    return dt.getData('text/plain');
  });
  ok('copy hands over the markdown, not the rendered text',
     copied === DOC.slice(6, P1.length + 2 + 15), JSON.stringify(copied));

  await reset();
  await select(0, 6, 1, 15);
  const cutText = await page.evaluate(() => {
    const dt = new DataTransfer();
    document.dispatchEvent(new ClipboardEvent('cut',
      { clipboardData: dt, bubbles: true, cancelable: true }));
    return dt.getData('text/plain');
  });
  await page.waitForTimeout(250);
  ok('cut hands it over and takes it out',
     cutText === DOC.slice(6, P1.length + 2 + 15) &&
     await src() === 'First ' + P2.slice(15) + '\n\n' + P3, JSON.stringify(cutText));

  // ------------------------------- selecting upwards out of an open block
  console.log('\nselecting upwards out of an open block\n');

  await reset();
  const box = await blockBox(1);
  await page.mouse.click(box.x + 60, box.y + box.h - 8);
  await page.waitForTimeout(250);
  ok('the block opens on a click', await page.evaluate(() => !!document.querySelector('.blk.editing')));

  const tb = await page.evaluate(() => {
    const r = document.querySelector('.blk-edit').getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  });
  await page.mouse.move(tb.x + tb.w - 40, tb.y + tb.h - 6);
  await page.mouse.down();
  /* up the block and out through the top of it, which is the whole point */
  for (let i = 1; i <= 16; i++) {
    await page.mouse.move(tb.x + 30, tb.y + tb.h - 6 - (tb.h + 60) * i / 16);
    await page.waitForTimeout(15);
  }
  await page.mouse.up();
  await page.waitForTimeout(300);
  const dragged = await page.evaluate(() => {
    const ta = document.querySelector('.blk-edit');
    return { open: !!document.querySelector('.blk.editing'),
             sel: ta ? [ta.selectionStart, ta.selectionEnd] : null };
  });
  ok('the block is still open once the pointer has left the top of it',
     dragged.open, JSON.stringify(dragged));
  ok('and the selection made on the way survived',
     !!dragged.sel && dragged.sel[1] > dragged.sel[0], JSON.stringify(dragged));

  // ------------------------------------------------------------- the bin
  console.log('\nthe delete affordance\n');

  await reset();
  const b0 = await blockBox(0);
  await page.mouse.move(b0.x + 40, b0.y + 8);
  await page.waitForTimeout(300);
  const binState = await page.evaluate(() => {
    const b = document.querySelector('#blkBin');
    if (!b) return null;
    const r = b.getBoundingClientRect();
    const blk = document.querySelectorAll('#doc .blk')[0].getBoundingClientRect();
    const pane = document.querySelector('#previewPane').getBoundingClientRect();
    return {
      on: b.classList.contains('on'),
      opacity: parseFloat(getComputedStyle(b).opacity),
      clearOfTheText: r.left >= blk.right,
      insideThePane: r.right <= pane.right,
      levelWithTheBlock: Math.abs(r.top - blk.top) < 30,
      insideDoc: document.querySelector('#doc').contains(b)
    };
  });
  ok('it appears on the block under the pointer', !!binState && binState.on, JSON.stringify(binState));
  ok('soft until it is the thing being hovered',
     !!binState && binState.opacity > 0 && binState.opacity < 0.5, JSON.stringify(binState));
  ok('parked in the gutter beside the block, inside the pane',
     !!binState && binState.clearOfTheText && binState.insideThePane && binState.levelWithTheBlock,
     JSON.stringify(binState));
  /* the reason it lives in the pane and not in the block: anything inside a
     .blk lands in the selection, in copied text and in the caret mapping */
  ok('and outside the document itself', !!binState && !binState.insideDoc);

  const at = await page.evaluate(() => {
    const r = document.querySelector('#blkBin').getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  await page.mouse.move(at.x, at.y);
  await page.waitForTimeout(350);
  ok('full strength under the pointer',
     await page.evaluate(() => parseFloat(getComputedStyle(document.querySelector('#blkBin')).opacity)) > 0.9);

  await page.mouse.down(); await page.mouse.up();
  await page.waitForTimeout(300);
  ok('clicking it takes that paragraph out, separator and all',
     await src() === P2 + '\n\n' + P3, JSON.stringify(await src()));

  await undo(); await page.waitForTimeout(250);
  ok('and undo brings it back', await src() === DOC, JSON.stringify(await src()));

  await reset();
  await page.mouse.click(box.x + 60, box.y + box.h - 8);
  await page.waitForTimeout(250);
  await page.mouse.move(box.x + 60, box.y + 10);
  await page.waitForTimeout(300);
  ok('never offered over the block being written in',
     await page.evaluate(() => !document.querySelector('#blkBin').classList.contains('on')));

  await load('Only one paragraph in the whole document.');
  const solo = await blockBox(0);
  await page.mouse.move(solo.x + 40, solo.y + 8);
  await page.waitForTimeout(300);
  ok('nor on the last block standing, which there is nothing to delete to',
     await page.evaluate(() => !document.querySelector('#blkBin').classList.contains('on')));

  await load(DOC, 'split');
  const sBox = await blockBox(0);
  await page.mouse.move(sBox.x + 40, sBox.y + 8);
  await page.waitForTimeout(300);
  ok('nor in split view, where the preview is a preview',
     await page.evaluate(() => !document.querySelector('#blkBin').classList.contains('on')));

  ok('no uncaught errors anywhere in the run', errors.length === 0, errors.join('\n        '));

  await browser.close();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
