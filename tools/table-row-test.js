#!/usr/bin/env node
/* ============================================================
   minimark — table row tests

   Adding a row to a markdown table by hand means counting pipes, matching
   the spacing of the rows either side, and remembering that the dashes are
   not a row at all. Three commands do it instead — a row above, a row
   below, and the row the caret is in gone — and they have to behave the
   same whether the caret is in a block's own textarea in live view or
   somewhere in the whole document in split view.

   What is held here: both views, both surfaces (the Format menu's command
   names and the palette), the delimiter never moving or being copied, the
   two refusals (the header, and the only row there is), a ragged table
   deciding on one column count, a caret nowhere near a table saying so
   rather than doing something, and one ⌘Z putting the table back.

   Same shape as live-edit-test.js: the real web layer in a headless
   browser with a stand-in shell, driven the way a person drives it.

   Usage:  node tools/table-row-test.js [resourcesDir]
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
     `got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`);

/* An aligned table, which is the shape a writer notices being broken. The
   blank row it should produce is spelled out rather than computed, so a
   change to the spacing rule has to be admitted to here. */
const HEAD = '| Item  | Qty |';
const DELIM = '| ----- | --- |';
const BOLTS = '| Bolts | 12  |';
const NUTS = '| Nuts  | 7   |';
const BLANK = '|       |     |';

const DOC = [
  '# Stock',
  '',
  HEAD,
  DELIM,
  BOLTS,
  NUTS,
  '',
  'Everything under the table is prose.',
  ''
].join('\n');

/* the table block on its own, as live view hands it over */
const TABLE = [HEAD, DELIM, BOLTS, NUTS].join('\n');

