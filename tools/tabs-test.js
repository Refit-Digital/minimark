#!/usr/bin/env node
/* ============================================================
   minimark — tab strip tests

   Runs the real web layer in a headless browser with a stand-in for the
   native shell: a bridge that records every message and answers the ones a
   real shell would. Everything below drives the page the way a person or the
   shell would and then reads the DOM back, so nothing here can pass by
   agreeing with itself.

   Usage:  node tools/tabs-test.js [resourcesDir]
   ============================================================ */

const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

/* The web layer lives inside the app bundle in the repo, and beside this
   folder in a scratch copy. Take whichever is actually there rather than
   making every caller pass a path. */
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
     `got ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`);

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1080, height: 720 } });

  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

  /* The shell, as far as the page is concerned: a message handler that
     records. Installed before any script runs. */
  await page.addInitScript(() => {
    window.__sent = [];
    window.webkit = {
      messageHandlers: { mm: { postMessage: m => { window.__sent.push(m); } } }
    };
  });

  await page.goto(pageURL);
  await page.waitForFunction(() => window.App && window.__sent.some(m => m.type === 'ready'));

  const sent = () => page.evaluate(() => window.__sent);
  const drain = () => page.evaluate(() => { const s = window.__sent; window.__sent = []; return s; });
  const strip = () => page.evaluate(() => ({
    open: document.body.classList.contains('tabs-open'),
    names: Array.from(document.querySelectorAll('#tabs .tab .name')).map(n => n.textContent),
    active: (document.querySelector('#tabs .tab.on .name') || {}).textContent || null,
    dirty: Array.from(document.querySelectorAll('#tabs .tab')).map(t => t.classList.contains('dirty')),
    barX: getComputedStyle(document.documentElement).getPropertyValue('--bar-x').trim()
  }));

  console.log('tab strip\n');

  // ---------------------------------------------------------------- boot
  {
    const s = await strip();
    ok('boot: one placeholder tab, strip closed', s.names.length === 1 && !s.open,
       JSON.stringify(s));
  }

  // ------------------------------------------------- session restore
  await drain();
  await page.evaluate(() => {
    App.loadDoc('# One\n\nfirst doc', 'one.md', '/docs', 1);
    App.loadDoc('# Two\n\nsecond doc', 'two.md', '/docs', 2);
    App.loadDoc('# Three\n\nthird doc', 'three.md', '/docs', 3);
    App.setTabs([
      { id: 1, name: 'one.md', dir: '/docs', dirty: false, active: false },
      { id: 2, name: 'two.md', dir: '/docs', dirty: false, active: true },
      { id: 3, name: 'three.md', dir: '/docs', dirty: false, active: false }
    ]);
  });
  await page.waitForTimeout(120);
  {
    const s = await strip();
    eq('restore: three tabs in order', s.names, ['one.md', 'two.md', 'three.md']);
    eq('restore: the stored active tab is in front', s.active, 'two.md');
    eq('restore: its text is on screen', await page.evaluate(() => App.getText()), '# Two\n\nsecond doc');
    eq('restore: the status bar name follows', await page.textContent('#docName'), 'two.md');
  }

  // --------------------------------- text of a background tab is reachable
  eq('getText(id): a background tab answers with its own text',
     await page.evaluate(() => App.getText(3)), '# Three\n\nthird doc');
  eq('getText(id): an unknown tab answers null, not empty',
     await page.evaluate(() => App.getText(99)), null);

  // ---------------------------------------------- editing marks one tab
  await drain();
  await page.evaluate(() => {
    const ta = document.querySelector('#src');
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);
  });
  await page.keyboard.type(' EDITED');
  await page.waitForTimeout(120);
  {
    const msgs = await sent();
    const d = msgs.filter(m => m.type === 'dirty');
    ok('editing: a dirty message carries the tab id',
       d.length === 1 && d[0].dirty === true && d[0].id === 2, JSON.stringify(d));
    const s = await strip();
    eq('editing: only that tab shows the dot', s.dirty, [false, true, false]);
  }

  // --------------------------------------------- switching keeps the work
  await drain();
  await page.evaluate(() => { document.querySelectorAll('#tabs .tab')[2].click(); });
  await page.waitForTimeout(160);
  {
    const msgs = await sent();
    ok('switch: the shell is told which tab was chosen',
       msgs.some(m => m.type === 'tabSelect' && m.id === 3), JSON.stringify(msgs));
    eq('switch: the new tab\'s text is on screen',
       await page.evaluate(() => App.getText()), '# Three\n\nthird doc');
    eq('switch: the edited tab keeps its edit while parked',
       await page.evaluate(() => App.getText(2)), '# Two\n\nsecond doc EDITED');
    const s = await strip();
    eq('switch: the dot stays on the tab it belongs to', s.dirty, [false, true, false]);
    eq('switch: the strip marks the new tab active', s.active, 'three.md');
  }

  // -------------------------------------------- undo is per tab, not global
  await page.evaluate(() => { document.querySelectorAll('#tabs .tab')[1].click(); });
  await page.waitForTimeout(160);
  eq('back again: the edit is still on screen',
     await page.evaluate(() => App.getText()), '# Two\n\nsecond doc EDITED');
  await page.evaluate(() => App.command('undo'));
  await page.waitForTimeout(80);
  eq('back again: undo walks back into the edit made before the switch',
     await page.evaluate(() => App.getText()), '# Two\n\nsecond doc');

  // ------------------------------------------------- scroll survives a swap
  await page.evaluate(() => {
    App.loadDoc(Array.from({ length: 400 }, (_, i) => 'line ' + i).join('\n\n'), 'long.md', '/docs', 4);
    App.setTabs([
      { id: 1, name: 'one.md', dir: '/docs', dirty: false, active: false },
      { id: 2, name: 'two.md', dir: '/docs', dirty: true, active: false },
      { id: 3, name: 'three.md', dir: '/docs', dirty: false, active: false },
      { id: 4, name: 'long.md', dir: '/docs', dirty: false, active: true }
    ]);
  });
  await page.waitForTimeout(300);
  await page.evaluate(() => { document.querySelector('#srcScroll').scrollTop = 900; });
  await page.waitForTimeout(120);
  await page.evaluate(() => { document.querySelectorAll('#tabs .tab')[0].click(); });
  await page.waitForTimeout(200);
  await page.evaluate(() => { document.querySelectorAll('#tabs .tab')[3].click(); });
  await page.waitForTimeout(300);
  {
    const y = await page.evaluate(() => document.querySelector('#srcScroll').scrollTop);
    ok('scroll: a long document comes back where it was left', Math.abs(y - 900) < 40, 'scrollTop=' + y);
  }

  // ------------------------------------------------------------- the peek
  await drain();
  await page.evaluate(() => App.setPeek(true));
  await page.waitForTimeout(220);
  {
    const s = await strip();
    ok('peek: the strip comes down when the shell reports the top edge', s.open);
    eq('peek: the chrome bar comes to the corner with it', s.barX, '0px');
    const msgs = await sent();
    ok('peek: the shell is told the strip is out',
       msgs.some(m => m.type === 'tabsOpen' && m.on === true));
    const dragMsg = msgs.filter(m => m.type === 'tabDrag').pop();
    ok('peek: the empty run past the last tab is measured for the drag region',
       !!dragMsg && dragMsg.w > 0 && dragMsg.h > 0, JSON.stringify(dragMsg));
    const barMsg = msgs.filter(m => m.type === 'barX').pop();
    ok('peek: the bar keeps its full width, grip and all',
       !!barMsg && barMsg.w === 103, JSON.stringify(barMsg));

    /* The complaint this is here for: a tab that starts inside the bar puts a
       window-drag region across the top of it, and a click near the top of the
       tab picks the window up instead of selecting the document. */
    const geom = await page.evaluate(() => {
      /* The bar's settled position, not its animated one. It springs across on
         a 420ms transition and getBoundingClientRect reports wherever it has
         got to, which is a moving target rather than the geometry under test. */
      const barNode = document.querySelector('#titlebar');
      const barX = parseFloat(getComputedStyle(document.documentElement)
                                .getPropertyValue('--bar-x')) || 0;
      const bar = { right: barX + barNode.offsetWidth };
      const tab = document.querySelector('#tabs .tab').getBoundingClientRect();
      const add = document.querySelector('#tabAdd').getBoundingClientRect();
      const rest = document.querySelector('#tabRest').getBoundingClientRect();
      const grip = getComputedStyle(document.querySelector('.tb-grip'), '::after').opacity;
      return { barRight: bar.right, tabLeft: tab.left, addRight: add.right,
               restLeft: rest.left, gripOpacity: parseFloat(grip) };
    });
    ok('peek: the first tab starts clear of the bar, not inside it',
       geom.tabLeft >= geom.barRight, JSON.stringify(geom));
    ok('peek: the bar keeps its grip, so it still reads as the handle',
       geom.gripOpacity > 0, JSON.stringify(geom));
    ok('peek: the drag region past the tabs starts clear of the new-tab button',
       geom.restLeft >= geom.addRight, JSON.stringify(geom));
  }

  await drain();
  await page.evaluate(() => App.setPeek(false));
  await page.waitForTimeout(400);
  {
    const s = await strip();
    ok('peek: it goes again when the pointer leaves', !s.open);
    const msgs = await sent();
    ok('peek: the shell is told, and the drag region is withdrawn',
       msgs.some(m => m.type === 'tabsOpen' && m.on === false) &&
       msgs.some(m => m.type === 'tabDrag' && m.w === 0), JSON.stringify(msgs));
  }

  // ---------------------------------------------------- split view geometry
  await page.evaluate(() => MM.setMode('split'));
  await page.waitForTimeout(120);
  {
    const closed = await page.evaluate(() =>
      parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--bar-x')));
    await page.evaluate(() => App.setPeek(true));
    await page.waitForTimeout(220);
    const open = await page.evaluate(() =>
      parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--bar-x')));
    ok('split: the bar sits on the divider until the strip arrives',
       closed > 300 && open === 0, `closed=${closed} open=${open}`);
    await page.evaluate(() => App.setPeek(false));
    await page.waitForTimeout(400);
    const back = await page.evaluate(() =>
      parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--bar-x')));
    ok('split: and springs back to it afterwards', Math.abs(back - closed) < 2, `back=${back}`);
  }

  // ------------------------------------------------------------- pinning
  await drain();
  await page.evaluate(() => App.command('toggleTabs'));
  await page.waitForTimeout(120);
  {
    ok('pin: the strip stays out with no pointer anywhere near it', (await strip()).open);
    const msgs = await sent();
    ok('pin: and the choice is persisted',
       msgs.some(m => m.type === 'pref' && m.key === 'tabsPin' && m.value === '1'),
       JSON.stringify(msgs.filter(m => m.type === 'pref')));
  }
  await page.evaluate(() => App.command('toggleTabs'));
  await page.waitForTimeout(400);
  ok('pin: unpinning lets it hide again', !(await strip()).open);

  // ------------------------------------------------------- keyboard steps
  await drain();
  eq('keyboard: starting from the last tab', (await strip()).active, 'long.md');
  await page.evaluate(() => App.command('nextTab'));
  await page.waitForTimeout(200);
  {
    const s = await strip();
    eq('next tab: wraps round the end to the first', s.active, 'one.md');
    ok('next tab: flashes the strip so you can see where you landed', s.open);
    const msgs = await sent();
    ok('next tab: the shell is told', msgs.some(m => m.type === 'tabSelect' && m.id === 1),
       JSON.stringify(msgs.map(m => m.type)));
  }
  await page.evaluate(() => App.command('prevTab'));
  await page.waitForTimeout(200);
  eq('previous tab: and back', (await strip()).active, 'long.md');
  await page.evaluate(() => App.command('prevTab'));
  await page.waitForTimeout(200);
  eq('previous tab: to its neighbour', (await strip()).active, 'three.md');

  // ------------------------------------------------------------ closing
  await drain();
  await page.evaluate(() => { document.querySelector('#tabs .tab[data-id="3"] .x').click(); });
  await page.waitForTimeout(80);
  {
    const msgs = await sent();
    ok('close: the click asks rather than acts',
       msgs.some(m => m.type === 'tabClose' && m.id === 3), JSON.stringify(msgs));
    eq('close: nothing has gone until the shell says so',
       (await strip()).names, ['one.md', 'two.md', 'three.md', 'long.md']);
  }
  await page.evaluate(() => {
    App.setTabs([
      { id: 1, name: 'one.md', dir: '/docs', dirty: false, active: false },
      { id: 2, name: 'two.md', dir: '/docs', dirty: true, active: false },
      { id: 4, name: 'long.md', dir: '/docs', dirty: false, active: true }
    ]);
  });
  await page.waitForTimeout(200);
  eq('close: the shell\'s list is what the strip shows',
     (await strip()).names, ['one.md', 'two.md', 'long.md']);
  eq('close: the closed tab\'s session is let go',
     await page.evaluate(() => App.getText(3)), null);

  // -------------------------------------------- closing the tab in front
  await page.evaluate(() => {
    App.setTabs([
      { id: 1, name: 'one.md', dir: '/docs', dirty: false, active: true },
      { id: 2, name: 'two.md', dir: '/docs', dirty: true, active: false }
    ]);
  });
  await page.waitForTimeout(220);
  {
    const s = await strip();
    eq('close: the neighbour takes over', s.active, 'one.md');
    eq('close: showing the right text', await page.evaluate(() => App.getText()), '# One\n\nfirst doc');
  }

  // ------------------------------------------------------------ new tab
  await drain();
  await page.evaluate(() => document.querySelector('#tabAdd').click());
  await page.waitForTimeout(60);
  ok('new tab: the button asks the shell',
     (await sent()).some(m => m.type === 'tabNew'));
  await page.evaluate(() => {
    // The shell sends no text for a new tab: a tab setTabs names and the
    // page has no session for is a blank document, which is the whole of it.
    App.setTabs([
      { id: 1, name: 'one.md', dir: '/docs', dirty: false, active: false },
      { id: 7, name: 'Untitled 2.md', dir: '', dirty: false, active: true },
      { id: 2, name: 'two.md', dir: '/docs', dirty: true, active: false }
    ]);
  });
  await page.waitForTimeout(220);
  {
    const s = await strip();
    eq('new tab: it lands where the shell put it', s.names, ['one.md', 'Untitled 2.md', 'two.md']);
    eq('new tab: and is in front', s.active, 'Untitled 2.md');
    eq('new tab: empty', await page.evaluate(() => App.getText()), '');
  }

  // -------------------------------------------------------------- saving
  await page.evaluate(() => App.setSaved('notes.md', '/docs', 2));
  await page.waitForTimeout(120);
  {
    const s = await strip();
    eq('save: a background tab is renamed in the strip',
       s.names, ['one.md', 'Untitled 2.md', 'notes.md']);
    eq('save: and loses its dot', s.dirty, [false, false, false]);
    eq('save: without disturbing what is on screen', s.active, 'Untitled 2.md');
  }

  // ---------------------------------------- an outside change to a parked tab
  await page.evaluate(() => App.externalChange('# Rewritten from outside', 2));
  await page.waitForTimeout(80);
  eq('external change: a background tab takes the new text',
     await page.evaluate(() => App.getText(2)), '# Rewritten from outside');
  eq('external change: and the tab on screen is untouched',
     await page.evaluate(() => App.getText()), '');

  // ------------------------------------------------------------ reorder
  await page.evaluate(() => App.setPeek(true));
  await page.waitForTimeout(220);
  await drain();
  {
    const box = await page.evaluate(() => {
      const t = document.querySelectorAll('#tabs .tab');
      const a = t[0].getBoundingClientRect(), c = t[2].getBoundingClientRect();
      return { fromX: a.left + a.width / 2, toX: c.left + c.width / 2, y: a.top + a.height / 2 };
    });
    await page.mouse.move(box.fromX, box.y);
    await page.mouse.down();
    await page.mouse.move(box.fromX + 30, box.y, { steps: 5 });
    await page.mouse.move(box.toX, box.y, { steps: 10 });
    await page.mouse.up();
    await page.waitForTimeout(150);
    const s = await strip();
    eq('reorder: the tab lands where it was dropped',
       s.names, ['Untitled 2.md', 'notes.md', 'one.md']);
    const msgs = await sent();
    const move = msgs.filter(m => m.type === 'tabMove').pop();
    ok('reorder: the shell is told the new index',
       !!move && move.id === 1 && move.to === 2, JSON.stringify(move));
  }

  // ------------------------------------------------- a click is not a drag
  await drain();
  {
    const box = await page.evaluate(() => {
      const r = document.querySelectorAll('#tabs .tab')[1].getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    });
    await page.mouse.move(box.x, box.y);
    await page.mouse.down();
    await page.mouse.move(box.x + 2, box.y);
    await page.mouse.up();
    await page.waitForTimeout(150);
    const msgs = await sent();
    ok('click: a two-pixel wobble selects rather than reorders',
       msgs.some(m => m.type === 'tabSelect') && !msgs.some(m => m.type === 'tabMove'),
       JSON.stringify(msgs.map(m => m.type)));
  }

  // --------------------------------------------------- and away again
  // The pointer is still sitting in the strip after all that dragging, and
  // the page's own backstop is quite right to hold it open for as long as it
  // is. Move away before asking.
  await page.mouse.move(540, 400);
  await page.evaluate(() => App.setPeek(false));
  await page.waitForTimeout(450);
  ok('strip: closes again once the pointer has left', !(await strip()).open);

  ok('no uncaught errors anywhere in the run', errors.length === 0, errors.join('\n        '));

  /* ------------------------------------------------------------------
     Launch, on a page of its own.

     Two shapes the shell can arrive in, and the welcome document is the
     thing at risk in both. When there is nothing to restore the shell sends
     a tab list and no text, and the page has to keep what it is already
     showing rather than blank itself to adopt an id.
     ------------------------------------------------------------------ */
  console.log('\nlaunch\n');
  {
    const fresh = await browser.newPage({ viewport: { width: 1080, height: 720 } });
    const freshErrors = [];
    fresh.on('pageerror', e => freshErrors.push(String(e)));
    await fresh.addInitScript(() => {
      window.__sent = [];
      window.webkit = { messageHandlers: { mm: { postMessage: m => window.__sent.push(m) } } };
    });
    await fresh.goto(pageURL);
    await fresh.waitForFunction(() => window.App && window.__sent.some(m => m.type === 'ready'));

    const welcome = await fresh.evaluate(() => App.getText());
    ok('launch: the page comes up with its welcome document', welcome.indexOf('# minimark') === 0);

    // Nothing to restore: one tab, no text with it.
    await fresh.evaluate(() => {
      App.setTabs([{ id: 1, name: 'Untitled.md', dir: '', dirty: false, active: true }]);
    });
    await fresh.waitForTimeout(250);
    eq('launch: an empty session adopts the welcome document rather than wiping it',
       await fresh.evaluate(() => App.getText()), welcome);
    eq('launch: under the shell\'s id, so the next message reaches it',
       await fresh.evaluate(() => App.getText(1)), welcome);

    // And the other shape: documents handed over, then the list.
    await fresh.evaluate(() => {
      App.loadDoc('# Restored A', 'a.md', '/docs', 5);
      App.loadDoc('# Restored B', 'b.md', '/docs', 6);
      App.setTabs([
        { id: 5, name: 'a.md', dir: '/docs', dirty: false, active: false },
        { id: 6, name: 'b.md', dir: '/docs', dirty: false, active: true }
      ]);
    });
    await fresh.waitForTimeout(250);
    eq('launch: a restored session shows the document that was in front',
       await fresh.evaluate(() => App.getText()), '# Restored B');
    eq('launch: with the others waiting behind it',
       await fresh.evaluate(() => App.getText(5)), '# Restored A');
    eq('launch: and the welcome document let go with its placeholder',
       await fresh.evaluate(() => App.getText(1)), null);
    ok('launch: no uncaught errors', freshErrors.length === 0, freshErrors.join('\n        '));
    await fresh.close();
  }

  await browser.close();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
