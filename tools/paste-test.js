#!/usr/bin/env node
/* ============================================================
   minimark — paste provenance tests

   Which runs of the document arrived on the clipboard. Answered by watching
   it happen, not by guessing afterwards, and kept out of the .md: iA writes
   authorship into the file and then has to ship a warning for when another
   app disturbs it. Here it rides the history sidecar, where being lost is an
   inconvenience rather than a corruption.

   The tests that matter are the ones an implementation that re-finds the
   text by searching would fail:

     - typing above a pasted run moves it, and typing inside it is now yours;
     - pasting the same sentence twice marks the copy you pasted, both times,
       and not some earlier occurrence of it;
     - the file on disk never mentions any of it;
     - a tab switch keeps it, and loading a different document does not
       inherit the last one's.

   Usage:  node tools/paste-test.js [resourcesDir]
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

  const load = async (text, name) => {
    await page.evaluate(a => { App.loadDoc(a.t, a.n || 'note.md', '/docs'); MM.setMode('split'); },
                        { t: text, n: name });
    await page.waitForTimeout(350);
  };
  /* A paste, the way the app sees one: the handler arms, the text lands. */
  const paste = async (at, text) => {
    await page.evaluate(a => {
      const ta = document.querySelector('#src');
      ta.focus();
      ta.setSelectionRange(a.at, a.at);
      MM.armPaste();
      MM.replaceRange(ta, a.at, a.at, a.text);
    }, { at, text });
    await page.waitForTimeout(250);
  };
  const type = async (at, text) => {
    await page.evaluate(a => {
      const ta = document.querySelector('#src');
      ta.focus();
      MM.replaceRange(ta, a.at, a.at, a.text);
    }, { at, text });
    await page.waitForTimeout(250);
  };
  const ranges = () => page.evaluate(() => MM.pastedRanges().map(r => ({ at: r.at, len: r.len })));
  const marked = () => page.evaluate(() => MM.pastedRanges()
    .map(r => MM.state.text.slice(r.at, r.at + r.len)));
  const fileText = () => page.evaluate(() => App.getText());
  const blocks = () => page.evaluate(() =>
    Array.from(document.querySelectorAll('#doc .blk.pasted')).map(n => n.textContent.trim()));
  const lensOn = async () => {
    await page.evaluate(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true, bubbles: true }));
      const i = document.querySelector('#pickerInput');
      i.value = 'Lens: what was pasted';
      i.dispatchEvent(new Event('input', { bubbles: true }));
      const row = Array.from(document.querySelectorAll('#pickerList .pk'))
        .find(x => x.querySelector('.pk-t').textContent === 'Lens: what was pasted');
      if (!row) throw new Error('no paste lens command');
      row.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    });
    await page.waitForTimeout(500);
  };

  console.log('\nwhat gets recorded\n');

  await load('Mine. ');
  await paste(6, 'Theirs.');
  ok('a paste is recorded', (await ranges()).length === 1, JSON.stringify(await ranges()));
  ok('as exactly what landed', (await marked())[0] === 'Theirs.', JSON.stringify(await marked()));

  await type(0, 'New. ');
  ok('typing above it moves it', (await marked())[0] === 'Theirs.',
     JSON.stringify(await marked()) + ' ' + JSON.stringify(await ranges()));

  await type(await page.evaluate(() => MM.state.text.indexOf('Theirs.') + 3), 'XX');
  ok('typing inside it splits it, and what you typed is yours',
     (await marked()).join('|') === 'The|irs.', JSON.stringify(await marked()));

  console.log('\ntyping is not pasting\n');

  await load('Start. ');
  await type(7, 'typed by hand');
  ok('an ordinary edit records nothing', (await ranges()).length === 0,
     JSON.stringify(await ranges()));

  console.log('\nthe same text twice\n');

  await load('A repeated line.\n\nfiller\n\n');
  await paste(await page.evaluate(() => MM.state.text.length), 'A repeated line.');
  const m = await ranges();
  ok('the copy that was pasted is the one marked', m.length === 1 && m[0].at > 10,
     JSON.stringify(m));
  ok('not the one that was already there',
     await page.evaluate(() => MM.pastedRanges()[0].at !== 0));

  console.log('\nnothing reaches the file\n');

  /* Deliberately words that the annotation format would also use, so the
     assertion below cannot pass by luck. */
  await load('Before. ');
  await paste(8, 'from the clipboard');
  ok('the document is exactly what was typed and pasted',
     (await fileText()) === 'Before. from the clipboard', JSON.stringify(await fileText()));
  ok('with no annotation of any kind', !/paste|author/i.test(await fileText()),
     JSON.stringify(await fileText()));
  /* It goes to the sidecar instead. Forced rather than waited for, so the
     assertion is about where it is written and not about a timer. */
  await page.evaluate(() => { window.__sent.length = 0; MM.histSnapshot(true); MM.histFlush(); });
  await page.waitForTimeout(250);
  const store = await page.evaluate(() => {
    const w = window.__sent.filter(m => m.type === 'histWrite');
    return w.length ? w[w.length - 1].json : null;
  });
  ok('the history sidecar is what gets written', store !== null);
  ok('and the ranges are in it', /"paste"/.test(store || ''),
     (store || '').slice(0, 160));
  ok('alongside the text they describe, so the two cannot drift',
     /"head"/.test(store || ''));

  console.log('\ncarried between tabs\n');

  const carried = await page.evaluate(() => {
    const parked = MM.sessionCapture();
    MM.setText('something else entirely', { immediate: true });
    MM.sessionRestore(parked, {});
    return MM.pastedRanges().map(r => MM.state.text.slice(r.at, r.at + r.len));
  });
  ok('parking a tab and coming back keeps the marks',
     carried.join('') === 'from the clipboard', JSON.stringify(carried));

  console.log('\nthe lens\n');

  await load('First paragraph, typed.\n\nSecond one.');
  await paste(await page.evaluate(() => MM.state.text.length), '\n\nA pasted paragraph.');
  await page.evaluate(() => MM.setMode('live'));
  await page.waitForTimeout(300);
  /* The caret is in the block that was just pasted into, so live view has it
     open as a textarea and its textContent is empty until it is let go. */
  await page.evaluate(() => { const ta = document.querySelector('.blk-edit'); if (ta) ta.blur(); });
  await page.waitForTimeout(350);
  ok('nothing is marked until the lens is on', (await blocks()).length === 0,
     JSON.stringify(await blocks()));

  await lensOn();
  const b = await blocks();
  ok('the block holding pasted text is marked', b.some(x => /A pasted paragraph/.test(x)),
     JSON.stringify(b));
  ok('and the blocks that were typed are not',
     !b.some(x => /First paragraph/.test(x)), JSON.stringify(b));
  ok('the mark carries when it happened', await page.evaluate(() => {
    const n = document.querySelector('#doc .blk.pasted');
    return !!(n && n.getAttribute('data-pasted'));
  }));

  await lensOn();
  ok('turning it off clears the marks', (await blocks()).length === 0,
     JSON.stringify(await blocks()));

  console.log('\nacross documents\n');

  await lensOn();
  await load('A different document entirely.', 'other.md');
  await page.waitForTimeout(300);
  ok('a new document does not inherit the last one’s marks',
     (await ranges()).length === 0, JSON.stringify(await ranges()));
  ok('and nothing is marked on screen', (await blocks()).length === 0);

  console.log('');
  ok('no uncaught errors anywhere in the run', errors.length === 0, errors.join('\n        '));

  await browser.close();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
