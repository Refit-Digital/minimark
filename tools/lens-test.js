#!/usr/bin/env node
/* ============================================================
   minimark — lens tests

   Three lenses that colour a class of word and say nothing about it. The
   distinction from the style check is the whole feature, so most of what is
   asserted here is what a lens must NOT do: no tooltip, nothing in the
   counter, nothing in the stepper.

   The rest is the rules themselves, and the ones worth their own test are
   the ones a naive version gets wrong:

     - "family" and "reply" end in -ly and are not adverbs;
     - a long sentence with emphasis in the middle of it is still one
       sentence, not three short ones;
     - "repeated" means three times close together, not three times in a
       document, or every content word in a long piece lights up;
     - a word that is both a filler and an adverb is a note, not a lens:
       the sentence that says why is worth more than the colour that does
       not.

   Usage:  node tools/lens-test.js [resourcesDir]
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

const LONG = 'one two three four five six seven eight nine ten eleven twelve ' +
  'thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty ' +
  'twentyone twentytwo twentythree twentyfour twentyfive twentysix ' +
  'twentyseven twentyeight twentynine thirty thirtyone thirtytwo.';

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

  const load = async text => {
    await page.evaluate(t => { App.loadDoc(t, 'note.md', '/docs'); MM.setMode('live'); }, text);
    await page.waitForTimeout(350);
    await page.evaluate(() => { const ta = document.querySelector('.blk-edit'); if (ta) ta.blur(); });
    await page.waitForTimeout(450);
  };
  /* through the palette, so the command people actually use is the one tested */
  const run = async title => {
    await page.evaluate(t => {
      MM.menu ? null : null;
      const open = window.__runCommand;
      open(t);
    }, title);
    await page.waitForTimeout(400);
  };
  const marks = cls => page.evaluate(c =>
    Array.from(document.querySelectorAll('#doc .' + c)).map(n => n.textContent), cls);
  const notes = () => page.evaluate(() =>
    Array.from(document.querySelectorAll('#doc mark.smark')).map(n => n.textContent));
  const counter = () => page.evaluate(() => {
    const n = document.querySelector('#stStyle');
    return n && !n.hidden ? n.textContent : null;
  });

  /* Drive the palette by title rather than reaching into ui.js internals. */
  await page.evaluate(() => {
    window.__runCommand = title => {
      const ev = new KeyboardEvent('keydown', { key: 'k', metaKey: true, bubbles: true });
      document.dispatchEvent(ev);
      const input = document.querySelector('#pickerInput');
      input.value = title;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      const row = Array.from(document.querySelectorAll('#pickerList .pk'))
        .find(x => x.querySelector('.pk-t').textContent === title);
      if (!row) throw new Error('no command called ' + title);
      row.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    };
  });

  console.log('\nadverbs\n');

  await load('She quickly left. The family waited, and she happily replied.');
  await run('Lens: adverbs');
  let m = await marks('lmark-adverb');
  ok('an adverb is coloured', m.includes('quickly'), JSON.stringify(m));
  ok('and so is another', m.includes('happily'), JSON.stringify(m));
  ok('"family" ends in -ly and is not one', !m.includes('family'), JSON.stringify(m));
  ok('nor is "replied"', !m.includes('replied'), JSON.stringify(m));

  ok('a lens says nothing about the word', await page.evaluate(() => {
    const n = document.querySelector('#doc .lmark-adverb');
    return n && !n.title && !n.getAttribute('title');
  }));
  ok('a lens is not a mark', await page.evaluate(() =>
    document.querySelector('#doc .lmark-adverb').tagName === 'SPAN'));
  ok('and nothing counts them', (await counter()) === null, 'counter read: ' + await counter());

  await load('A different document, opened carefully.');
  m = await marks('lmark-adverb');
  ok('the lens stays on across documents', m.includes('carefully'), JSON.stringify(m));

  console.log('\nlong sentences\n');

  await run('Lens: adverbs');            /* off again */
  await load(LONG + '\n\nShort one here.');
  await run('Lens: long sentences');
  m = await marks('lmark-long');
  ok('a sentence over thirty words is tinted', m.length > 0 && /thirtytwo/.test(m.join('')),
     JSON.stringify(m).slice(0, 120));
  ok('a short one is not', !/Short one here/.test(m.join('')), JSON.stringify(m).slice(0, 200));

  await load('The **emphasis** in ' + LONG);
  m = await marks('lmark-long');
  ok('emphasis in the middle does not break the sentence in three',
     m.join('').indexOf('thirtytwo') > -1, JSON.stringify(m).slice(0, 160));

  await load('```\n' + LONG + '\n```\n');
  m = await marks('lmark-long');
  ok('a code fence has no sentences in it', m.length === 0, JSON.stringify(m).slice(0, 120));

  console.log('\nrepeated words\n');

  await run('Lens: long sentences');     /* off again */
  await load('The kestrel hunted. A kestrel is patient. That kestrel again. ' +
             'A buzzard passed over once.');
  await run('Lens: repeated words');
  m = await marks('lmark-repeat');
  ok('a word used three times close together is coloured',
     m.filter(x => /kestrel/i.test(x)).length === 3, JSON.stringify(m));
  ok('a word used once is not', !m.some(x => /buzzard/i.test(x)), JSON.stringify(m));
  ok('and the words every sentence is made of are not',
     !m.some(x => /^(the|a|is|that)$/i.test(x)), JSON.stringify(m));

  const far = 'kestrel ' + Array(220).fill('filler').join(' ').replace(/filler/g, 'x') +
              ' kestrel and later kestrel';
  await load(far);
  m = await marks('lmark-repeat');
  ok('three times spread far apart is not repetition',
     m.filter(x => /kestrel/i.test(x)).length === 0, JSON.stringify(m).slice(0, 120));

  console.log('\na note beats a lens\n');

  await run('Lens: repeated words');     /* off */
  await run('Lens: adverbs');
  await load('She really went, and she quickly left.');
  await page.evaluate(() => { document.dispatchEvent(new KeyboardEvent('keydown',
    { key: 's', ctrlKey: true, altKey: true, code: 'KeyS', bubbles: true })); });
  await page.waitForTimeout(450);

  let n = await notes();
  m = await marks('lmark-adverb');
  ok('"really" is filler, and filler is a note', n.includes('really'), JSON.stringify(n));
  ok('so the adverb lens leaves it alone', !m.includes('really'), JSON.stringify(m));
  ok('and still colours the adverb that is only an adverb', m.includes('quickly'),
     JSON.stringify(m));
  ok('the counter counts the note and not the lens', /1 note/.test(await counter() || ''),
     'counter read: ' + await counter());

  console.log('\nturning them off and on again\n');

  /* style check off, so only the lens state is in play */
  await page.evaluate(() => { document.dispatchEvent(new KeyboardEvent('keydown',
    { key: 's', ctrlKey: true, altKey: true, code: 'KeyS', bubbles: true })); });
  await page.waitForTimeout(300);

  await run('Lens: repeated words');     /* adverbs + repeats on */
  await page.waitForTimeout(200);
  ok('two lenses at once', (await marks('lmark-adverb')).length > 0);

  await page.evaluate(() => { document.dispatchEvent(new KeyboardEvent('keydown',
    { key: 'l', ctrlKey: true, altKey: true, code: 'KeyL', bubbles: true })); });
  await page.waitForTimeout(400);
  ok('⌃⌥L turns them off', (await marks('lmark-adverb')).length === 0);

  await page.evaluate(() => { document.dispatchEvent(new KeyboardEvent('keydown',
    { key: 'l', ctrlKey: true, altKey: true, code: 'KeyL', bubbles: true })); });
  await page.waitForTimeout(400);
  ok('and on again brings back the set you had, not just one of them',
     (await marks('lmark-adverb')).length > 0);

  const pref = await page.evaluate(() => {
    const p = window.__sent.filter(m => m.type === 'pref' && m.key === 'lenses');
    return p.length ? p[p.length - 1].value : null;
  });
  ok('which is what gets remembered', pref && pref.indexOf('adverb') > -1 &&
     pref.indexOf('repeat') > -1, 'pref was: ' + pref);

  await run('Lenses off');
  ok('"Lenses off" clears them all', (await marks('lmark-adverb')).length === 0);

  console.log('');
  ok('no uncaught errors anywhere in the run', errors.length === 0, errors.join('\n        '));

  await browser.close();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