const COMPACT = ['|Item|Qty|', '|-|-|', '|Bolts|12|'].join('\n');
const RAGGED = ['| a | b | c |', '| --- | --- | --- |', '| 1 |', '| 1 | 2 | 3 | 4 |'].join('\n');
const ONEROW = [HEAD, DELIM, BOLTS].join('\n');

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1080, height: 800 } });

  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

  await page.addInitScript(() => {
    window.__sent = [];
    window.webkit = { messageHandlers: { mm: { postMessage: m => window.__sent.push(m) } } };
  });
  await page.goto(pageURL);
  await page.waitForFunction(() => window.App && window.__sent.some(m => m.type === 'ready'));

  /* The document as it stands including whatever block is open, which in
     live view is the only place a just-made change lives until it commits. */
  const doc = () => page.evaluate(() => MM.docText());
  const rows = async () => (await doc()).split('\n').filter(l => l.trim().startsWith('|'));
  const cmd = name => page.evaluate(n => App.command(n), name);

  const load = async (text, mode) => {
    await page.evaluate(a => { App.loadDoc(a.t, 'stock.md', '/docs'); MM.setMode(a.m); },
                        { t: text, m: mode });
    await page.waitForTimeout(300);
    await page.evaluate(() => {
      const ta = document.querySelector('.blk-edit'); if (ta) ta.blur();
      document.querySelector('#toast').classList.remove('show');
    });
    await page.waitForTimeout(150);
  };

  /* Split view: one field holding the whole document, so the caret is a
     document offset. */
  const caretSplit = off => page.evaluate(o => {
    const t = document.querySelector('#src');
    t.focus(); t.setSelectionRange(o, o);
  }, off);

  /* Live view: open the block and put the caret at an offset inside it.
     editBlock leaves an already-open block alone, so the range is set after
     it either way. */
  const caretLive = (i, off) => page.evaluate(a => {
    MM.editBlock(a.i, a.o, false);
    const ta = document.querySelector('.blk-edit');
    if (ta) ta.setSelectionRange(a.o, a.o);
  }, { i, o: off });

  const caretNow = () => page.evaluate(() => {
    const ta = document.querySelector('.blk.editing .blk-edit') ||
               (MM.state.mode === 'split' ? document.querySelector('#src') : null);
    if (!ta) return null;
    const v = ta.value, s = ta.selectionStart;
    const ls = v.lastIndexOf('\n', s - 1) + 1;
    let le = v.indexOf('\n', s); if (le === -1) le = v.length;
    return { line: v.slice(ls, le), col: s - ls };
  });

  const toastNow = () => page.evaluate(() => {
    const t = document.querySelector('#toast');
    return t.classList.contains('show') ? t.textContent : '';
  });
  const clearToast = () => page.evaluate(() => document.querySelector('#toast').classList.remove('show'));

  const settle = () => page.waitForTimeout(160);

  // =========================================================== split view
  console.log('split view\n');

  await load(DOC, 'split');
  await caretSplit(DOC.indexOf(BOLTS) + 4);
  await cmd('tableRowBelow');
  await settle();
  eq('a row below lands under the row the caret was in',
     await rows(), [HEAD, DELIM, BOLTS, BLANK, NUTS]);
  eq('and the caret is in its first cell', await caretNow(), { line: BLANK, col: 2 });

  ok('one undo puts the table back', await page.evaluate(() => MM.undo()));
  await settle();
  eq('…exactly as it was', await doc(), DOC);

  await load(DOC, 'split');
  await caretSplit(DOC.indexOf(BOLTS) + 4);
  await cmd('tableRowAbove');
  await settle();
  eq('a row above lands over it', await rows(), [HEAD, DELIM, BLANK, BOLTS, NUTS]);
  eq('with the caret in the new row, not the old one', await caretNow(), { line: BLANK, col: 2 });

  await load(DOC, 'split');
  await caretSplit(DOC.indexOf(BOLTS) + 4);
  await cmd('tableRowDelete');
  await settle();
  eq('delete takes out the row the caret was in', await rows(), [HEAD, DELIM, NUTS]);
  eq('and leaves the caret on the row that moved up', await caretNow(), { line: NUTS, col: 2 });
  ok('undo brings the deleted row back', await page.evaluate(() => MM.undo()));
  await settle();
  eq('…with the whole document intact', await doc(), DOC);

  /* Nothing above may touch the prose either side of the table. */
  await load(DOC, 'split');
  await caretSplit(DOC.indexOf(NUTS) + 4);
  await cmd('tableRowBelow');
  await settle();
  eq('a row at the bottom does not run into the prose under it',
     (await doc()).split('\n\n'),
     ['# Stock', [HEAD, DELIM, BOLTS, NUTS, BLANK].join('\n'),
      'Everything under the table is prose.\n']);

  // ------------------------------------------------- the structural rows
  console.log('\nthe rows that are the table rather than in it\n');

  await load(DOC, 'split');
  await caretSplit(DOC.indexOf(HEAD) + 4);
  await cmd('tableRowBelow');
  await settle();
  eq('a row below the header becomes the first row of the body, under the dashes',
     await rows(), [HEAD, DELIM, BLANK, BOLTS, NUTS]);

  await load(DOC, 'split');
  await caretSplit(DOC.indexOf(HEAD) + 4);
  await cmd('tableRowAbove');
  await settle();
  eq('and so does a row asked for above it, which would otherwise be the new header',
     await rows(), [HEAD, DELIM, BLANK, BOLTS, NUTS]);

  await load(DOC, 'split');
  await caretSplit(DOC.indexOf(DELIM) + 4);
  await cmd('tableRowAbove');
  await settle();
  eq('nothing can be pushed between the header and its dashes',
     await rows(), [HEAD, DELIM, BLANK, BOLTS, NUTS]);

  await load(DOC, 'split');
  await caretSplit(DOC.indexOf(DELIM) + 4);
  await cmd('tableRowBelow');
  await settle();
  eq('a row below the dashes is the first body row', await rows(), [HEAD, DELIM, BLANK, BOLTS, NUTS]);

  await load(DOC, 'split');
  await clearToast();
  await caretSplit(DOC.indexOf(HEAD) + 4);
  await cmd('tableRowDelete');
  await settle();
  eq('deleting the header is refused — it would be deleting the table', await doc(), DOC);
  eq('and says so', await toastNow(), 'The header row has to stay');

  await load(DOC, 'split');
  await clearToast();
  await caretSplit(DOC.indexOf(DELIM) + 4);
  await cmd('tableRowDelete');
  await settle();
  eq('so is deleting the dashes', await doc(), DOC);
  eq('with the same answer', await toastNow(), 'The header row has to stay');

  await load(ONEROW, 'split');
  await caretSplit(ONEROW.indexOf(BOLTS) + 4);
  await cmd('tableRowDelete');
  await settle();
  eq('the last body row goes, and the header and dashes stay',
     await doc(), [HEAD, DELIM].join('\n'));
  eq('with the caret in the header, which is the nearest row left',
     await caretNow(), { line: HEAD, col: 2 });

  await load(ONEROW, 'split');
  await caretSplit(ONEROW.indexOf(BOLTS) + 4);
  await cmd('tableRowDelete');
  await settle();
  await cmd('tableRowBelow');
  await settle();
  eq('and an emptied table takes a row again', await rows(), [HEAD, DELIM, BLANK]);

  await load('| solo |', 'split');
  await clearToast();
  await caretSplit(3);
  await cmd('tableRowDelete');
  await settle();
  eq('a table of one row keeps it rather than leaving nothing', await doc(), '| solo |');
  eq('and says why', await toastNow(), 'That is the only row left');

  // -------------------------------------------------------- other shapes
  console.log('\ntables written other ways\n');

  await load(COMPACT, 'split');
  await caretSplit(COMPACT.indexOf('|Bolts') + 3);
  await cmd('tableRowBelow');
  await settle();
  eq('a compact table gets a compact row', await rows(),
     ['|Item|Qty|', '|-|-|', '|Bolts|12|', '|     |  |']);

  await load(RAGGED, 'split');
  await caretSplit(RAGGED.indexOf('| 1 |\n') + 2);
  await cmd('tableRowBelow');
  await settle();
  eq('a ragged table counts its columns off the dashes, wherever the caret was',
     (await rows())[3], '|   | | |');

  await load(RAGGED, 'split');
  await caretSplit(RAGGED.indexOf('| 1 | 2 | 3 | 4 |') + 2);
  await cmd('tableRowAbove');
  await settle();
  eq('and gives the same count from a row with too many cells as from one with too few',
     (await rows()).filter(l => /^\|[ |]*\|$/.test(l)).map(l => l.split('|').length - 2), [3]);

  await load(RAGGED, 'split');
  await caretSplit(RAGGED.indexOf('| 1 |\n') + 2);
  await cmd('tableRowDelete');
  await settle();
  eq('and a short row can still be deleted', await rows(),
     ['| a | b | c |', '| --- | --- | --- |', '| 1 | 2 | 3 | 4 |']);

  const INDENTED = ['  | a | b |', '  | - | - |', '  | 1 | 2 |'].join('\n');
  await load(INDENTED, 'split');
  await caretSplit(INDENTED.indexOf('  | 1') + 4);
  await cmd('tableRowBelow');
  await settle();
  eq('an indented table keeps its indent', (await doc()).split('\n')[3], '  |   |   |');

  const ESCAPED = ['| a \\| b | c |', '| --- | --- |', '| 1 | 2 |'].join('\n');
  await load(ESCAPED, 'split');
  await caretSplit(ESCAPED.indexOf('| 1 | 2 |') + 2);
  await cmd('tableRowBelow');
  await settle();
  eq('an escaped pipe inside a cell is not a column boundary',
     (await doc()).split('\n')[3].split('|').length - 2, 2);

  // ------------------------------------------- nowhere near a table
  console.log('\nthe caret somewhere else\n');

  await load(DOC, 'split');
  await clearToast();
  await caretSplit(DOC.indexOf('Everything under') + 4);
  await cmd('tableRowBelow');
  await settle();
  eq('a caret in prose changes nothing', await doc(), DOC);
  eq('and is told where the command works', await toastNow(), 'Put the caret in a table row');

  await load(DOC, 'split');
  await clearToast();
  await caretSplit(DOC.indexOf('Everything under') + 4);
  await cmd('tableRowDelete');
  await settle();
  eq('nor does deleting from prose take a line out', await doc(), DOC);

  const FENCED = ['```', '| a | b |', '| - | - |', '| 1 | 2 |', '```'].join('\n');
  await load(FENCED, 'split');
  await clearToast();
  await caretSplit(FENCED.indexOf('| 1 | 2 |') + 2);
  await cmd('tableRowBelow');
  await settle();
  eq('a table drawn inside a code fence is text, and is left alone', await doc(), FENCED);
  eq('and says the caret is not in a table', await toastNow(), 'Put the caret in a table row');

  const AFTER = ['| a | b |', '| - | - |', '| 1 | 2 |', 'Trailing line, no blank line before it'].join('\n');
  await load(AFTER, 'split');
  await clearToast();
  await caretSplit(AFTER.indexOf('Trailing') + 3);
  await cmd('tableRowBelow');
  await settle();
  eq('a line under the last row is not a row', await doc(), AFTER);

  await load(AFTER, 'split');
  await caretSplit(AFTER.indexOf('| 1 | 2 |') + 2);
  await cmd('tableRowBelow');
  await settle();
  eq('and the new row goes above it, not after it',
     (await doc()).split('\n'), ['| a | b |', '| - | - |', '| 1 | 2 |', '|   |   |',
                                 'Trailing line, no blank line before it']);

  // ============================================================ live view
  console.log('\nlive view\n');

  await load(DOC, 'live');
  await caretLive(1, TABLE.indexOf(BOLTS) + 4);
  await cmd('tableRowBelow');
  await settle();
  eq('a row below, with the caret inside the open block',
     await rows(), [HEAD, DELIM, BOLTS, BLANK, NUTS]);
  eq('the caret is in the new row here too', await caretNow(), { line: BLANK, col: 2 });
  ok('the block is still open, so the writer can type straight into it',
     await page.evaluate(() => !!document.querySelector('.blk.editing .blk-edit')));

  /* Leaving the block writes it back to the document — the ordinary path, so
     a row added in live view has to survive it. */
  await page.evaluate(() => document.querySelector('.blk-edit').blur());
  await settle();
  eq('and it is in the document once the block closes',
     await doc(), DOC.replace(BOLTS + '\n' + NUTS, BOLTS + '\n' + BLANK + '\n' + NUTS));

  await load(DOC, 'live');
  await caretLive(1, TABLE.indexOf(BOLTS) + 4);
  await cmd('tableRowAbove');
  await settle();
  eq('a row above', await rows(), [HEAD, DELIM, BLANK, BOLTS, NUTS]);

  await load(DOC, 'live');
  await caretLive(1, TABLE.indexOf(BOLTS) + 4);
  await cmd('tableRowDelete');
  await settle();
  eq('and a delete', await rows(), [HEAD, DELIM, NUTS]);
  eq('with the caret on the row that moved up', await caretNow(), { line: NUTS, col: 2 });

  ok('undo works from inside an open block', await page.evaluate(() => MM.undo()));
  await settle();
  eq('and puts the whole document back', await doc(), DOC);

  await load(DOC, 'live');
  await clearToast();
  await caretLive(1, TABLE.indexOf(HEAD) + 4);
  await cmd('tableRowDelete');
  await settle();
  eq('the header refusal holds in live view', await doc(), DOC);
  eq('and says the same thing', await toastNow(), 'The header row has to stay');

  await load(DOC, 'live');
  await clearToast();
  await caretLive(0, 3);
  await cmd('tableRowBelow');
  await settle();
  eq('a caret in a heading block changes nothing', await doc(), DOC);
  eq('and says where the command works', await toastNow(), 'Put the caret in a table row');

  await load(DOC, 'live');
  await caretLive(1, TABLE.indexOf(HEAD) + 4);
  await cmd('tableRowBelow');
  await settle();
  eq('a row below the header is the first body row in live view too',
     await rows(), [HEAD, DELIM, BLANK, BOLTS, NUTS]);

  // ------------------------------------------------------- the palette
  console.log('\nfrom the command palette\n');

  const choose = async (title) => {
    await page.keyboard.press('Meta+k');
    await page.waitForTimeout(80);
    await page.fill('#pickerInput', title);
    await page.waitForTimeout(40);
    const list = await page.evaluate(() =>
      Array.from(document.querySelectorAll('#pickerList .pk .pk-t')).map(n => n.textContent));
    const at = list.indexOf(title);
    if (at < 0) throw new Error('palette has no "' + title + '": ' + JSON.stringify(list));
    for (let i = 0; i < at; i++) await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(250);
  };

  await load(DOC, 'split');
  await caretSplit(DOC.indexOf(BOLTS) + 4);
  await choose('Table row below');
  eq('split view: the palette runs it', await rows(), [HEAD, DELIM, BOLTS, BLANK, NUTS]);

  await load(DOC, 'split');
  await caretSplit(DOC.indexOf(BOLTS) + 4);
  await choose('Delete table row');
  eq('split view: and the delete', await rows(), [HEAD, DELIM, NUTS]);

  /* The palette commits the open block before it reads the document, so by
     the time the command runs there is no block open at all. It has to pick
     up where the writer left off rather than report no table. */
  await load(DOC, 'live');
  await caretLive(1, TABLE.indexOf(BOLTS) + 4);
  await choose('Table row above');
  eq('live view: the palette finds the row the writer was in',
     await rows(), [HEAD, DELIM, BLANK, BOLTS, NUTS]);
  eq('and leaves the caret in the new row', await caretNow(), { line: BLANK, col: 2 });

  await load(DOC, 'live');
  await caretLive(1, TABLE.indexOf(NUTS) + 4);
  await choose('Delete table row');
  eq('live view: the palette deletes the row the writer was in',
     await rows(), [HEAD, DELIM, BOLTS]);

  // ------------------------------------------- the dashes, throughout
  console.log('\nthe delimiter row, after all of that\n');

  const everyOp = async (mode) => {
    const seen = [];
    for (const op of ['tableRowAbove', 'tableRowBelow', 'tableRowDelete']) {
      for (const at of [HEAD, DELIM, BOLTS, NUTS]) {
        await load(DOC, mode);
        if (mode === 'split') await caretSplit(DOC.indexOf(at) + 4);
        else await caretLive(1, TABLE.indexOf(at) + 4);
        await cmd(op);
        await settle();
        const rs = (await doc()).split('\n').filter(l => l.trim().startsWith('|'));
        seen.push([rs.indexOf(DELIM), rs.filter(l => l === DELIM).length]);
      }
    }
    return seen;
  };

  const splitSeen = await everyOp('split');
  eq('split: the dashes stay on the second line and there is only ever one set',
     splitSeen.every(s => s[0] === 1 && s[1] === 1), true, JSON.stringify(splitSeen));

  const liveSeen = await everyOp('live');
  eq('live: the same', liveSeen.every(s => s[0] === 1 && s[1] === 1), true, JSON.stringify(liveSeen));

  ok('no uncaught errors anywhere in the run', errors.length === 0, errors.join('\n        '));

  await browser.close();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
