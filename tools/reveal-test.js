#!/usr/bin/env node
/* ============================================================
   minimark — theme reveal tests

   A theme change opens as a circle from the point it was asked for. What
   follows drives the real web layer in a headless browser against a
   stand-in shell and reads the DOM back, so nothing here can pass by
   agreeing with itself.

   The three cases that matter as much as the animation are the ones where
   there must not be one: reduced motion, an engine with no view
   transitions, and the shell pushing the system appearance at launch.

   Usage:  node tools/reveal-test.js [resourcesDir]
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

const W = 1080, H = 720;

let passed = 0, failed = 0;
const ok = (name, cond, detail) => {
  if (cond) { passed++; console.log(`  ok    ${name}`); }
  else { failed++; console.log(`  FAIL  ${name}${detail ? '\n        ' + detail : ''}`); }
};
const eq = (name, got, want) =>
  ok(name, JSON.stringify(got) === JSON.stringify(want),
     `got ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`);
const near = (name, got, want, slack) =>
  ok(name, Math.abs(got - want) <= slack, `got ${got}, want ${want} ±${slack}`);

const shell = () => {
  window.__sent = [];
  window.webkit = { messageHandlers: { mm: { postMessage: m => { window.__sent.push(m); } } } };
};

(async () => {
  const browser = await chromium.launch();

  /* a page with the stand-in shell in place, booted and settled */
  async function boot(opts, extraInit) {
    const page = await browser.newPage(Object.assign({ viewport: { width: W, height: H } }, opts));
    await page.addInitScript(shell);
    if (extraInit) await page.addInitScript(extraInit);
    await page.goto(pageURL);
    await page.waitForFunction(() => window.App && window.__sent.some(m => m.type === 'ready'));
    return page;
  }

  const page = await boot();
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

  const themeOf = p => p.evaluate(() => document.documentElement.dataset.theme);
  const midWipe = p => p.evaluate(() => document.documentElement.classList.contains('vt-theme'));
  /* the swap runs at the next rendering opportunity, not on the click */
  const nextPaint = p => p.evaluate(() =>
    new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));

  console.log('\nthe engine');
  ok('has startViewTransition', await page.evaluate(() => !!document.startViewTransition));

  console.log('\npicking a theme');
  await page.click('#themeBtn');
  await page.waitForSelector('#themePop.open');
  /* .open goes on when the popover starts sliding, not when it arrives, and a
     row measured or clicked mid-slide is at a different place each time — the
     source of a failure that moved around depending on what had run before it.
     Waiting on the popover's own animations settles it: after this the rows
     are where they are going to stay. */
  await page.evaluate(() => Promise.all(
    document.querySelector('#themePop')
      .getAnimations({ subtree: true })
      .map(a => a.finished.catch(() => {}))
  ));
  eq('starts on paper', await themeOf(page), 'paper');

  /* .vt-theme goes on and comes off inside a second — catch it as it lands
     rather than polling for it. The click's own coordinates get recorded at
     the same time: the popover is still sliding open when its rows are first
     measurable, so where the pointer actually landed is the only honest
     thing to compare the circle against. */
  await page.evaluate(() => {
    window.__saw = null;
    window.__click = null;
    document.addEventListener('click', e => {
      if (!window.__click) window.__click = { x: e.clientX, y: e.clientY };
    }, true);
    const root = document.documentElement;
    new MutationObserver(() => {
      if (root.classList.contains('vt-theme') && !window.__saw) {
        window.__saw = {
          x: parseFloat(root.style.getPropertyValue('--reveal-x')),
          y: parseFloat(root.style.getPropertyValue('--reveal-y')),
          r: parseFloat(root.style.getPropertyValue('--reveal-r')),
          ms: root.style.getPropertyValue('--reveal-ms')
        };
      }
    }).observe(root, { attributes: true, attributeFilter: ['class'] });
  });

  const row = await page.$('#themePop .tp-row[data-theme="void"]');
  /* Measured before the click, not after: the click changes the theme and the
     popover closes behind it, and a hidden row has no box at all — which read
     as "cannot read properties of null" and took the whole run down rather
     than failing one assertion. */
  const rowBox = await row.boundingBox();
  await row.click();

  const saw = await page.evaluate(() => window.__saw);
  const hit = await page.evaluate(() => window.__click);
  ok('.vt-theme goes on the root element', !!saw);
  if (saw && hit) {
    eq('the circle starts where the pointer was (x)', saw.x, hit.x);
    eq('the circle starts where the pointer was (y)', saw.y, hit.y);
    ok('...which is the Void row',
       hit.x >= rowBox.x && hit.x <= rowBox.x + rowBox.width &&
       hit.y >= rowBox.y && hit.y <= rowBox.y + rowBox.height,
       `click ${JSON.stringify(hit)} outside ${JSON.stringify(rowBox)}`);
    /* the far corner, not the near one, or the last of the screen snaps */
    const far = Math.ceil(Math.hypot(Math.max(hit.x, W - hit.x), Math.max(hit.y, H - hit.y)));
    eq('the radius reaches the furthest corner', saw.r, far);
    eq('the duration is handed over', saw.ms, '620ms');
  }

  console.log('\nwhile it runs');
  await nextPaint(page);
  const mid = await page.evaluate(() => {
    const anim = document.getAnimations()
      .filter(a => a.animationName === 'mm-reveal')
      .map(a => ({ pseudo: a.effect && a.effect.pseudoElement,
                   ms: a.effect && a.effect.getTiming().duration }))[0] || null;
    return {
      cls: document.documentElement.classList.contains('vt-theme'),
      theme: document.documentElement.dataset.theme,
      bodyTransition: getComputedStyle(document.body).transitionProperty,
      anim
    };
  });
  eq('still mid-wipe', mid.cls, true);
  eq('the theme has already changed underneath', mid.theme, 'void');
  eq("body's own 420ms colour fade is off", mid.bodyTransition, 'none');
  ok('mm-reveal is running', !!mid.anim);
  if (mid.anim) {
    eq('...on the new frame', mid.anim.pseudo, '::view-transition-new(root)');
    eq('...for 620ms', mid.anim.ms, 620);
  }

  console.log('\nafter it settles');
  await page.waitForTimeout(1200);
  const after = await page.evaluate(() => ({
    cls: document.documentElement.classList.contains('vt-theme'),
    theme: document.documentElement.dataset.theme,
    bodyTransition: getComputedStyle(document.body).transitionProperty,
    bg: getComputedStyle(document.body).backgroundColor,
    ticked: !!document.querySelector('#themePop .tp-row[data-theme="void"].on')
  }));
  eq('.vt-theme comes off', after.cls, false);
  eq('the theme is the one that was picked', after.theme, 'void');
  eq("body's colour fade is back", after.bodyTransition, 'background-color, color');
  eq('Void is black', after.bg, 'rgb(0, 0, 0)');
  eq('the picker ticks the new theme', after.ticked, true);

  console.log('\npicking the theme already in use');
  await page.evaluate(() => {
    window.__wipes = 0;
    const root = document.documentElement;
    new MutationObserver(() => { if (root.classList.contains('vt-theme')) window.__wipes++; })
      .observe(root, { attributes: true, attributeFilter: ['class'] });
  });
  await page.click('#themePop .tp-row[data-theme="void"]');
  await page.waitForTimeout(250);
  eq('no wipe onto an identical frame', await page.evaluate(() => window.__wipes), 0);

  console.log('\nfollow system');
  await page.click('#themePop .tp-row[data-auto="1"]');
  await page.waitForTimeout(1200);
  eq('back to the light theme', await themeOf(page), 'paper');
  eq('nothing left on the root element', await midWipe(page), false);

  console.log('\nreduced motion');
  const rm = await boot({ reducedMotion: 'reduce' });
  await rm.click('#themeBtn');
  await rm.click('#themePop .tp-row[data-theme="ink"]');
  eq('no wipe', await midWipe(rm), false);
  eq('the theme still changes', await themeOf(rm), 'ink');

  console.log('\nan engine without view transitions');
  const old = await boot({}, () => { delete Document.prototype.startViewTransition; });
  await old.click('#themeBtn');
  await old.click('#themePop .tp-row[data-theme="sepia"]');
  eq('nothing left on the root element', await midWipe(old), false);
  eq('the theme changes instantly', await themeOf(old), 'sepia');

  console.log('\nthe shell pushing the system appearance');
  const launch = await boot();
  /* handleReady sends this on a window nobody has touched yet. Nobody asked
     for it, so it must not wipe — however long the shell takes to get round
     to it. */
  await launch.waitForTimeout(1500);
  await launch.evaluate(() => App.setSystemTheme('dark'));
  eq('launching into dark does not wipe', await midWipe(launch), false);
  eq('but it is dark', await themeOf(launch), 'ink');

  /* one keystroke into the document is enough to make it somebody's window */
  await launch.click('#src');
  await launch.evaluate(() => App.setSystemTheme('light'));
  eq('the machine going light at dawn does wipe', await midWipe(launch), true);
  await launch.waitForTimeout(1200);
  eq('and lands on paper', await themeOf(launch), 'paper');

  console.log('');
  ok('the page threw nothing', errors.length === 0, errors.join('\n        '));

  await browser.close();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
