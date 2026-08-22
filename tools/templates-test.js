#!/usr/bin/env node
/* ============================================================
   minimark — user stylesheet tests

   The export template is checked by bridge-contract.js, which diffs the
   placeholders the starter file promises against the ones htmlDocument
   actually substitutes. That is the half that can rot silently.

   This is the other half: what App.setUserCSS does to the page. It is small
   but it is the only thing standing between "a stylesheet hook" and "a
   stylesheet hook that stacks a dead copy of itself into <head> every time
   you switch back to the app".

   Usage:  node tools/templates-test.js [resourcesDir]
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

  const setCSS = css => page.evaluate(c => App.setUserCSS(c), css);
  const nodes = () => page.evaluate(() =>
    document.querySelectorAll('head style#userCSS').length);
  const measure = () => page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue('--measure').trim());

  console.log('the user stylesheet\n');

  ok('nothing is injected before the shell sends anything', await nodes() === 0);

  const before = await measure();
  await setCSS(':root { --measure: 61rem; }');
  ok('a stylesheet arrives as one <style> in the head', await nodes() === 1);
  ok('and actually changes the app', await measure() === '61rem', await measure());

  /* The one this file exists for. The shell re-sends on every activation. */
  await setCSS(':root { --measure: 62rem; }');
  await setCSS(':root { --measure: 63rem; }');
  ok('sending it again replaces rather than stacks', await nodes() === 1);
  ok('and the newest one is what is in force', await measure() === '63rem', await measure());

  /* It has to beat the app's own rules without !important, or every person
     using it writes !important on every line and then cannot override
     themselves later. */
  await setCSS('#doc { max-width: 999px !important; }\n#stPos { display: none; }');
  ok('a plain selector beats the app stylesheet on a specificity tie',
     await page.evaluate(() => getComputedStyle(document.querySelector('#stPos')).display) === 'none');

  await setCSS('');
  ok('an empty stylesheet takes the node out again', await nodes() === 0);
  ok('and the app goes back to how it was', await measure() === before,
     `${await measure()} vs ${before}`);

  /* It must be the last thing in head, not merely present: a <style> inserted
     before the theme block would lose every tie it should win. */
  await setCSS(':root { --measure: 55rem; }');
  ok('and it sits last in the head, after the theme',
     await page.evaluate(() => document.head.lastElementChild.id === 'userCSS'));

  ok('no uncaught errors anywhere in the run', errors.length === 0, errors.join('\n        '));

  await browser.close();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
