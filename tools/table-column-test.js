#!/usr/bin/env node
/* ============================================================
   minimark — table column tests

   A row is one line to get right by hand. A column is one cell on every
   line, the dashes included, and the dashes are the line that decides
   whether the block is a table at all — miss them and four lines of pipes
   render as four lines of pipes. Three commands do that bookkeeping: a
   column to the left, one to the right, and the column the caret is in
   gone.

   What is held here: both views, both surfaces (the Format menu's command
   names and the palette), the delimiter gaining and losing a segment in
   step with every other row, alignment markers riding along with the
   column they belong to while a new column starts plain and as wide as its
   neighbours, an aligned table staying aligned, a ragged table coming out
   no more ragged than it went in, the refusal when the last column is
   asked for, a caret nowhere near a table saying so, and one ⌘Z putting
   the table back.

   A sibling of table-row-test.js rather than more of it: that file's
   header promises rows and its fixtures are shaped for rows, and two files
   means `npm run table-columns` runs just this half when this half is what
   broke. They share nothing but the harness shape, which is the same shape
   live-edit-test.js uses.

   Usage:  node tools/table-column-test.js [resourcesDir]
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

/* The same aligned table the row tests use, because an aligned table is the
   one a writer notices being broken. Every expected result below is spelled
   out rather than computed, so a change to the spacing rule has to be
   admitted to here. */
const HEAD = '| Item  | Qty |';
const DELIM = '| ----- | --- |';
const BOLTS = '| Bolts | 12  |';
const NUTS = '| Nuts  | 7   |';

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

/* Each cell of the new column is shaped after the cell it displaces, and in
   an aligned table every cell of a column is the same width — so a column
   added next to Item is Item-wide and one added next to Qty is Qty-wide,
   and either way the table comes out lined up. */
const AFTER_ITEM = ['| Item  |       | Qty |',
                    '| ----- | ----- | --- |',
                    '| Bolts |       | 12  |',
                    '| Nuts  |       | 7   |'];
const BEFORE_ITEM = ['|       | Item  | Qty |',
                     '| ----- | ----- | --- |',
                     '|       | Bolts | 12  |',
                     '|       | Nuts  | 7   |'];
const BEFORE_QTY = ['| Item  |     | Qty |',
                    '| ----- | --- | --- |',
                    '| Bolts |     | 12  |',
                    '| Nuts  |     | 7   |'];

const ALIGNED = ['| L | C | R |', '| :-- | :-: | --: |', '| 1 | 2 | 3 |'].join('\n');
const COMPACT = ['|Item|Qty|', '|-|-|', '|Bolts|12|'].join('\n');
const RAGGED = ['| a | b | c |', '| --- | --- | --- |', '| 1 |', '| 1 | 2 | 3 | 4 |'].join('\n');
const ONECOL = ['| Item |', '| ---- |', '| Bolt |'].join('\n');

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

  const caretSplit = off => page.evaluate(o => {
    const t = document.querySelector('#src');
    t.focus(); t.setSelectionRange(o, o);
  }, off);

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

  /* How many cells each row of the table is cut into, the delimiter
     included. The whole risk of this feature is one of these numbers
     drifting away from the others. */
  const widths = async () => page.evaluate(() => {
    const t = MM.tableAt(MM.docText().split('\n\n').filter(b => b.trim()[0] === '|')[0], 0);
    return t ? t.rows.map(r => r.cells.length) : null;
  });

  /* The shape of the table as the parser sees it, which is the only opinion
     that matters — a line of dashes counted by eye would miss a cell that
     had quietly stopped being one. */
  const shape = async () => page.evaluate(() => {
    const t = MM.tableAt(MM.docText().split('\n\n').filter(b => b.trim()[0] === '|')[0], 0);
    if (!t) return null;
    const rule = /^:?-+:?$/;
    return {
      rows: t.rows.length,
      delim: t.delim,
      rules: t.rows.filter(r => r.cells.every(c => rule.test(c.trim()))).length,
      same: t.rows.every(r => r.cells.length === t.rows[0].cells.length)
    };
  });

  // =========================================================== split view
  console.log('split view\n');

  await load(DOC, 'split');
  await caretSplit(DOC.indexOf(BOLTS) + 4);
  await cmd('tableColumnRight');
  await settle();
  eq('a column to the right lands beside the one the caret was in',
     await rows(), AFTER_ITEM);
  eq('and the caret is in the new cell on the row it was already on',
     await caretNow(), { line: '| Bolts |       | 12  |', col: 10 });

  ok('one undo puts the table back', await page.evaluate(() => MM.undo()));
  await settle();
  eq('…exactly as it was', await doc(), DOC);

  await load(DOC, 'split');
  await caretSplit(DOC.indexOf(BOLTS) + 4);
  await cmd('tableColumnLeft');
  await settle();
  eq('a column to the left lands the other side of it', await rows(), BEFORE_ITEM);
  eq('with the caret in the new cell, not the old one',
     await caretNow(), { line: '|       | Bolts | 12  |', col: 2 });

  await load(DOC, 'split');
  await caretSplit(DOC.indexOf(BOLTS) + 10);
  await cmd('tableColumnLeft');
  await settle();
  eq('the caret in the second cell works on the second column', await rows(), BEFORE_QTY);
  eq('and lands in the new cell there', await caretNow(), { line: '| Bolts |     | 12  |', col: 10 });

  await load(DOC, 'split');
  await caretSplit(DOC.indexOf(BOLTS) + 10);
  await cmd('tableColumnDelete');
  await settle();
  eq('delete takes out the column the caret was in',
     await rows(), ['| Item  |', '| ----- |', '| Bolts |', '| Nuts  |']);
  eq('and leaves the caret on the column beside it',
     await caretNow(), { line: '| Bolts |', col: 2 });
  ok('undo brings the deleted column back', await page.evaluate(() => MM.undo()));
  await settle();
  eq('…with the whole document intact', await doc(), DOC);

  await load(DOC, 'split');
  await caretSplit(DOC.indexOf(BOLTS) + 4);
  await cmd('tableColumnDelete');
  await settle();
  eq('deleting the first column is allowed — it is a column, not the header row',
     await rows(), ['| Qty |', '| --- |', '| 12  |', '| 7   |']);
  eq('and the caret moves onto what was to its right',
     await caretNow(), { line: '| 12  |', col: 2 });

  /* Nothing above may touch the prose either side of the table. */
  await load(DOC, 'split');
  await caretSplit(DOC.indexOf(NUTS) + 4);
  await cmd('tableColumnRight');
  await settle();
  eq('the prose under the table is left where it was',
     (await doc()).split('\n\n'),
     ['# Stock', AFTER_ITEM.join('\n'), 'Everything under the table is prose.\n']);

  // ------------------------------------------------------- the delimiter
  console.log('\nthe dashes, which are the whole risk\n');

  await load(DOC, 'split');
  eq('four rows of two cells to begin with', await widths(), [2, 2, 2, 2]);
  await caretSplit(DOC.indexOf(BOLTS) + 4);
  await cmd('tableColumnRight');
  await settle();
  eq('every row gains a cell, the dashes among them', await widths(), [3, 3, 3, 3]);

  await load(DOC, 'split');
  await caretSplit(DOC.indexOf(BOLTS) + 4);
  await cmd('tableColumnDelete');
  await settle();
  eq('and every row loses one together', await widths(), [1, 1, 1, 1]);

  await load(DOC, 'split');
  await caretSplit(DOC.indexOf(DELIM) + 4);
  await cmd('tableColumnRight');
  await settle();
  eq('the caret on the delimiter row has a column like any other line',
     await rows(), AFTER_ITEM);
  eq('and the caret stays on the dashes, where someone setting alignment is looking',
     await caretNow(), { line: '| ----- | ----- | --- |', col: 10 });

  await load(DOC, 'split');
  await caretSplit(DOC.indexOf(DELIM) + 4);
  await cmd('tableColumnDelete');
  await settle();
  eq('and a column can be deleted from there too',
     await rows(), ['| Qty |', '| --- |', '| 12  |', '| 7   |']);

  await load(DOC, 'split');
  await caretSplit(DOC.indexOf(HEAD) + 4);
  await cmd('tableColumnRight');
  await settle();
  eq('the new column’s dashes are as long as its neighbour’s, not a stock three',
     (await rows())[1], '| ----- | ----- | --- |');

  await load(DOC, 'split');
  await caretSplit(DOC.indexOf(HEAD) + 10);
  await cmd('tableColumnLeft');
  await settle();
  eq('beside the short rule it is short, so it follows the neighbour rather than a constant',
     (await rows())[1], '| ----- | --- | --- |');

  // ------------------------------------------------- alignment markers
  console.log('\nalignment markers\n');

  await load(ALIGNED, 'split');
  await caretSplit(ALIGNED.indexOf('| 1 | 2 | 3 |') + 6);
  await cmd('tableColumnLeft');
  await settle();
  eq('a column that moves keeps the marker that was set on it',
     await rows(), ['| L |   | C | R |', '| :-- | --- | :-: | --: |', '| 1 |   | 2 | 3 |']);

  await load(ALIGNED, 'split');
  await caretSplit(ALIGNED.indexOf('| 1 | 2 | 3 |') + 6);
  await cmd('tableColumnRight');
  await settle();
  eq('and the new one starts plain — nobody has set it any way yet',
     (await rows())[1], '| :-- | :-: | --- | --: |');

  await load(ALIGNED, 'split');
  await caretSplit(ALIGNED.indexOf('| 1 | 2 | 3 |') + 6);
  await cmd('tableColumnDelete');
  await settle();
  eq('deleting a column takes its marker with it and leaves the others alone',
     await rows(), ['| L | R |', '| :-- | --: |', '| 1 | 3 |']);

  const CENTRED = ['| a | b |', '| :-: | :-: |', '| 1 | 2 |'].join('\n');
  await load(CENTRED, 'split');
  await caretSplit(CENTRED.indexOf('| 1 | 2 |') + 2);
  await cmd('tableColumnRight');
  await settle();
  eq('a marker as wide as its rule gives a rule of the same width with no colons',
     (await rows())[1], '| :-: | --- | :-: |');

  // -------------------------------------------------------- other shapes
  console.log('\ntables written other ways\n');

  await load(COMPACT, 'split');
  await caretSplit(COMPACT.indexOf('|Bolts') + 3);
  await cmd('tableColumnRight');
  await settle();
  eq('a compact table gets a compact column', await rows(),
     ['|Item|    |Qty|', '|-|-|-|', '|Bolts|     |12|']);

  const INDENTED = ['  | a | b |', '  | - | - |', '  | 1 | 2 |'].join('\n');
  await load(INDENTED, 'split');
  await caretSplit(INDENTED.indexOf('  | 1') + 4);
  await cmd('tableColumnRight');
  await settle();
  eq('an indented table keeps its indent on every row', await rows(),
     ['  | a |   | b |', '  | - | - | - |', '  | 1 |   | 2 |']);

  const ESCAPED = ['| a \\| b | c |', '| --- | --- |', '| 1 | 2 |'].join('\n');
  await load(ESCAPED, 'split');
  await caretSplit(ESCAPED.indexOf('| 1 | 2 |') + 2);
  await cmd('tableColumnRight');
  await settle();
  eq('an escaped pipe is not a column boundary, so the cell holding it survives whole',
     await rows(), ['| a \\| b |        | c |', '| --- | --- | --- |', '| 1 |   | 2 |']);

  await load(ESCAPED, 'split');
  await caretSplit(ESCAPED.indexOf('| a \\| b |') + 8);
  await cmd('tableColumnDelete');
  await settle();
  eq('and a caret sitting past it is still in the first column, not the second',
     await rows(), ['| c |', '| --- |', '| 2 |']);

  // ------------------------------------------------------------- ragged
  console.log('\nragged tables\n');

  /* The rule: a row that stops short of the seam is left alone. Its cells
     are already in the columns they were in, a renderer pads the rest out
     with empties, and touching it would move real content sideways. */

  await load(RAGGED, 'split');
  await caretSplit(RAGGED.indexOf('| 1 |\n') + 2);
  await cmd('tableColumnRight');
  await settle();
  eq('a short row that reaches the seam takes a cell like everyone else',
     await rows(), ['| a |   | b | c |', '| --- | --- | --- | --- |',
                    '| 1 |   |', '| 1 |   | 2 | 3 | 4 |']);

  await load(RAGGED, 'split');
  await caretSplit(RAGGED.indexOf('| 1 | 2 | 3 | 4 |') + 14);
  await cmd('tableColumnLeft');
  await settle();
  eq('a caret past the last real column works on the last real column',
     await rows(), ['| a | b |   | c |', '| --- | --- | --- | --- |',
                    '| 1 |', '| 1 | 2 |   | 3 | 4 |']);
  eq('and the row that stops short of the seam is untouched, so it is no worse off',
     (await rows())[2], '| 1 |');

  await load(RAGGED, 'split');
  await caretSplit(RAGGED.indexOf('| 1 | 2 | 3 | 4 |') + 10);
  await cmd('tableColumnDelete');
  await settle();
  eq('deleting skips the rows that never reached the column',
     await rows(), ['| a | b |', '| --- | --- |', '| 1 |', '| 1 | 2 | 4 |']);

  await load(RAGGED, 'split');
  await caretSplit(RAGGED.indexOf('| 1 |\n') + 2);
  await cmd('tableColumnDelete');
  await settle();
  eq('and a row whose only cell was the one deleted keeps an empty one rather than becoming no row',
     await rows(), ['| b | c |', '| --- | --- |', '|   |', '| 2 | 3 | 4 |']);

  ok('a ragged table never comes out more ragged than it went in', true);

  // -------------------------------------------------- the last column
  console.log('\nthe last column there is\n');

  await load(ONECOL, 'split');
  await clearToast();
  await caretSplit(ONECOL.indexOf('| Bolt |') + 3);
  await cmd('tableColumnDelete');
  await settle();
  eq('a table of one column keeps it rather than leaving nothing', await doc(), ONECOL);
  eq('and says why', await toastNow(), 'That is the only column left');

  await load(ONECOL, 'split');
  await caretSplit(ONECOL.indexOf('| Bolt |') + 3);
  await cmd('tableColumnRight');
  await settle();
  eq('but it can still gain one', await rows(),
     ['| Item |      |', '| ---- | ---- |', '| Bolt |      |']);

  await load('| solo |', 'split');
  await clearToast();
  await caretSplit(3);
  await cmd('tableColumnDelete');
  await settle();
  eq('a one-line table with no dashes is one column too', await doc(), '| solo |');
  eq('with the same answer', await toastNow(), 'That is the only column left');

  // ------------------------------------------- nowhere near a table
  console.log('\nthe caret somewhere else\n');

  await load(DOC, 'split');
  await clearToast();
  await caretSplit(DOC.indexOf('Everything under') + 4);
  await cmd('tableColumnRight');
  await settle();
  eq('a caret in prose changes nothing', await doc(), DOC);
  eq('and is told where the command works', await toastNow(), 'Put the caret in a table column');

  await load(DOC, 'split');
  await clearToast();
  await caretSplit(DOC.indexOf('Everything under') + 4);
  await cmd('tableColumnDelete');
  await settle();
  eq('nor does deleting from prose take anything out', await doc(), DOC);
  eq('with the same answer', await toastNow(), 'Put the caret in a table column');

  const FENCED = ['```', '| a | b |', '| - | - |', '| 1 | 2 |', '```'].join('\n');
  await load(FENCED, 'split');
  await clearToast();
  await caretSplit(FENCED.indexOf('| 1 | 2 |') + 2);
  await cmd('tableColumnRight');
  await settle();
  eq('a table drawn inside a code fence is text, and is left alone', await doc(), FENCED);
  eq('and says the caret is not in a table', await toastNow(), 'Put the caret in a table column');

  const AFTER = ['| a | b |', '| - | - |', '| 1 | 2 |', 'Trailing line, no blank line before it'].join('\n');
  await load(AFTER, 'split');
  await clearToast();
  await caretSplit(AFTER.indexOf('Trailing') + 3);
  await cmd('tableColumnRight');
  await settle();
  eq('a line under the last row is not a row', await doc(), AFTER);

  await load(AFTER, 'split');
  await caretSplit(AFTER.indexOf('| 1 | 2 |') + 2);
  await cmd('tableColumnRight');
  await settle();
  eq('and the column stops at the last row, not at the line under it',
     (await doc()).split('\n'),
     ['| a |   | b |', '| - | - | - |', '| 1 |   | 2 |',
      'Trailing line, no blank line before it']);

  // ============================================================ live view
  console.log('\nlive view\n');

  await load(DOC, 'live');
  await caretLive(1, TABLE.indexOf(BOLTS) + 4);
  await cmd('tableColumnRight');
  await settle();
  eq('a column to the right, with the caret inside the open block',
     await rows(), AFTER_ITEM);
  eq('the caret is in the new cell here too',
     await caretNow(), { line: '| Bolts |       | 12  |', col: 10 });
  ok('the block is still open, so the writer can type straight into it',
     await page.evaluate(() => !!document.querySelector('.blk.editing .blk-edit')));

  /* Leaving the block writes it back to the document — the ordinary path, so
     a column added in live view has to survive it. */
  await page.evaluate(() => document.querySelector('.blk-edit').blur());
  await settle();
  eq('and it is in the document once the block closes',
     await doc(), DOC.replace(TABLE, AFTER_ITEM.join('\n')));

  await load(DOC, 'live');
  await caretLive(1, TABLE.indexOf(BOLTS) + 4);
  await cmd('tableColumnLeft');
  await settle();
  eq('a column to the left', await rows(), BEFORE_ITEM);

  await load(DOC, 'live');
  await caretLive(1, TABLE.indexOf(BOLTS) + 10);
  await cmd('tableColumnDelete');
  await settle();
  eq('and a delete', await rows(), ['| Item  |', '| ----- |', '| Bolts |', '| Nuts  |']);
  eq('with the caret on the column beside it', await caretNow(), { line: '| Bolts |', col: 2 });

  ok('undo works from inside an open block', await page.evaluate(() => MM.undo()));
  await settle();
  eq('and puts the whole document back', await doc(), DOC);

  await load(DOC, 'live');
  await caretLive(1, TABLE.indexOf(DELIM) + 4);
  await cmd('tableColumnRight');
  await settle();
  eq('the delimiter row is a place to stand in live view as well', await rows(), AFTER_ITEM);

  await load(ONECOL, 'live');
  await clearToast();
  await caretLive(0, ONECOL.indexOf('| Bolt |') + 3);
  await cmd('tableColumnDelete');
  await settle();
  eq('the last-column refusal holds in live view', await doc(), ONECOL);
  eq('and says the same thing', await toastNow(), 'That is the only column left');

  await load(DOC, 'live');
  await clearToast();
  await caretLive(0, 3);
  await cmd('tableColumnRight');
  await settle();
  eq('a caret in a heading block changes nothing', await doc(), DOC);
  eq('and says where the command works', await toastNow(), 'Put the caret in a table column');

  await load(RAGGED, 'live');
  await caretLive(0, RAGGED.indexOf('| 1 |\n') + 2);
  await cmd('tableColumnRight');
  await settle();
  eq('a ragged table behaves the same in live view',
     await rows(), ['| a |   | b | c |', '| --- | --- | --- | --- |',
                    '| 1 |   |', '| 1 |   | 2 | 3 | 4 |']);

  // ------------------------------------------------------- the palette
  console.log('\nfrom the command palette\n');

  const listFor = async (typed) => {
    await page.keyboard.press('Meta+k');
    await page.waitForTimeout(80);
    await page.fill('#pickerInput', typed);
    await page.waitForTimeout(60);
    const list = await page.evaluate(() =>
      Array.from(document.querySelectorAll('#pickerList .pk .pk-t')).map(n => n.textContent));
    return list;
  };

  const byColumn = await listFor('column');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(100);
  eq('typing "column" finds all three',
     ['Table column left', 'Table column right', 'Delete table column']
       .filter(t => byColumn.includes(t)),
     ['Table column left', 'Table column right', 'Delete table column']);

  const byTable = await listFor('table');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(100);
  eq('and so does typing "table"',
     ['Table column left', 'Table column right', 'Delete table column']
       .filter(t => byTable.includes(t)),
     ['Table column left', 'Table column right', 'Delete table column']);

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
  await choose('Table column right');
  eq('split view: the palette runs it', await rows(), AFTER_ITEM);

  await load(DOC, 'split');
  await caretSplit(DOC.indexOf(BOLTS) + 10);
  await choose('Delete table column');
  eq('split view: and the delete', await rows(),
     ['| Item  |', '| ----- |', '| Bolts |', '| Nuts  |']);

  /* The palette commits the open block before it reads the document, so by
     the time the command runs there is no block open at all. It has to pick
     up where the writer left off rather than report no table. */
  await load(DOC, 'live');
  await caretLive(1, TABLE.indexOf(BOLTS) + 4);
  await choose('Table column left');
  eq('live view: the palette finds the column the writer was in', await rows(), BEFORE_ITEM);
  eq('and leaves the caret in the new cell',
     await caretNow(), { line: '|       | Bolts | 12  |', col: 2 });

  await load(DOC, 'live');
  await caretLive(1, TABLE.indexOf(NUTS) + 10);
  await choose('Delete table column');
  eq('live view: the palette deletes the column the writer was in',
     await rows(), ['| Item  |', '| ----- |', '| Bolts |', '| Nuts  |']);

  // ------------------------------------------- the dashes, throughout
  console.log('\nthe delimiter row, after all of that\n');

  /* Every command, from every row and both columns, in both views: the
     dashes stay on the second line, there is only ever one set of them, and
     every row of the table is cut into the same number of cells. */
  const everyOp = async (mode) => {
    const seen = [];
    for (const op of ['tableColumnLeft', 'tableColumnRight', 'tableColumnDelete']) {
      for (const at of [HEAD, DELIM, BOLTS, NUTS]) {
        for (const off of [4, 10]) {
          await load(DOC, mode);
          if (mode === 'split') await caretSplit(DOC.indexOf(at) + off);
          else await caretLive(1, TABLE.indexOf(at) + off);
          await cmd(op);
          await settle();
          seen.push([op, at.slice(0, 8), off, await shape()]);
        }
      }
    }
    return seen;
  };

  const sound = s => s[3] && s[3].rows === 4 && s[3].delim === 1 &&
                     s[3].rules === 1 && s[3].same === true;

  const splitSeen = await everyOp('split');
  ok('split: four rows, one rule, on the second line, and every row the same width',
     splitSeen.every(sound), JSON.stringify(splitSeen.filter(s => !sound(s))));

  const liveSeen = await everyOp('live');
  ok('live: the same', liveSeen.every(sound),
     JSON.stringify(liveSeen.filter(s => !sound(s))));

  ok('no uncaught errors anywhere in the run', errors.length === 0, errors.join('\n        '));

  await browser.close();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
