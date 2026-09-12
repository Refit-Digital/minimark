/* ============================================================
   minimark — overlays, modes, themes, boot
   ============================================================ */
(function () {
  'use strict';

  var el = MM.el, state = MM.state, send = MM.send, esc = MM.esc, toast = MM.toast;
  var $ = function (s) { return document.querySelector(s); };

  /* ============================================================
     THEMES
     ============================================================ */
  var CORK_TEX = "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='40' height='28'%3E%3Cfilter id='c2'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.34' numOctaves='4' seed='7' stitchTiles='stitch'/%3E%3CfeColorMatrix type='saturate' values='0.25'/%3E%3C/filter%3E%3Crect width='40' height='28' filter='url(%23c2)' opacity='0.24'/%3E%3C/svg%3E\")";
  var STEEL_TEX = "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='40' height='28'%3E%3Cfilter id='s2'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.02 1.1' numOctaves='2' seed='3' stitchTiles='stitch'/%3E%3CfeColorMatrix type='saturate' values='0'/%3E%3C/filter%3E%3Crect width='40' height='28' filter='url(%23s2)' opacity='0.5'/%3E%3C/svg%3E\")";

  var THEMES = [
    { id: 'paper', name: 'Paper', kind: 'light', bg: '#fbfbfa', ink: '#1b1b19', accent: '#3e63dd' },
    { id: 'sepia', name: 'Sepia', kind: 'light', bg: '#f6f1e6', ink: '#382f24', accent: '#9d5b2c' },
    { id: 'cork',  name: 'Cork',  kind: 'light', bg: '#e8d4a3', ink: '#382914', accent: '#8c4527', tex: CORK_TEX, blend: 'multiply' },
    { id: 'ink',   name: 'Ink',   kind: 'dark',  bg: '#131315', ink: '#e9e9e6', accent: '#7b8ffa' },
    { id: 'steel', name: 'Steel', kind: 'dark',  bg: '#23262a', ink: '#e0e4e8', accent: '#8fb6d1', tex: STEEL_TEX, blend: 'overlay' },
    { id: 'void',  name: 'Void',  kind: 'dark',  bg: '#000000', ink: '#d8d8d4', accent: '#8e9bff' }
  ];

  var FONTS = [
    { id: 'system',  name: 'System',   sample: 'Aa', scale: 1,
      stack: '-apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif' },
    { id: 'newyork', name: 'New York', sample: 'Aa', scale: 1.03,
      stack: 'ui-serif, "New York", "Times New Roman", Georgia, serif' },
    { id: 'iowan',   name: 'Iowan',    sample: 'Aa', scale: 1.02,
      stack: '"Iowan Old Style", "Palatino", "Palatino Linotype", Georgia, serif' },
    { id: 'avenir',  name: 'Avenir',   sample: 'Aa', scale: 0.99,
      stack: '"Avenir Next", Avenir, "Helvetica Neue", sans-serif' },
    { id: 'mono',    name: 'Mono',     sample: 'Aa', scale: 0.93,
      stack: 'ui-monospace, "SF Mono", SFMono-Regular, Menlo, monospace' }
  ];

  /* text size. Steps rather than free zoom, so every stop stays a size
     somebody would actually choose to read at. */
  var SIZES = [0.82, 0.88, 0.94, 1, 1.08, 1.18, 1.3, 1.45];
  var SIZE_DEFAULT = 3;

  var theme = { auto: true, manual: 'paper', light: 'paper', dark: 'ink', systemDark: false,
                font: 'system', size: SIZE_DEFAULT };

  function resolvedTheme() {
    return theme.auto ? (theme.systemDark ? theme.dark : theme.light) : theme.manual;
  }

  function applyTheme() {
    el.html.dataset.theme = resolvedTheme();
    applyFont();
    renderThemePop();
  }

  /* ============================================================
     THE REVEAL

     A change of theme is a change of light, so it arrives the way light
     does: a circle opening from wherever the hand was. The View
     Transitions API holds the old frame as a still and leaves the new
     one live underneath it; all this does is uncover the new one with a
     growing clip-path. The path itself is a CSS animation in styles.css,
     driven by three custom properties set here, rather than an
     Element.animate() against ::view-transition-new(root) — WebKit's
     support for animating a pseudo-element from script is younger than
     its support for view transitions, and the keyframes cost nothing.

     Three things are easy to get wrong:

     - The circle has to reach the corner furthest from its origin, not
       the nearest, or the last of the screen snaps rather than wipes.
     - body and .tb-grip cross-fade their colours over 420ms on a theme
       change. The new frame is live, not a still, so that fade would run
       inside it and the circle would open onto the colour being left.
       .vt-theme turns both off for the length of the transition.
     - The shell's opening burst — prefs, then the system appearance —
       lands after the first paint and can name a different theme than
       the one already drawn. Nobody asked for that, so the reveal stays
       disarmed until somebody has touched the app. A wipe is a reply to
       something; there is nothing to reply to yet.
     ============================================================ */
  var REVEAL_MS = 620;

  var revealArmed = false;
  ['pointerdown', 'keydown', 'wheel'].forEach(function (t) {
    document.addEventListener(t, function () { revealArmed = true; },
                              { capture: true, once: true, passive: true });
  });

  var reduceMotion = null;
  try { reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)'); } catch (e) {}

  function revealOrigin(at) {
    if (at && isFinite(at.x) && isFinite(at.y)) return at;
    /* No pointer behind the change: the command palette, a menu item, the
       system turning dark at dusk. The appearance button is where the
       change would have come from, so it is where it comes from. */
    var r = themeBtn && themeBtn.getBoundingClientRect();
    if (r && r.width) return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    return { x: window.innerWidth / 2, y: window.innerHeight / 2 };
  }

  function reveal(at) {
    var root = el.html;
    if (!document.startViewTransition || (reduceMotion && reduceMotion.matches)) {
      applyTheme();
      return;
    }
    var o = revealOrigin(at);
    var w = window.innerWidth, h = window.innerHeight;
    var far = Math.hypot(Math.max(o.x, w - o.x), Math.max(o.y, h - o.y));
    root.style.setProperty('--reveal-x', o.x + 'px');
    root.style.setProperty('--reveal-y', o.y + 'px');
    root.style.setProperty('--reveal-r', Math.ceil(far) + 'px');
    root.style.setProperty('--reveal-ms', REVEAL_MS + 'ms');
    root.classList.add('vt-theme');
    var settle = function () { root.classList.remove('vt-theme'); };
    var vt;
    /* A transition can refuse to start — another one already running, the
       window not visible. The theme still has to change when it does. */
    try { vt = document.startViewTransition(applyTheme); }
    catch (e) { settle(); applyTheme(); return; }
    vt.finished.then(settle, settle);
  }

  /* The resolved theme not moving is the common case on a system change
     while a theme is pinned, and on picking the theme already in use. A
     wipe onto an identical frame is invisible and still costs two
     snapshots of the whole window. */
  function swapTheme(at) {
    if (resolvedTheme() === el.html.dataset.theme) { applyTheme(); return; }
    reveal(at);
  }

  /* A pick arms the reveal itself as well as riding it: a theme chosen from
     the native menu bar never touches the web view, so nothing else would. */
  function revealTheme(at) { revealArmed = true; swapTheme(at); }
  function revealThemeSystem() { if (revealArmed) swapTheme(null); else applyTheme(); }

  /* the point a click happened at, or null for anything that was not one —
     a keyboard activation reports 0,0, which is a real corner of the window */
  function pointOf(e) {
    return (e && e.detail && (e.clientX || e.clientY)) ? { x: e.clientX, y: e.clientY } : null;
  }

  function applyFont() {
    var f = FONTS.find(function (x) { return x.id === theme.font; }) || FONTS[0];
    el.html.style.setProperty('--prose', f.stack);
    el.html.style.setProperty('--fscale', String(f.scale));
    el.html.style.setProperty('--usize', String(SIZES[theme.size] || 1));
    /* a typeface or size change moves every line — rebuild the anchor table */
    if (MM.invalidateAnchors) { MM.autosizeSrc(); MM.invalidateAnchors(); }
  }

  function setSize(i, quiet) {
    i = Math.max(0, Math.min(SIZES.length - 1, i));
    if (i === theme.size) return;
    theme.size = i;
    applyFont();
    renderThemePop();
    send('pref', { key: 'size', value: String(i) });
    if (!quiet) toast(Math.round(SIZES[i] * 100) + '%');
  }
  function stepSize(d) { setSize(theme.size + d); }

  function pickFont(id) {
    theme.font = id;
    applyFont();
    renderThemePop();
    send('pref', { key: 'font', value: id });
    var f = FONTS.find(function (x) { return x.id === id; });
    toast(f ? f.name : id);
  }

  function pickTheme(id, at) {
    var t = THEMES.find(function (x) { return x.id === id; });
    if (!t) return;
    theme.auto = false;
    theme.manual = id;
    if (t.kind === 'light') theme.light = id; else theme.dark = id;
    persistTheme();
    revealTheme(at);
    toast(t.name);
  }

  function setAuto(on, at) {
    theme.auto = on;
    persistTheme();
    revealTheme(at);
    /* theme.manual comes straight from a stored preference, so it can name a
       theme that no longer exists. .find() then returns undefined and reading
       .name threw — after persistTheme and applyTheme had already run, leaving
       the appearance half-changed. */
    var picked = THEMES.find(function (x) { return x.id === theme.manual; });
    toast(on ? 'Following system' : (picked ? picked.name : 'Custom'));
  }

  /* ============================================================
     RENAME BY CLICKING THE TITLE
     ============================================================ */
  var docTitle = $('#docTitle'), docName = $('#docName');

  function startRename() {
    if (docTitle.classList.contains('editing')) return;
    if (!state.docDir) { send('menu', { name: 'saveAs' }); return; }
    docTitle.classList.add('editing');
    docName.setAttribute('contenteditable', 'plaintext-only');
    docName.focus();
    var full = docName.textContent, dot = full.lastIndexOf('.');
    try {
      var r = document.createRange(), tn = docName.firstChild;
      if (tn) {
        r.setStart(tn, 0);
        r.setEnd(tn, dot > 0 ? dot : full.length);
        var sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(r);
      }
    } catch (e) {}
  }

  function endRename(commit) {
    if (!docTitle.classList.contains('editing')) return;
    docTitle.classList.remove('editing');
    docName.removeAttribute('contenteditable');
    var v = docName.textContent.replace(/[\/\r\n]+/g, '').trim();
    if (commit && v && v !== state.fileName) send('rename', { name: v });
    else docName.textContent = state.fileName;
    try { window.getSelection().removeAllRanges(); } catch (e) {}
    if (state.mode === 'split') el.src.focus();
  }

  docTitle.addEventListener('click', startRename);
  docName.addEventListener('keydown', function (e) {
    e.stopPropagation();
    if (e.key === 'Enter') { e.preventDefault(); endRename(true); }
    else if (e.key === 'Escape') { e.preventDefault(); endRename(false); }
  });
  docName.addEventListener('blur', function () { endRename(true); });

  function persistTheme() {
    send('pref', { key: 'themeAuto', value: theme.auto ? '1' : '0' });
    send('pref', { key: 'theme', value: theme.manual });
    send('pref', { key: 'themeLight', value: theme.light });
    send('pref', { key: 'themeDark', value: theme.dark });
  }

  var themePop = $('#themePop');

  function swatch(t) {
    var tex = t.tex ? 'background-image:' + t.tex + ';background-blend-mode:' + t.blend + ';background-size:40px 28px;' : '';
    return '<span class="sw" style="background-color:' + t.bg + ';' + tex + '">' +
           '<i style="background:' + t.ink + '"></i><u style="background:' + t.accent + '"></u></span>';
  }

  function renderThemePop() {
    var cur = resolvedTheme();
    var h = '<div class="tp-row' + (theme.auto ? ' on' : '') + '" data-auto="1">' +
            '<span class="sw" style="background:linear-gradient(120deg,#fbfbfa 0 50%,#131315 50% 100%)"></span>' +
            '<span>Follow system</span><span class="tick">✓</span></div><div class="tp-sep"></div>';
    ['light', 'dark'].forEach(function (kind) {
      h += '<div class="tp-head">' + kind + '</div>';
      THEMES.filter(function (t) { return t.kind === kind; }).forEach(function (t) {
        var on = (!theme.auto && theme.manual === t.id) || (theme.auto && cur === t.id);
        h += '<div class="tp-row' + (on ? ' on' : '') + '" data-theme="' + t.id + '">' +
             swatch(t) + '<span>' + t.name + '</span><span class="tick">✓</span></div>';
      });
    });
    h += '<div class="tp-sep"></div><div class="tp-head">text size</div>';
    h += '<div class="tp-size">' +
         '<button type="button" data-size="-1" title="Smaller  ⌘-"' +
         (theme.size <= 0 ? ' disabled' : '') + '>' +
         '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M4 8h8"/></svg></button>' +
         '<span class="tp-steps">' +
         SIZES.map(function (s, i) {
           return '<i class="tp-step' + (i <= theme.size ? ' on' : '') + '" data-setsize="' + i + '"></i>';
         }).join('') +
         '</span>' +
         '<button type="button" data-size="1" title="Bigger  ⌘+"' +
         (theme.size >= SIZES.length - 1 ? ' disabled' : '') + '>' +
         '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M8 4v8M4 8h8"/></svg></button>' +
         '<span class="tp-val">' + Math.round(SIZES[theme.size] * 100) + '%</span>' +
         '</div>';
    h += '<div class="tp-sep"></div><div class="tp-head">typeface</div>';
    FONTS.forEach(function (f) {
      h += '<div class="tp-row' + (theme.font === f.id ? ' on' : '') + '" data-font="' + f.id + '">' +
           '<span class="fname" style="font-family:' + f.stack.replace(/"/g, "'") + '">' + f.sample + '</span>' +
           '<span style="font-family:' + f.stack.replace(/"/g, "'") + '">' + f.name + '</span>' +
           '<span class="tick">✓</span></div>';
    });
    themePop.innerHTML = h;
  }

  themePop.addEventListener('click', function (e) {
    var step = e.target.closest('[data-size]');
    if (step) { stepSize(parseInt(step.dataset.size, 10)); return; }
    var dot = e.target.closest('[data-setsize]');
    if (dot) { setSize(parseInt(dot.dataset.setsize, 10)); return; }
    var row = e.target.closest('.tp-row');
    if (!row) return;
    var at = pointOf(e);
    if (row.dataset.auto) setAuto(!theme.auto, at);
    else if (row.dataset.font) pickFont(row.dataset.font);
    else pickTheme(row.dataset.theme, at);
  });

  var themeBtn = $('#themeBtn');
  themeBtn.addEventListener('click', function (e) {
    e.stopPropagation();
    themePop.classList.toggle('open');
    themeBtn.classList.toggle('on', themePop.classList.contains('open'));
    closeHelp();
  });
  document.addEventListener('mousedown', function (e) {
    if (!themePop.contains(e.target) && e.target.closest('#themeBtn') === null) {
      themePop.classList.remove('open');
      themeBtn.classList.remove('on');
    }
  });

  try {
    var mq = window.matchMedia('(prefers-color-scheme: dark)');
    theme.systemDark = mq.matches;
    mq.addEventListener('change', function (e) { theme.systemDark = e.matches; revealThemeSystem(); });
  } catch (e) {}

  /* ============================================================
     HELP PANEL
     ============================================================ */
  var CHEAT = [
    ['Text', [
      ['**bold**', '**bold**'],
      ['*italic*', '*italic*'],
      ['~~strikethrough~~', '~~strikethrough~~'],
      ['`inline code`', '`inline code`'],
      ['line  ⏎ break (2 spaces)', 'line  \nbreak']
    ]],
    ['Structure', [
      ['# Heading 1', '# Heading 1'],
      ['## Heading 2', '## Heading 2'],
      ['### Heading 3', '### Heading 3'],
      ['> A quotation', '> A quotation'],
      ['---', '---']
    ]],
    ['Lists', [
      ['- item\n- item', '- item\n- item'],
      ['1. first\n2. second', '1. first\n2. second'],
      ['- [ ] to do\n- [x] done', '- [ ] to do\n- [x] done'],
      ['- item\n  - nested', '- item\n  - nested']
    ]],
    ['Links & media', [
      ['[label](https://url)', '[label](https://example.com)'],
      ['<https://url>', '<https://example.com>'],
      ['![alt](picture.png)', null, '<em>alt</em> → embedded image']
    ]],
    ['Code & tables', [
      ['```js\ncode block\n```', '```\ncode block\n```'],
      ['| A | B |\n|---|---|\n| 1 | 2 |', '| A | B |\n|---|---|\n| 1 | 2 |']
    ]],
    ['Extras', [
      ['Footnote[^1]\n\n[^1]: The note', null, 'Footnote<sup class="fn-ref">1</sup>'],
      ['$E = mc^2$', null, 'inline maths (KaTeX)'],
      ['$$\\int_0^1 x\\,dx$$', null, 'display maths'],
      ['---\ntitle: Notes\n---', null, 'front matter card'],
      ['\\*not italic\\*', '\\*not italic\\*']
    ]]
  ];

  function buildHelp() {
    var html = '';
    CHEAT.forEach(function (sec, si) {
      html += '<div class="help-grp"><div class="help-sec' + (si === 0 ? ' first' : '') + '">' + sec[0] + '</div>';
      sec[1].forEach(function (row) {
        var out = row[2] != null ? row[2] : MM.md(row[1], -1);
        html += '<div class="help-row"><div class="syn">' + esc(row[0]) + '</div><div class="out">' + out + '</div></div>';
      });
      html += '</div>';
    });
    $('#helpBody').innerHTML = html;
  }

  var help = $('#help'), helpBtn = $('#helpBtn');

  function openHelp() { help.classList.add('open'); helpBtn.classList.add('on'); }
  function closeHelp() { help.classList.remove('open'); helpBtn.classList.remove('on'); }
  function toggleHelp() { help.classList.contains('open') ? closeHelp() : openHelp(); }

  helpBtn.addEventListener('click', function (e) {
    e.stopPropagation();
    toggleHelp();
    themePop.classList.remove('open'); themeBtn.classList.remove('on');
  });
  document.addEventListener('mousedown', function (e) {
    if (help.classList.contains('open') && !help.contains(e.target) && e.target.closest('#helpBtn') === null) closeHelp();
  });

  /* ============================================================
     ZEN / FOCUS / TYPEWRITER
     ============================================================ */
  function setZen(on) {
    state.zen = on;
    el.body.classList.toggle('zen', on);
    resetZenReveal();
    $('#zenBtn').classList.toggle('on', on);
    send('zen', { on: on });
    requestAnimationFrame(function () {
      MM.autosizeSrc(); MM.movePill(false); MM.positionBar(false);
    });
    toast(on ? 'Zen mode  ·  ⌃⌥Z to exit' : 'Zen off');
  }

  $('#zenBtn').addEventListener('click', function () { setZen(!state.zen); });

  /* ------------------------------------------------------------------
     Zen reveal.

     Zen takes the bar away. Two things bring it back: moving the pointer
     near where it lives, or scrolling up — the gesture you already make
     when you want to get back to the top of a document. It leaves again
     when the pointer wanders off, or on the next downward scroll.

     No timers anywhere. Nothing disappears while you are still reaching
     for it, which is the failure mode of every auto-hiding toolbar.

     The proximity box is the bar's own rectangle, generously padded,
     because the target is invisible at the moment you go looking for it.
     It follows the bar between live and split view for free: the geometry
     is read back out of the same custom properties that place it.
     ------------------------------------------------------------------ */
  var ZEN_NEAR_X = 60;   // how far either side of the bar still counts as near
  var ZEN_NEAR_Y = 40;   // and how far below it

  var revealHover = false, revealScroll = false, lastTopReveal = null;

  function barZone() {
    var bar = $('#titlebar');
    var x = parseFloat(getComputedStyle(el.html).getPropertyValue('--bar-x')) || 0;
    var w = (bar && bar.offsetWidth) || 103;
    var h = (bar && bar.offsetHeight) || 32;
    return { l: x - ZEN_NEAR_X, r: x + w + ZEN_NEAR_X, b: h + ZEN_NEAR_Y };
  }

  function syncTopReveal() {
    var on = revealHover || revealScroll;
    el.body.classList.toggle('rt', on);
    if (on !== lastTopReveal) { lastTopReveal = on; send('zenReveal', { on: on }); }
  }

  function resetZenReveal() {
    revealHover = revealScroll = false;
    lastTopReveal = null;
    el.body.classList.remove('rt', 'rb');
  }

  document.addEventListener('mousemove', function (e) {
    if (!state.zen) { if (lastTopReveal !== null) resetZenReveal(); return; }
    var z = barZone();
    revealHover = e.clientY <= z.b && e.clientX >= z.l && e.clientX <= z.r;
    el.body.classList.toggle('rb', e.clientY > window.innerHeight - 54);
    syncTopReveal();
  });

  /* Both panes scroll independently, so both are watched. Direction is taken
     from the pane's own last position rather than from wheel deltas, which
     keeps trackpad momentum and scrollbar drags honest. */
  var lastY = {};
  [[el.srcScroll, 'src'], [el.prevPane, 'prev']].forEach(function (pair) {
    var node = pair[0], key = pair[1];
    if (!node) return;
    node.addEventListener('scroll', function () {
      var y = node.scrollTop, prev = lastY[key];
      lastY[key] = y;
      if (!state.zen || prev == null || y === prev) return;
      revealScroll = y < prev;
      syncTopReveal();
    }, { passive: true });
  });

  function setFocus(on) {
    state.focus = on;
    el.body.classList.toggle('focus', on);
    applyFocusLevel();
    toast(on ? 'Focus mode  ·  ' + state.focusLevel : 'Focus off');
  }

  /* Paragraph or sentence. The class carries it rather than the JS, because
     what it changes is which of two drawing layers is in force, and both are
     CSS. Repainting after is not optional: the sentence spans and the block
     mirror are only built while the level calls for them, so switching level
     has to build or tear down whichever one just changed hands. */
  function applyFocusLevel() {
    el.body.classList.toggle('focus-sentence', state.focus && state.focusLevel === 'sentence');
    MM.markCurrentLine();
    MM.markCurrentBlock();
    MM.paintBlockSentences();
    MM.paintLineSentences();
  }

  function setFocusLevel(level, silent) {
    state.focusLevel = level === 'sentence' ? 'sentence' : 'paragraph';
    applyFocusLevel();
    if (silent) return;
    send('pref', { key: 'focusLevel', value: state.focusLevel });
    /* Choosing a level is choosing to be in focus mode. Setting it and seeing
       nothing happen because focus was off would read as the setting failing. */
    if (!state.focus) { setFocus(true); return; }
    toast(state.focusLevel === 'sentence' ? 'Focus: sentence' : 'Focus: paragraph');
  }

  var twBtn = $('#twBtn');
  twBtn.addEventListener('click', function () { setTypewriter(!state.typewriter); });

  function setTypewriter(on) {
    state.typewriter = on;
    twBtn.classList.toggle('on', on);
    toast(on ? 'Typewriter scrolling' : 'Typewriter off');
    if (on) { state.mode === 'split' ? MM.typewriterSplit() : MM.typewriterLive(); }
  }

  /* ============================================================
     STYLE CHECK
     ============================================================
     Marks fillers, clichés and redundancies in the rendered document. The
     dictionary and the matcher are in style-check.js, on purpose: that file
     is the one people will want to argue with, and arguing with it should not
     mean reading this one.

     It marks the *rendered* text rather than the source, because the source
     is full of markdown and a phrase split by a `**` is not a phrase the
     matcher can see. It follows that in split view the marks appear in the
     preview beside what you are typing, which is where your eye already goes
     to check yourself. The block being written in is a textarea and gets no
     marks at all, which is right: highlights that move under the caret while
     you type are worse than no highlights. */
  var styleBtn = $('#styleBtn'), stStyle = $('#stStyle');
  var styleMarks = [], styleAt = -1, styleTimer = null;
  var styleCounts = { filler: 0, cliche: 0, redundancy: 0 };

  /* No more than this many in one document. A pathological file — a word
     list, a thesaurus, somebody's notes on filler words — should slow the
     editor down not at all, and the two-thousandth mark tells the writer
     nothing the first fifty did not. */
  var STYLE_CAP = 2000;

  function clearStyle() {
    if (!styleMarks.length) return;
    var parents = [];
    for (var i = 0; i < styleMarks.length; i++) {
      var m = styleMarks[i], p = m.parentNode;
      if (!p) continue;                       /* the block was re-rendered under us */
      p.replaceChild(document.createTextNode(m.textContent), m);
      if (parents.indexOf(p) === -1) parents.push(p);
    }
    for (var j = 0; j < parents.length; j++) parents[j].normalize();
    styleMarks = []; styleAt = -1;
  }

  /* Prose only. "just" inside a code sample is a variable name and "very" in
     a maths block is not a word at all. Nothing inside an existing <mark>
     either, so these and the find highlights cannot nest inside each other
     and leave the other's cleanup with orphaned nodes to normalize. */
  function styleTextNodes() {
    var walker = document.createTreeWalker(el.doc, NodeFilter.SHOW_TEXT, {
      acceptNode: function (n) {
        if (!n.nodeValue || !n.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
        var p = n.parentNode;
        while (p && p !== el.doc) {
          var tag = p.nodeName;
          if (tag === 'TEXTAREA' || tag === 'SCRIPT' || tag === 'STYLE' ||
              tag === 'CODE' || tag === 'PRE' || tag === 'MARK')
            return NodeFilter.FILTER_REJECT;
          if (p.classList && (p.classList.contains('katex') || p.classList.contains('katex-display')))
            return NodeFilter.FILTER_REJECT;
          p = p.parentNode;
        }
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    var out = [], n;
    while ((n = walker.nextNode())) out.push(n);
    return out;
  }

  function paintStyle() {
    clearStyle();
    styleCounts = { filler: 0, cliche: 0, redundancy: 0 };
    if (!state.styleCheck || !window.MMStyle) { updateStyleCount(); return; }
    /* collect first, then replace: the walker is live and rewriting a node
       while it is standing on it is how you skip half the document */
    var nodes = styleTextNodes();
    for (var i = 0; i < nodes.length && styleMarks.length < STYLE_CAP; i++) {
      var node = nodes[i], v = node.nodeValue;
      var hits = MMStyle.scan(v);
      if (!hits.length || !node.parentNode) continue;
      var frag = document.createDocumentFragment(), at = 0;
      for (var k = 0; k < hits.length && styleMarks.length < STYLE_CAP; k++) {
        var h = hits[k];
        if (h.at > at) frag.appendChild(document.createTextNode(v.slice(at, h.at)));
        var mk = document.createElement('mark');
        mk.className = 'smark smark-' + h.kind;
        mk.title = h.why ? h.label + ': ' + h.why : h.label;
        mk.appendChild(document.createTextNode(v.slice(h.at, h.at + h.len)));
        frag.appendChild(mk);
        styleMarks.push(mk);
        styleCounts[h.kind]++;
        at = h.at + h.len;
      }
      if (at < v.length) frag.appendChild(document.createTextNode(v.slice(at)));
      node.parentNode.replaceChild(frag, node);
    }
    updateStyleCount();
  }

  /* Repainting is debounced separately from rendering. renderDoc already runs
     on a 90ms debounce while somebody is typing, and walking every text node
     in the document that often is exactly the kind of full-document work per
     keystroke this editor is trying not to do. */
  function scheduleStyle() {
    if (styleTimer) clearTimeout(styleTimer);
    if (!state.styleCheck) { clearStyle(); updateStyleCount(); return; }
    styleTimer = setTimeout(function () { styleTimer = null; paintStyle(); }, 220);
  }

  function styleTotal() {
    return styleCounts.filler + styleCounts.cliche + styleCounts.redundancy;
  }

  function updateStyleCount() {
    if (!stStyle) return;
    stStyle.hidden = !state.styleCheck;
    if (!state.styleCheck) return;
    var n = styleTotal();
    stStyle.innerHTML = '<b>' + n + '</b> ' + (n === 1 ? 'note' : 'notes');
    stStyle.title = n
      ? styleCounts.filler + ' filler  ·  ' + styleCounts.cliche + ' cliché  ·  ' +
        styleCounts.redundancy + ' redundancy  ·  click to step through'
      : 'Nothing flagged';
  }

  /* Step to the next mark and put it in the middle of the pane. The document
     can be repainted between two clicks — the writer fixed one — so the index
     is bounded on the way in rather than trusted. */
  function styleStep() {
    if (!styleMarks.length) return;
    if (styleAt >= 0 && styleMarks[styleAt]) styleMarks[styleAt].classList.remove('cur');
    styleAt = (styleAt + 1) % styleMarks.length;
    var mk = styleMarks[styleAt];
    mk.classList.add('cur');
    mk.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }

  function setStyleCheck(on, silent) {
    state.styleCheck = !!on;
    if (styleBtn) styleBtn.classList.toggle('on', state.styleCheck);
    paintStyle();
    if (silent) return;
    send('pref', { key: 'styleCheck', value: state.styleCheck ? '1' : '0' });
    if (!state.styleCheck) { toast('Style check off'); return; }
    var n = styleTotal();
    toast(n ? 'Style check  ·  ' + n + (n === 1 ? ' note' : ' notes')
            : 'Style check  ·  nothing flagged');
  }

  if (styleBtn) styleBtn.addEventListener('click', function () { setStyleCheck(!state.styleCheck); });
  if (stStyle) stStyle.addEventListener('click', styleStep);

  /* ============================================================
     HEADING SCRUBBER
     ============================================================ */
  var scrub = $('#scrub'), scrubLabel = $('#scrubLabel');

  function headings() {
    var out = [];
    state.blocks.forEach(function (b, i) {
      var m = /^(#{1,6})\s+(.*)$/.exec(b.trim());
      if (m) out.push({ i: i, level: m[1].length, text: m[2].replace(/[*_`~]/g, '').trim() });
    });
    return out;
  }

  function buildScrub() {
    var hs = headings();
    if (hs.length < 2) { scrub.innerHTML = ''; scrub.classList.remove('has'); return; }
    scrub.classList.add('has');
    var total = Math.max(1, el.doc.scrollHeight - el.prevPane.clientHeight * 0.45);
    scrub.innerHTML = hs.map(function (h) {
      var node = el.doc.children[h.i];
      var pct = node ? Math.min(97, Math.max(2, (node.offsetTop / total) * 100)) : 50;
      return '<span class="tick" data-l="' + h.level + '" data-i="' + h.i +
             '" style="top:' + pct.toFixed(2) + '%" title="' + esc(h.text) + '"></span>';
    }).join('');
  }

  scrub.addEventListener('mouseover', function (e) {
    var t = e.target.closest('.tick'); if (!t) return;
    scrubLabel.textContent = t.getAttribute('title');
    var r = t.getBoundingClientRect();
    scrubLabel.style.top = (r.top + r.height / 2) + 'px';
    scrubLabel.classList.add('show');
  });
  scrub.addEventListener('mouseleave', function () { scrubLabel.classList.remove('show'); });
  scrub.addEventListener('click', function (e) {
    var t = e.target.closest('.tick'); if (!t) return;
    jumpToBlock(parseInt(t.dataset.i, 10));
  });

  function jumpToBlock(i) {
    var node = el.doc.children[i];
    if (!node) return;
    if (state.mode === 'split') {
      /* scroll the source only and let the sync carry the preview — two
         competing smooth animations used to fight each other */
      var off = MM.blockStartOffsets()[i] || 0;
      el.src.focus(); el.src.setSelectionRange(off, off);
      MM.updateCaretStatus(); MM.markCurrentLine();
      var ln = el.hl.children[el.src.value.slice(0, off).split('\n').length - 1];
      if (ln) el.srcScroll.scrollTo({ top: Math.max(0, ln.offsetTop - 60), behavior: 'smooth' });
    } else {
      el.prevPane.scrollTo({ top: el.prevPane.scrollTop + node.getBoundingClientRect().top - el.prevPane.getBoundingClientRect().top - 24, behavior: 'smooth' });
    }
    el.body.classList.add('scrubbing');
    setTimeout(function () { el.body.classList.remove('scrubbing'); }, 900);
  }

  /* Two things want to know the document was rebuilt. Assigning the hook
     twice would silently leave one of them out, which is exactly the sort of
     thing that is found six weeks later. */
  MM.onDocRendered = function () { buildScrub(); scheduleStyle(); };

  /* Up while the page is moving, and back down a beat after it stops. That
     beat is the whole feature: scrolling is when somebody is looking for where
     they are in the document, and it is the one moment the outline can answer
     without being asked. Longer than the fade so the ticks do not start
     dimming while the scroll is still under the finger. */
  var scrubLitT = null;
  function litScrub() {
    scrub.classList.add('lit');
    clearTimeout(scrubLitT);
    scrubLitT = setTimeout(function () { scrub.classList.remove('lit'); }, 900);
  }

  MM.onPreviewScroll = function () {
    var ticks = scrub.querySelectorAll('.tick');
    if (!ticks.length) return;
    litScrub();
    var top = el.prevPane.getBoundingClientRect().top + 60, best = 0;
    ticks.forEach(function (t, n) {
      var node = el.doc.children[parseInt(t.dataset.i, 10)];
      if (node && node.getBoundingClientRect().top <= top) best = n;
    });
    ticks.forEach(function (t, n) { t.classList.toggle('cur', n === best); });
  };

  /* ============================================================
     PICKER (command palette + heading jump)
     ============================================================ */
  var pickerWrap = $('#pickerWrap'), pickerInput = $('#pickerInput'), pickerList = $('#pickerList');
  var pk = { items: [], filtered: [], sel: 0, open: false };

  function score(hay, needle) {
    if (!needle) return 1;
    hay = hay.toLowerCase(); needle = needle.toLowerCase();
    var idx = hay.indexOf(needle);
    if (idx > -1) return 1000 - idx;
    var h = 0, s = 0, last = -1;
    for (var n = 0; n < needle.length; n++) {
      h = hay.indexOf(needle[n], h);
      if (h === -1) return 0;
      s += (h === last + 1) ? 3 : 1;
      last = h; h++;
    }
    return s;
  }

  function renderPicker() {
    var q = pickerInput.value.trim();
    pk.filtered = pk.items
      .map(function (it) { return { it: it, s: score(it.title + ' ' + (it.hint || ''), q) }; })
      .filter(function (x) { return x.s > 0; })
      .sort(function (a, b) { return b.s - a.s; })
      .map(function (x) { return x.it; })
      .slice(0, 60);
    if (pk.sel >= pk.filtered.length) pk.sel = 0;
    if (!pk.filtered.length) { pickerList.innerHTML = '<div class="pk-empty">Nothing found</div>'; return; }
    pickerList.innerHTML = pk.filtered.map(function (it, i) {
      return '<div class="pk' + (i === pk.sel ? ' sel' : '') + '" data-i="' + i + '">' +
        (it.level ? '<span class="pk-h">H' + it.level + '</span>' : '') +
        '<span class="pk-t">' + esc(it.title) + '</span>' +
        (it.hint ? '<span class="pk-hint">' + esc(it.hint) + '</span>' : '') +
        (it.key ? '<span class="pk-k">' + it.key + '</span>' : '') + '</div>';
    }).join('');
  }

  function openPicker(items, placeholder) {
    pk.items = items; pk.sel = 0; pk.open = true;
    pickerInput.value = ''; pickerInput.placeholder = placeholder || 'Type a command';
    renderPicker();
    pickerWrap.classList.add('open');
    setTimeout(function () { pickerInput.focus(); }, 30);
  }
  function closePicker() {
    pk.open = false;
    pickerWrap.classList.remove('open');
    if (state.mode === 'split') el.src.focus();
  }
  function runSel() {
    var it = pk.filtered[pk.sel];
    closePicker();
    if (it && it.run) setTimeout(it.run, 60);
  }

  pickerInput.addEventListener('input', function () { pk.sel = 0; renderPicker(); });
  pickerInput.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') { e.preventDefault(); closePicker(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); pk.sel = Math.min(pk.sel + 1, pk.filtered.length - 1); renderPicker(); scrollSel(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); pk.sel = Math.max(pk.sel - 1, 0); renderPicker(); scrollSel(); }
    else if (e.key === 'Enter') { e.preventDefault(); runSel(); }
  });
  function scrollSel() {
    var n = pickerList.querySelector('.pk.sel');
    if (n) n.scrollIntoView({ block: 'nearest' });
  }
  pickerList.addEventListener('mousedown', function (e) {
    var n = e.target.closest('.pk'); if (!n) return;
    e.preventDefault(); pk.sel = parseInt(n.dataset.i, 10); runSel();
  });
  pickerWrap.addEventListener('mousedown', function (e) { if (e.target === pickerWrap) closePicker(); });

  /* The recent list is the shell's — NSDocumentController owns it — and
     arrives over the bridge whenever it changes. Having it in the palette
     matters more than having it in a menu: typing three letters of a filename
     beats pulling down File and reading. */
  var recents = [];

  function recentItems() {
    return recents.map(function (r) {
      return {
        title: r.name,
        hint: 'open recent document file',
        key: 'Recent',
        run: function () { send('openRecent', { path: r.path }); }
      };
    });
  }

  function commandItems() {
    var t = THEMES.map(function (th) {
      return { title: 'Theme: ' + th.name, hint: 'appearance colour', run: function () { pickTheme(th.id); } };
    }).concat(FONTS.map(function (f) {
      return { title: 'Font: ' + f.name, hint: 'typeface appearance', run: function () { pickFont(f.id); } };
    }));
    return [
      { title: 'Switch to Split view', key: '⌘1', run: function () { MM.setMode('split'); } },
      { title: 'Switch to Live preview', key: '⌘2', run: function () { MM.setMode('live'); } },
      { title: 'Toggle Zen mode', key: '⌃⌥Z', run: function () { setZen(!state.zen); } },
      { title: 'Rename this file…', run: startRename },
      { title: 'Toggle Full Screen', key: '⌃⌘F', run: function () { send('menu', { name: 'fullscreen' }); } },
      { title: 'Toggle Focus mode', key: '⌘⇧D', run: function () { setFocus(!state.focus); } },
      { title: 'Focus: sentence', hint: 'light only the sentence you are in', run: function () { setFocusLevel('sentence'); } },
      { title: 'Focus: paragraph', hint: 'light the whole paragraph', run: function () { setFocusLevel('paragraph'); } },
      { title: 'Toggle Typewriter scrolling', key: '⌘⇧T', run: function () { setTypewriter(!state.typewriter); } },
      { title: 'Version history…', key: '⌘⇧H', hint: 'restore an earlier state', run: openHistory },
      { title: 'Bigger text', key: '⌘+', run: function () { stepSize(1); } },
      { title: 'Smaller text', key: '⌘-', run: function () { stepSize(-1); } },
      { title: 'Reset text size', key: '⌘0', run: function () { setSize(SIZE_DEFAULT); } },
      { title: 'Jump to heading…', key: '⌘R', run: openHeadings },
      { title: 'Find and replace', key: '⌘F', run: openFind },
      { title: 'Markdown reference', key: '⌘/', run: openHelp },
      { title: 'Copy document as rich text', key: '⌥⌘C', run: MM.copyRich },
      { title: 'Copy document as markdown', run: function () { send('copyRich', { html: '', text: state.text }); toast('Copied markdown'); } },
      { title: 'Theme: follow system', hint: 'auto appearance', run: function () { setAuto(true); } },
      { title: 'New document', key: '⌘N', run: function () { send('menu', { name: 'new' }); } },
      { title: 'Open…', key: '⌘O', run: function () { send('menu', { name: 'open' }); } },
      { title: 'Save', key: '⌘S', run: function () { send('menu', { name: 'save' }); } },
      { title: 'Save as…', key: '⇧⌘S', run: function () { send('menu', { name: 'saveAs' }); } },
      { title: 'Export as HTML…', run: function () { send('menu', { name: 'exportHTML' }); } },
      { title: 'Templates folder…', run: function () { send('menu', { name: 'templates' }); } },
      { title: 'Export as PDF…', run: function () { send('menu', { name: 'exportPDF' }); } },
      { title: 'Print…', key: '⌘P', run: function () { send('menu', { name: 'print' }); } },
      { title: 'Page Setup…', key: '⇧⌘P', run: function () { send('menu', { name: 'pageSetup' }); } },
      { title: 'Reveal in Finder', run: function () { send('menu', { name: 'reveal' }); } },
      { title: 'Insert table', run: function () { insertSnippet('| Column | Column |\n| --- | --- |\n|  |  |'); } },
      { title: 'Insert code block', run: function () { insertSnippet('```\n\n```'); } },
      { title: 'Insert horizontal rule', run: function () { insertSnippet('---'); } },
      { title: 'Insert today’s date', run: function () { insertSnippet(new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })); } },
      { title: 'Insert front matter', run: function () { insertFrontMatter(); } }
    ].concat(recentItems()).concat(t);
  }

  function insertSnippet(text) {
    var ta = MM.activeTextarea();
    if (!ta) { el.src.focus(); ta = el.src; }
    MM.replaceRange(ta, ta.selectionStart, ta.selectionEnd, text);
  }
  function insertFrontMatter() {
    var fm = '---\ntitle: ' + state.fileName.replace(/\.md$/, '') + '\ndate: ' + new Date().toISOString().slice(0, 10) + '\n---\n\n';
    MM.setText(fm + state.text, { immediate: true });
  }

  function openHeadings() {
    var hs = headings();
    if (!hs.length) { toast('No headings yet'); return; }
    openPicker(hs.map(function (h) {
      return { title: h.text || '(untitled)', level: h.level, run: function () { jumpToBlock(h.i); } };
    }), 'Jump to heading');
  }

  function openPalette() { openPicker(commandItems(), 'Type a command'); }

  /* ============================================================
     WINDOW DRAG STRIP

     The strip across the top belongs to the window, not the document, so it
     swallows the mouse and nothing there is selectable. Actually moving the
     window needs the native side: WebKit does not implement -webkit-app-region
     (that is Chromium's), and this build has no drag handler. The message
     below is sent regardless, so the moment AppDelegate answers 'dragWindow'
     with performWindowDragWithEvent the strip becomes a real drag handle with
     no further change here.
     ============================================================ */
  var titlebar = $('#titlebar');
  titlebar.addEventListener('mousedown', function (e) {
    e.preventDefault();
    send('dragWindow', { x: e.screenX, y: e.screenY });
  });
  titlebar.addEventListener('dblclick', function () { send('menu', { name: 'zoom' }); });

  /* ============================================================
     VERSION HISTORY
     ============================================================ */
  var HIST_STEPS = [
    { id: '1m', ms: 60e3,            label: '1 minute ago' },
    { id: '5m', ms: 5 * 60e3,        label: '5 minutes ago' },
    { id: '15m', ms: 15 * 60e3,      label: '15 minutes ago' },
    { id: '1h', ms: 60 * 60e3,       label: '1 hour ago' },
    { id: '5h', ms: 5 * 60 * 60e3,   label: '5 hours ago' },
    { id: '1d', ms: 24 * 3600e3,     label: '1 day ago' },
    { id: '3d', ms: 3 * 24 * 3600e3, label: '3 days ago' },
    { id: '1w', ms: 7 * 24 * 3600e3, label: '1 week ago' }
  ];

  function stamp(t) {
    var d = new Date(t), now = new Date();
    var time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    if (d.toDateString() === now.toDateString()) return time;
    return d.toLocaleDateString([], { day: 'numeric', month: 'short' }) + ' ' + time;
  }

  function wordDelta(n) {
    if (!n) return 'same length';
    return n > 0 ? ('+' + n + ' words') : (n + ' words');
  }

  function doRestore(ms, label) {
    var r = MM.histRestore(ms);
    if (!r) { toast('No snapshot from ' + label); return; }
    if (r.same) { toast('Already as it was ' + label); return; }
    toast('Restored to ' + stamp(r.t) + ' · ⌘Z or Undo restore');
  }

  /* ------------------------------------------------------------------
     The browser.

     The eight fixed steps above are still what the Restore submenu and the
     restore* commands fire, because "take me back an hour" is a real thing to
     want and it needs no interface. They are a poor way to see what is there,
     though: the store keeps up to sixty snapshots per document and the steps
     can only land on eight of them, so most of what is kept was unreachable
     and none of it could be looked at before it was restored over the top of
     the present. This lists the chain and shows what a snapshot holds first.
  ------------------------------------------------------------------ */

  /* `all` is every snapshot; `rows` is what the filter left showing. */
  var hb = { open: false, all: [], rows: [], sel: 0, text: '' };
  var histWrap = $('#histWrap');
  var histFilter = $('#histFilter');
  var histListEl = $('#histList');
  var histPreview = $('#histPreview');
  var histSideMeta = $('#histSideMeta');
  var histMeta = $('#histMeta');
  var histHint = $('#histHint');
  var histRestoreBtn = $('#histRestoreBtn');
  var histUndoBtn = $('#histUndoBtn');

  /* How long ago, in the fewest words that are still true. */
  function ago(t) {
    var s = Math.max(0, Date.now() - t) / 1000;
    if (s < 45) return 'just now';
    if (s < 5400) return Math.round(s / 60) + 'm ago';
    if (s < 36 * 3600) return Math.round(s / 3600) + 'h ago';
    return Math.round(s / 86400) + 'd ago';
  }

  /* The span of lines where the snapshot and the document differ, found by
     trimming the identical head and tail. Not a real diff — it will not pick
     apart two edits with untouched text between them — but it is linear,
     needs no allocation on documents of any size, and answers the question
     the preview is actually asking: whereabouts did this change? */
  function changedLines(oldText, newText) {
    var a = String(oldText).split('\n'), b = String(newText).split('\n');
    var s = 0, maxS = Math.min(a.length, b.length);
    while (s < maxS && a[s] === b[s]) s++;
    var e = 0, maxE = Math.min(a.length - s, b.length - s);
    while (e < maxE && a[a.length - 1 - e] === b[b.length - 1 - e]) e++;
    return { lines: a, from: s, to: a.length - e };
  }

  var HB_CONTEXT = 40;   /* unchanged lines kept either side of the change */

  function renderPreview() {
    var row = hb.rows[hb.sel];
    if (!row) { histPreview.textContent = ''; histSideMeta.textContent = ''; return; }

    var text = MM.histTextAt(row.i);
    if (text == null) { histPreview.textContent = ''; return; }
    hb.text = text;

    var d = changedLines(text, MM.docText());
    var lines = d.lines, from = d.from, to = d.to;

    histSideMeta.textContent = row.same
      ? 'Identical to the document as it stands'
      : (stamp(row.t) + ' · ' + row.words + ' words · ' + wordDelta(row.delta));

    /* A long document is mostly context nobody is reading. Keep a window
       either side of the change and say how much was skipped. */
    var head = Math.max(0, from - HB_CONTEXT);
    var tail = Math.min(lines.length, to + HB_CONTEXT);

    var out = document.createDocumentFragment();
    function put(cls, str) {
      var span = document.createElement('span');
      span.className = cls;
      span.textContent = str;
      out.appendChild(span);
    }
    function gap(n) {
      if (n <= 0) return;
      var span = document.createElement('span');
      span.className = 'hd-gap';
      span.textContent = '⋯ ' + n + (n === 1 ? ' unchanged line' : ' unchanged lines');
      out.appendChild(span);
    }

    if (row.same) {
      put('hd-same', lines.slice(0, Math.min(lines.length, HB_CONTEXT * 2)).join('\n'));
      if (lines.length > HB_CONTEXT * 2) gap(lines.length - HB_CONTEXT * 2);
    } else {
      /* No newline is added on either side of the changed block: hd-diff is
         display:block, so it breaks the line itself, and adding one as well
         left a blank line's worth of slack above and below it. */
      gap(head);
      if (from > head) put('hd-same', lines.slice(head, from).join('\n'));
      if (to > from) put('hd-diff', lines.slice(from, to).join('\n'));
      if (tail > to) put('hd-same', lines.slice(to, tail).join('\n'));
      gap(lines.length - tail);
    }

    histPreview.textContent = '';
    histPreview.appendChild(out);
    histPreview.scrollTop = 0;
  }

  /* Matched against what the row actually reads, so "5 aug", "16:2" and "2d"
     all find something without needing to know how the dates are stored. */
  function histRowLabel(r) { return (stamp(r.t) + ' ' + ago(r.t)).toLowerCase(); }

  function applyHistFilter() {
    var q = histFilter.value.trim().toLowerCase();
    hb.rows = !q ? hb.all.slice()
      : hb.all.filter(function (r) { return histRowLabel(r).indexOf(q) !== -1; });
    hb.sel = 0;
    renderHistList();
    renderPreview();
    syncHistButtons();
  }

  function renderHistList() {
    histListEl.textContent = '';
    if (!hb.rows.length) {
      var empty = document.createElement('div');
      empty.className = 'hs-empty';
      empty.textContent = hb.all.length ? 'Nothing matches' : 'No snapshots yet';
      histListEl.appendChild(empty);
      return;
    }
    hb.rows.forEach(function (r, i) {
      var row = document.createElement('div');
      row.className = 'hs' + (i === hb.sel ? ' sel' : '') + (r.same ? ' now' : '');
      row.dataset.i = i;
      row.setAttribute('role', 'option');
      row.setAttribute('aria-selected', i === hb.sel ? 'true' : 'false');

      var t = document.createElement('span');
      t.className = 'hs-t';
      t.textContent = stamp(r.t) + '  ·  ' + ago(r.t);

      var d = document.createElement('span');
      d.className = 'hs-d';
      d.textContent = r.same ? 'current' : (r.delta > 0 ? '+' + r.delta : String(r.delta));

      row.appendChild(t); row.appendChild(d);
      histListEl.appendChild(row);
    });
  }

  function syncHistButtons() {
    var row = hb.rows[hb.sel];
    histRestoreBtn.disabled = !row || row.same;
    histUndoBtn.disabled = !MM.histCanUndo();
    histHint.textContent = !hb.rows.length ? ''
      : row && row.same ? 'This is what the document says now'
      : '↑↓ to browse · ⏎ to restore · esc to close';
  }

  function selectHist(i) {
    if (!hb.rows.length) return;
    hb.sel = Math.max(0, Math.min(hb.rows.length - 1, i));
    renderHistList();
    renderPreview();
    syncHistButtons();
    var n = histListEl.querySelector('.hs.sel');
    if (n) n.scrollIntoView({ block: 'nearest' });
  }

  function openHistory() {
    /* Pin the present first, or the top of the list is however far back the
       last periodic snapshot happened to fall and the thing you are looking
       at is not in its own history. */
    MM.histSnapshot(true);
    hb.all = MM.histList();
    hb.rows = hb.all.slice();
    hb.sel = 0;
    hb.open = true;
    histFilter.value = '';

    var st = MM.histStats();
    histMeta.textContent = st.capped
      ? 'This document is too large to keep history for'
      : hb.all.length > 1
        ? (hb.all.length + ' snapshots over ' + humanSpan(st.span))
        : 'History starts now';

    renderHistList();
    renderPreview();
    syncHistButtons();
    histWrap.classList.add('open');
    /* Focus goes to the field, not the list. A focused div does not receive
       Escape in a WKWebView — AppKit takes it first — so every overlay in
       this app that closes on Escape does it from an editable field. The
       filter is worth having in its own right once a document has sixty
       snapshots, but this is why it holds the focus. */
    setTimeout(function () { histFilter.focus(); }, 30);
  }

  function closeHistory() {
    hb.open = false;
    histWrap.classList.remove('open');
    if (state.mode === 'split') el.src.focus();
  }

  function restoreSelected() {
    var row = hb.rows[hb.sel];
    if (!row || row.same) return;
    var r = MM.histRestoreAt(row.i);
    closeHistory();
    if (!r) { toast('That snapshot could not be read'); return; }
    if (r.same) { toast('Already as it was'); return; }
    toast('Restored to ' + stamp(r.t) + ' · ⌘Z or Undo restore');
  }

  /* All of it on the filter field, the same shape as the command palette:
     the field keeps the focus and drives the list beside it. */
  histFilter.addEventListener('input', applyHistFilter);
  histFilter.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') { e.preventDefault(); closeHistory(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); selectHist(hb.sel + 1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); selectHist(hb.sel - 1); }
    else if (e.key === 'Enter') { e.preventDefault(); restoreSelected(); }
  });
  histListEl.addEventListener('mousedown', function (e) {
    var n = e.target.closest('.hs'); if (!n) return;
    e.preventDefault();
    selectHist(parseInt(n.dataset.i, 10));
    histFilter.focus();      /* keep Escape working — see openHistory */
  });
  histListEl.addEventListener('dblclick', function (e) {
    if (e.target.closest('.hs')) restoreSelected();
  });
  histWrap.addEventListener('mousedown', function (e) { if (e.target === histWrap) closeHistory(); });
  $('#histClose').addEventListener('click', closeHistory);
  histRestoreBtn.addEventListener('click', restoreSelected);
  histUndoBtn.addEventListener('click', function () {
    closeHistory();
    if (MM.histUndoRestore()) toast('Restore undone');
  });

  /* A markdown link destination. An unescaped space or bracket ends the
     destination early, so `![](Screen Shot (1).png)` renders as literal text
     rather than an image. Angle brackets take everything up to the closing one,
     which covers spaces and parentheses; a filename containing < or > has to be
     percent-encoded instead, since there is no escape inside <…>. */
  function mdDestination(p) {
    if (/[<>]/.test(p)) return encodeURI(p).replace(/[()]/g, function (c) {
      return c === '(' ? '%28' : '%29';
    });
    return /[ ()]/.test(p) ? '<' + p + '>' : p;
  }

  function humanSpan(ms) {
    var m = Math.round(ms / 60e3);
    if (m < 60) return m + ' min';
    var h = Math.round(m / 60);
    if (h < 48) return h + ' hr';
    return Math.round(h / 24) + ' days';
  }

  /* ============================================================
     UNDO / REDO
     ============================================================ */
  /* ⌘Z is claimed by the native Edit menu before the web view ever sees the
     key, so both routes end up here rather than in WebKit's own undo. */
  function inPlainField() {
    var a = document.activeElement;
    return !!a && a.tagName === 'INPUT';
  }

  function doUndo() {
    /* the find and palette fields keep their own tiny histories */
    if (inPlainField()) { document.execCommand('undo'); return; }
    if (MM.undo()) return;
    if (MM.histCanUndo() && MM.histUndoRestore()) { toast('Restore undone'); return; }
    toast('Nothing to undo');
  }

  function doRedo() {
    if (inPlainField()) { document.execCommand('redo'); return; }
    if (!MM.redo()) toast('Nothing to redo');
  }

  /* ============================================================
     FIND & REPLACE
     ============================================================ */
  var find = $('#find'), findInput = $('#findInput'), replaceInput = $('#replaceInput'), findCount = $('#findCount');
  var findHL = $('#findHL');
  var fx = { matches: [], idx: -1, open: false };

  /* Why the highlighting is drawn by hand rather than left to the textarea's
     own selection: the find field keeps the keyboard focus the whole time the
     bar is open, so whatever is selected in the editor is an *inactive*
     selection, which WebKit does not paint. In split view the source textarea
     is transparent on top of #hl as well, so there was nothing to see at all.
     Both views therefore get their own match layer, independent of focus. */

  function computeMatches() {
    var q = findInput.value;
    fx.matches = [];
    if (!q) { findCount.textContent = '0/0'; return; }
    var ci = q === q.toLowerCase();
    var hay = ci ? state.text.toLowerCase() : state.text;
    var needle = ci ? q.toLowerCase() : q;
    var i = hay.indexOf(needle);
    while (i > -1 && fx.matches.length < 2000) { fx.matches.push(i); i = hay.indexOf(needle, i + Math.max(1, needle.length)); }
    if (fx.idx >= fx.matches.length) fx.idx = fx.matches.length - 1;
    findCount.textContent = (fx.matches.length ? (fx.idx + 1) + '/' : '0/') + fx.matches.length;
    paintFindHL();
  }

  /* ---- split view: a mirror <pre> under #hl, marks at the match offsets ---- */
  function paintFindHL() {
    if (!findHL) return;
    if (!fx.open || state.mode !== 'split' || !fx.matches.length || !findInput.value) {
      findHL.innerHTML = ''; return;
    }
    var t = state.text, len = findInput.value.length, out = '', prev = 0;
    for (var i = 0; i < fx.matches.length; i++) {
      var p = fx.matches[i];
      if (p < prev) continue;
      out += esc(t.slice(prev, p)) +
             '<mark' + (i === fx.idx ? ' class="cur"' : '') + '>' + esc(t.slice(p, p + len)) + '</mark>';
      prev = p + len;
    }
    /* the trailing newline keeps this layer's wrapped height identical to #hl's */
    findHL.innerHTML = out + esc(t.slice(prev)) + '\n';
  }

  /* ---- live view: marks woven into the rendered document ---- */
  var docMarks = [];

  function clearDocFind() {
    if (!docMarks.length) return;
    var parents = [];
    for (var i = 0; i < docMarks.length; i++) {
      var m = docMarks[i], p = m.parentNode;
      if (!p) continue;                       /* the block was re-rendered under us */
      p.replaceChild(document.createTextNode(m.textContent), m);
      if (parents.indexOf(p) === -1) parents.push(p);
    }
    for (var j = 0; j < parents.length; j++) parents[j].normalize();
    docMarks = [];
  }

  function textNodesIn(root) {
    var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: function (n) {
        if (!n.nodeValue) return NodeFilter.FILTER_REJECT;
        var p = n.parentNode;
        while (p && p !== root) {
          var tag = p.nodeName;
          if (tag === 'TEXTAREA' || tag === 'SCRIPT' || tag === 'STYLE')
            return NodeFilter.FILTER_REJECT;
          /* KaTeX keeps a shadow copy of the source in the DOM; marking inside
             it duplicates every hit and corrupts the maths on the next render */
          if (p.classList && (p.classList.contains('katex') || p.classList.contains('katex-display')))
            return NodeFilter.FILTER_REJECT;
          p = p.parentNode;
        }
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    var out = [], n;
    while ((n = walker.nextNode())) out.push(n);
    return out;
  }

  function paintDocFind() {
    clearDocFind();
    var q = findInput.value;
    if (!fx.open || !q || !fx.matches.length) return;
    var ci = q === q.toLowerCase();
    var needle = ci ? q.toLowerCase() : q;
    var nodes = textNodesIn(el.doc);
    for (var i = 0; i < nodes.length && docMarks.length < 2000; i++) {
      var node = nodes[i];
      var hay = ci ? node.nodeValue.toLowerCase() : node.nodeValue;
      var at = hay.indexOf(needle);
      while (at > -1 && docMarks.length < 2000) {
        var hit = node.splitText(at);
        node = hit.splitText(needle.length);
        var mk = document.createElement('mark');
        mk.className = 'fmark';
        mk.appendChild(document.createTextNode(hit.nodeValue));
        hit.parentNode.replaceChild(mk, hit);
        docMarks.push(mk);
        hay = ci ? node.nodeValue.toLowerCase() : node.nodeValue;
        at = hay.indexOf(needle);
      }
    }
  }

  /* The rendered text has had its markdown syntax stripped, so the nth hit in
     the source is not always the nth hit on screen. Narrowing to the block the
     source offset belongs to, then counting only within that block, keeps the
     two in step for everything except a match that lives inside markup. */
  function markCurrentDocHit() {
    if (!docMarks.length || fx.idx < 0) return null;
    var pos = fx.matches[fx.idx];
    var bi = MM.blockIndexForOffset(pos);
    var start = MM.blockStartOffsets()[bi] || 0;
    var ord = 0;
    for (var i = 0; i < fx.idx; i++) if (fx.matches[i] >= start) ord++;
    var node = el.doc.children[bi], inBlock = [];
    if (node) {
      for (var j = 0; j < docMarks.length; j++) if (node.contains(docMarks[j])) inBlock.push(docMarks[j]);
    }
    if (!inBlock.length) inBlock = docMarks, ord = fx.idx;
    var cur = inBlock[Math.min(ord, inBlock.length - 1)];
    if (cur) cur.classList.add('cur');
    return cur || node;
  }

  function revealMatch() {
    if (!fx.matches.length) { paintFindHL(); clearDocFind(); return; }
    var pos = fx.matches[fx.idx], len = findInput.value.length;
    findCount.textContent = (fx.idx + 1) + '/' + fx.matches.length;
    if (state.mode === 'split') {
      clearDocFind();
      paintFindHL();
      /* the selection is invisible while the find field holds focus, but it is
         still where Replace and the caret pick up when the bar closes */
      el.src.setSelectionRange(pos, pos + len);
      MM.markCurrentLine(); MM.updateCaretStatus();
      var ln = el.hl.children[state.text.slice(0, pos).split('\n').length - 1];
      if (ln) el.srcScroll.scrollTo({ top: Math.max(0, ln.offsetTop - el.srcScroll.clientHeight * 0.4), behavior: 'smooth' });
    } else {
      paintDocFind();
      var target = markCurrentDocHit();
      if (target && target.scrollIntoView) target.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
  }

  function findStep(dir) {
    computeMatches();
    if (!fx.matches.length) { paintFindHL(); clearDocFind(); return; }
    fx.idx = (fx.idx + dir + fx.matches.length) % fx.matches.length;
    revealMatch();
  }

  function openFind() {
    fx.open = true; find.classList.add('open');
    var ta = MM.activeTextarea();
    if (ta && ta.selectionStart !== ta.selectionEnd) {
      findInput.value = ta.value.slice(ta.selectionStart, ta.selectionEnd).split('\n')[0];
    }
    /* a block open for editing hides its rendered text behind a textarea, and
       there is nothing to mark inside one — put it back before searching */
    if (state.mode === 'live') MM.commitEditing(true);
    findInput.focus(); findInput.select();
    fx.idx = -1; computeMatches();
    if (fx.matches.length) { fx.idx = 0; revealMatch(); }
  }
  function closeFind() {
    fx.open = false; find.classList.remove('open');
    clearDocFind();
    paintFindHL();
    var pos = fx.idx >= 0 ? fx.matches[fx.idx] : -1, len = findInput.value.length;
    if (state.mode === 'split') {
      el.src.focus();
      if (pos >= 0) el.src.setSelectionRange(pos, pos + len);
    } else if (pos >= 0) {
      /* hand the caret to the block the writer was last looking at */
      var bi = MM.blockIndexForOffset(pos);
      var start = MM.blockStartOffsets()[bi] || 0;
      MM.editBlock(bi, pos - start, true);
    }
  }

  /* a stale match layer outlives a view switch, so drop the bar instead */
  var baseSetMode = MM.setMode;
  MM.setMode = function () {
    if (fx.open && arguments[0] !== state.mode) closeFind();
    return baseSetMode.apply(null, arguments);
  };
  $('#seg').addEventListener('mousedown', function () { if (fx.open) closeFind(); }, true);

  /* typing in the editor while the bar is open moves every offset under it */
  el.src.addEventListener('input', function () { if (fx.open) { computeMatches(); paintFindHL(); } });

  findInput.addEventListener('input', function () { fx.idx = -1; computeMatches(); if (fx.matches.length) { fx.idx = 0; revealMatch(); } else { paintFindHL(); clearDocFind(); } });
  findInput.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') { e.preventDefault(); findStep(e.shiftKey ? -1 : 1); }
    else if (e.key === 'Escape') { e.preventDefault(); closeFind(); }
  });
  replaceInput.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') { e.preventDefault(); replaceOne(); }
    else if (e.key === 'Escape') { e.preventDefault(); closeFind(); }
  });
  $('#findNext').addEventListener('click', function () { findStep(1); });
  $('#findPrev').addEventListener('click', function () { findStep(-1); });
  $('#findClose').addEventListener('click', closeFind);
  $('#replaceOne').addEventListener('click', replaceOne);
  $('#replaceAll').addEventListener('click', replaceAll);

  function replaceOne() {
    computeMatches();
    if (!fx.matches.length) return;
    if (fx.idx < 0) fx.idx = 0;
    var pos = fx.matches[fx.idx], len = findInput.value.length;
    MM.commitEditing(true);
    MM.undoMark(true);
    MM.setText(state.text.slice(0, pos) + replaceInput.value + state.text.slice(pos + len), { immediate: true });
    computeMatches();
    if (fx.matches.length) { fx.idx = fx.idx % fx.matches.length; revealMatch(); }
    else { fx.idx = -1; paintFindHL(); clearDocFind(); }
  }

  function replaceAll() {
    var q = findInput.value;
    if (!q) return;
    MM.commitEditing(true);
    var ci = q === q.toLowerCase();
    var out = '', rest = state.text, n = 0;
    while (true) {
      var hay = ci ? rest.toLowerCase() : rest;
      var i = hay.indexOf(ci ? q.toLowerCase() : q);
      if (i === -1) break;
      out += rest.slice(0, i) + replaceInput.value;
      rest = rest.slice(i + q.length); n++;
    }
    out += rest;
    MM.undoMark(true);
    MM.setText(out, { immediate: true });
    fx.idx = -1; computeMatches(); paintFindHL(); clearDocFind();
    toast(n ? 'Replaced ' + n : 'Nothing to replace');
  }

  /* ============================================================
     SELECTION FORMATTING BUBBLE

     Three actions are on show and the rest live behind the chevron. Which
     three is not fixed: every use is counted, and the top three by count take
     the front row. The counts start weighted towards bold, italic and link so
     the default holds until somebody genuinely reaches past it — one stray
     click on strikethrough should not rearrange the toolbar.
     ============================================================ */
  var ICON = {
    bold:   '<path d="M4.4 2.9h4.2a2.6 2.6 0 0 1 0 5.2H4.4zM4.4 8.1h4.9a2.75 2.75 0 0 1 0 5.5H4.4z"/>',
    italic: '<path d="M9.8 3h-2.6M8.8 13H6.2M9.1 3 6.9 13"/>',
    strike: '<path d="M2.6 8h10.8M11.4 4.8C10.8 3.7 9.6 3 8 3 6.1 3 4.9 3.9 4.9 5.3c0 1 .6 1.7 1.8 2.1M4.9 10.6c.4 1.4 1.6 2.4 3.4 2.4 2 0 3.2-1 3.2-2.5 0-.9-.4-1.6-1.2-2"/>',
    link:   '<path d="M6.6 9.4a2.6 2.6 0 0 0 3.9.3l2-2a2.65 2.65 0 0 0-3.75-3.75l-1.1 1.1M9.4 6.6a2.6 2.6 0 0 0-3.9-.3l-2 2a2.65 2.65 0 0 0 3.75 3.75l1.1-1.1"/>',
    code:   '<path d="M5.6 5 2.8 8l2.8 3M10.4 5l2.8 3-2.8 3"/>',
    quote:  '<path d="M3.2 4.4h9.6M3.2 8h9.6M3.2 11.6h6.2M1.2 3.6v8.8"/>',
    list:   '<path d="M5.8 4.3h7.2M5.8 8h7.2M5.8 11.7h7.2"/><circle cx="3" cy="4.3" r=".85" fill="currentColor" stroke="none"/><circle cx="3" cy="8" r=".85" fill="currentColor" stroke="none"/><circle cx="3" cy="11.7" r=".85" fill="currentColor" stroke="none"/>',
    more:   '<path d="M3.4 5.6 8 10.2l4.6-4.6"/>'
  };

  var ACTIONS = [
    { id: 'bold',   label: 'Bold',          icon: 'bold',   seed: 300, run: function () { MM.wrapSelection('**', '**', 'bold'); } },
    { id: 'italic', label: 'Italic',        icon: 'italic', seed: 200, run: function () { MM.wrapSelection('*', '*', 'italic'); } },
    { id: 'link',   label: 'Link',          icon: 'link',   seed: 100, run: function () { MM.insertLink(); } },
    { id: 'code',   label: 'Inline code',   icon: 'code',   seed: 0,   run: function () { MM.wrapSelection('`', '`', 'code'); } },
    { id: 'strike', label: 'Strikethrough', icon: 'strike', seed: 0,   run: function () { MM.wrapSelection('~~', '~~', 'text'); } },
    { id: 'h1',     label: 'Heading 1',     text: 'H1',     seed: 0,   run: function () { MM.setHeading(1); } },
    { id: 'h2',     label: 'Heading 2',     text: 'H2',     seed: 0,   run: function () { MM.setHeading(2); } },
    { id: 'h3',     label: 'Heading 3',     text: 'H3',     seed: 0,   run: function () { MM.setHeading(3); } },
    { id: 'quote',  label: 'Quote',         icon: 'quote',  seed: 0,   run: function () { MM.toggleLinePrefix('quote'); } },
    { id: 'list',   label: 'List',          icon: 'list',   seed: 0,   run: function () { MM.toggleLinePrefix('list'); } }
  ];

  var bubble = $('#bubble');
  var bbUse = {};
  var bbOrder = null;         // frozen for the life of one selection gesture
  var bbStale = true;
  var bbHideT = null;

  ACTIONS.forEach(function (a) { bbUse[a.id] = a.seed; });

  function bbPersist() {
    var slim = {};
    ACTIONS.forEach(function (a) { if (bbUse[a.id] !== a.seed) slim[a.id] = bbUse[a.id]; });
    send('pref', { key: 'fmtUse', value: JSON.stringify(slim) });
  }

  /* stable sort: equal counts keep their declared order, so the row only
     moves when usage really says so */
  function rankedActions() {
    return ACTIONS.map(function (a, i) { return { a: a, i: i }; })
      .sort(function (x, y) {
        var d = (bbUse[y.a.id] || 0) - (bbUse[x.a.id] || 0);
        return d || (x.i - y.i);
      })
      .map(function (x) { return x.a; });
  }

  function bbButton(a) {
    var inner = a.icon
      ? '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">' + ICON[a.icon] + '</svg>'
      : '<span>' + a.text + '</span>';
    return '<button type="button" class="bb" data-act="' + a.id + '" title="' + a.label + '">' + inner + '</button>';
  }

  function renderBubble() {
    var ranked = bbOrder || rankedActions();
    var front = ranked.slice(0, 3), rest = ranked.slice(3);
    bubble.innerHTML =
      front.map(bbButton).join('') +
      '<span class="bb-sep"></span>' +
      '<span class="bb-rest">' + rest.map(bbButton).join('') + '</span>' +
      '<button type="button" class="bb bb-more" title="More formatting">' +
      '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">' + ICON.more + '</svg></button>';
  }

  function placeBubble(r) {
    var GAP = 9;
    bubble.classList.remove('below');
    var w = bubble.offsetWidth, h = bubble.offsetHeight;
    var left = r.left + r.width / 2 - w / 2;
    left = Math.max(8, Math.min(window.innerWidth - w - 8, left));
    var top = r.top - h - GAP;
    if (top < 46) { top = r.top + r.height + GAP; bubble.classList.add('below'); }
    bubble.style.left = Math.round(left) + 'px';
    bubble.style.top = Math.round(top) + 'px';
  }

  function hideBubble() {
    if (!bubble.classList.contains('open')) return;
    bubble.classList.remove('open', 'expanded');
    bbStale = true;
  }

  function showBubble() {
    var ta = MM.activeTextarea();
    if (!ta || ta.selectionStart === ta.selectionEnd) { hideBubble(); return; }
    if (document.activeElement !== ta) { hideBubble(); return; }
    var r = MM.selectionRect(ta);
    if (!r) { hideBubble(); return; }
    /* the order is settled once per gesture, never mid-gesture, so a button
       can't slide out from under the pointer between aiming and clicking */
    if (bbStale || !bbOrder) { bbOrder = rankedActions(); renderBubble(); bbStale = false; }
    bubble.classList.add('open');
    placeBubble(r);
  }

  function queueBubble() {
    if (bbHideT) clearTimeout(bbHideT);
    bbHideT = setTimeout(showBubble, 20);
  }

  bubble.addEventListener('mousedown', function (e) { e.preventDefault(); });
  bubble.addEventListener('click', function (e) {
    var more = e.target.closest('.bb-more');
    if (more) {
      bubble.classList.toggle('expanded');
      var ta0 = MM.activeTextarea();
      if (ta0) { var r0 = MM.selectionRect(ta0); if (r0) placeBubble(r0); }
      return;
    }
    var btn = e.target.closest('.bb');
    if (!btn) return;
    var act = ACTIONS.find(function (a) { return a.id === btn.dataset.act; });
    if (!act) return;
    var ta = MM.activeTextarea();
    act.run();
    bbUse[act.id] = (bbUse[act.id] || 0) + 1;
    bbPersist();
    if (ta) ta.focus();
    /* block-level actions collapse the selection meaning — let the next
       selection decide whether the bubble comes back */
    queueBubble();
  });

  /* a new gesture is the moment to re-rank — never while the bubble is up.
     Presses on the bubble itself are the gesture continuing, not a new one. */
  document.addEventListener('mousedown', function (e) {
    if (!e.target.closest || !e.target.closest('#bubble')) bbStale = true;
  }, true);
  document.addEventListener('keydown', function () { bbStale = true; }, true);

  document.addEventListener('selectionchange', queueBubble);
  document.addEventListener('keyup', function (e) {
    if (e.key === 'Escape') { hideBubble(); return; }
    queueBubble();
  });
  document.addEventListener('mouseup', queueBubble);

  /* follow the selection rather than vanishing on it */
  function trackBubble() {
    if (!bubble.classList.contains('open')) return;
    var ta = MM.activeTextarea(); if (!ta) { hideBubble(); return; }
    var r = MM.selectionRect(ta); if (r) placeBubble(r);
  }
  el.srcScroll.addEventListener('scroll', trackBubble, { passive: true });
  el.prevPane.addEventListener('scroll', trackBubble, { passive: true });
  window.addEventListener('resize', hideBubble);

  /* ============================================================
     TABS

     Several documents open at once, and none of the others on screen unless
     you ask for them. The strip lives off the top of the window and comes
     down when the pointer reaches the edge, which is the same gesture zen
     already uses to bring the chrome back, so the two compose rather than
     compete.

     Who owns what: the shell owns the tabs, because it owns the files — the
     list, the order, the paths, the dirty flags, autosave and the watcher.
     This owns what each tab *looks* like and what it *feels* like to come
     back to, which is a session in app.js: text, undo, scroll, caret. Every
     message between the two carries the tab id and nothing else about the
     document, so neither side has to hold a copy of the other's half.

     Every user action here is a request, not a decision. Clicking a tab
     sends `tabSelect` and the strip switches immediately, because the swap is
     local and instant; closing one sends `tabClose` and nothing happens until
     the shell has decided whether the document needs saving first.
     ============================================================ */
  var tabbar = $('#tabbar'), tabsEl = $('#tabs'), tabAdd = $('#tabAdd'),
      tabRest = $('#tabRest');

  /* How far down the window still counts as the top edge, how long the
     pointer has to stay there, and how long the strip waits before it leaves
     again. The grace on the way out is the longer of the two on purpose: the
     cost of it lingering is nothing, and the cost of it snapping shut under a
     pointer on its way to a tab is a misclick on the document underneath. */
  var PEEK_BAND = 16, PEEK_IN = 110, PEEK_OUT = 260, PEEK_FLASH = 1600;

  var tabs = [{ id: 0, name: 'Untitled.md', dir: '', dirty: false }];
  var sessions = {};        /* id -> parked session, for every tab but the one on screen */
  var tabsPinned = false;   /* the pref: the strip stays out */
  var tabsOpen = false;
  var peekNative = false;   /* the shell's tracking area has the pointer up there */
  var peekLocal = false;    /* …and the page's own backstop, below the drag strip */
  var peekUntil = 0;        /* a flash after a keyboard switch, as a deadline */
  var openTimer = null, closeTimer = null, flashTimer = null;
  var drag = null, restSig = '', pendingRender = false;

  function byId(id) {
    for (var i = 0; i < tabs.length; i++) if (tabs[i].id === id) return tabs[i];
    return null;
  }
  function indexOfTab(id) {
    for (var i = 0; i < tabs.length; i++) if (tabs[i].id === id) return i;
    return -1;
  }

  /* ---------------- reveal ---------------- */

  function wantTabs() {
    return tabsPinned || peekNative || peekLocal || !!drag || Date.now() < peekUntil;
  }

  function scheduleTabs() {
    var want = wantTabs();
    clearTimeout(openTimer); clearTimeout(closeTimer);
    if (want === tabsOpen) return;
    if (want) openTimer = setTimeout(function () { setTabsOpen(true); }, tabsPinned ? 0 : PEEK_IN);
    else closeTimer = setTimeout(function () { setTabsOpen(false); }, PEEK_OUT);
  }

  function setTabsOpen(on) {
    if (on === tabsOpen) return;
    tabsOpen = on;
    el.body.classList.toggle('tabs-open', on);
    tabbar.setAttribute('aria-hidden', on ? 'false' : 'true');
    /* In split view the bar lives on the pane divider, which is the middle of
       the strip. It comes to the corner for as long as the strip is out, and
       posts its new x on the way, so the shell brings the real window buttons
       with it. */
    MM.positionBar(true);
    send('tabsOpen', { on: on });
    if (on) requestAnimationFrame(measureRest); else measureRest();
  }

  /* The empty run past the last tab is the drag handle, so the shell needs its
     rectangle to park a real drag region over it — WebKit has no app-region,
     and a web view cannot move its own window. */
  function measureRest() {
    var sig = '', x = 0, w = 0, h = 0;
    if (tabsOpen) {
      var r = tabRest.getBoundingClientRect();
      x = Math.round(r.left); w = Math.round(r.width); h = Math.round(r.height);
      sig = x + ':' + w + ':' + h;
    }
    if (sig === restSig) return;
    restSig = sig;
    send('tabDrag', { x: x, w: w, h: h });
  }

  /* Hold the strip open briefly after something that changed which tab is in
     front without the pointer being anywhere near it — a keyboard switch, or
     a document opening. Otherwise the tab you just moved to is the one thing
     you cannot see. */
  function flashTabs() {
    peekUntil = Date.now() + PEEK_FLASH;
    clearTimeout(flashTimer);
    flashTimer = setTimeout(scheduleTabs, PEEK_FLASH + 30);
    scheduleTabs();
  }

  /* The backstop for the shell's tracking area. It cannot see the top 8px —
     those belong to a native drag strip that takes the mouse before the page
     does — so on its own this would be a 8px trigger, which is why the shell
     drives the reveal and this only catches the rest of the band. */
  document.addEventListener('mousemove', function (e) {
    var band = tabsOpen ? tabbar.offsetHeight + 14 : PEEK_BAND;
    var on = e.clientY <= band;
    if (on === peekLocal) return;
    peekLocal = on;
    scheduleTabs();
  });

  /* ---------------- the strip ---------------- */

  var X_SVG = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" ' +
              'stroke-width="2" stroke-linecap="round"><path d="M4.5 4.5l7 7M11.5 4.5l-7 7"/></svg>';

  function renderTabs() {
    /* Not mid-drag. Rebuilding the nodes under a pointer that is holding one
       of them would leave the drag measuring a element that is no longer in
       the document, and the drop would go nowhere. Whatever arrived while the
       drag was running is picked up when it ends. */
    if (drag) { pendingRender = true; return; }
    pendingRender = false;
    tabsEl.textContent = '';
    tabs.forEach(function (t) {
      var node = document.createElement('div');
      node.className = 'tab' + (t.id === state.tabId ? ' on' : '') + (t.dirty ? ' dirty' : '');
      node.dataset.id = String(t.id);
      node.setAttribute('role', 'tab');
      node.setAttribute('aria-selected', t.id === state.tabId ? 'true' : 'false');
      node.title = t.dir ? t.dir + '/' + t.name : t.name;

      var name = document.createElement('span');
      name.className = 'name';
      name.textContent = t.name;
      node.appendChild(name);

      var dot = document.createElement('span');
      dot.className = 'dot';
      node.appendChild(dot);

      var x = document.createElement('button');
      x.type = 'button';
      x.className = 'x';
      x.setAttribute('aria-label', 'Close ' + t.name);
      x.innerHTML = X_SVG;
      node.appendChild(x);

      tabsEl.appendChild(node);
    });
    requestAnimationFrame(measureRest);
  }

  /* ---------------- switching ---------------- */

  /* Park what is on screen, put something else there. `seed` is a session
     handed in from outside — a document that has just arrived from disk —
     rather than one coming back from where it was left. */
  function swapTo(id, seed, opts) {
    var out = state.tabId;
    if (out === id && !seed) { renderTabs(); return; }

    /* Only park a tab the shell still has. The commonest reason for a swap is
       that the outgoing document was just closed, and keeping its session
       would be a leak holding the whole text of a file nobody has open. */
    if (out !== id && byId(out)) sessions[out] = MM.sessionCapture();

    var s = seed || sessions[id];
    if (!s) {
      var t = byId(id);
      s = MM.sessionBlank(t && t.name, t && t.dir);
    }
    delete sessions[id];                 /* it is on screen now, not parked */
    state.tabId = id;
    MM.sessionRestore(s, opts);
    docName.textContent = state.fileName;
    fx.idx = -1;                         /* the find cursor belonged to the old text */
    renderTabs();
  }

  function selectTab(id) {
    if (id === state.tabId || !byId(id)) return;
    swapTo(id);
    send('tabSelect', { id: id });
  }

  function stepTab(delta) {
    if (tabs.length < 2) return;
    var i = indexOfTab(state.tabId);
    if (i < 0) i = 0;
    var next = tabs[(i + delta + tabs.length) % tabs.length];
    flashTabs();
    selectTab(next.id);
  }

  /* ---------------- pointer ---------------- */

  tabsEl.addEventListener('pointerdown', function (e) {
    if (e.button !== 0 || drag) return;
    var node = e.target.closest && e.target.closest('.tab');
    if (!node) return;
    if (e.target.closest('.x')) return;      /* the close button owns its own click */

    var id = parseInt(node.dataset.id, 10);
    if (isNaN(id)) return;
    selectTab(id);

    /* Selecting rebuilds the strip, so the node the pointer went down on is
       no longer in the document. Take the live one instead — dragging the
       detached copy leaves every measurement below reading off a node with no
       position at all. */
    var live = tabsEl.querySelector('.tab[data-id="' + id + '"]');
    if (!live) return;
    var nodes = Array.prototype.slice.call(tabsEl.children);
    var from = nodes.indexOf(live);
    if (from < 0) return;

    drag = {
      id: id, node: live, nodes: nodes,
      rects: nodes.map(function (n) { return n.getBoundingClientRect(); }),
      from: from, to: from,
      startX: e.clientX, moved: false
    };
    try { tabsEl.setPointerCapture(e.pointerId); } catch (err) {}
  });

  /* The dragged tab is lifted visually only: its slot in the flow stays put
     and the others translate around it, so nothing reflows under the pointer
     and letting go is a single reorder rather than a settling animation. */
  function layoutDrag() {
    var shift = drag.rects[drag.from].width + 1;   /* +1 for the strip's gap */
    drag.nodes.forEach(function (n, i) {
      if (i === drag.from) return;
      var by = 0;
      if (drag.to < drag.from && i >= drag.to && i < drag.from) by = shift;
      else if (drag.to > drag.from && i > drag.from && i <= drag.to) by = -shift;
      n.classList.add('sliding');
      n.style.transform = by ? 'translateX(' + by + 'px)' : '';
    });
  }

  tabsEl.addEventListener('pointermove', function (e) {
    if (!drag) return;
    var dx = e.clientX - drag.startX;
    if (!drag.moved) {
      if (Math.abs(dx) < 4) return;         /* a click is not a drag */
      drag.moved = true;
      drag.node.classList.add('dragging');
    }
    drag.node.style.transform = 'translateX(' + dx + 'px)';

    /* Where it would land: the first tab on the left whose centre the dragged
       one has passed, or the last on the right. Inclusive at the boundary, so
       letting go exactly over a tab's centre lands on that tab rather than
       one short of it. */
    var mid = drag.rects[drag.from].left + drag.rects[drag.from].width / 2 + dx;
    var to = drag.from;
    for (var i = 0; i < drag.rects.length; i++) {
      var c = drag.rects[i].left + drag.rects[i].width / 2;
      if (i < drag.from && mid <= c) { to = i; break; }
      if (i > drag.from && mid >= c) { to = i; }
    }
    if (to !== drag.to) { drag.to = to; layoutDrag(); }
  });

  function endDrag() {
    if (!drag) return;
    var d = drag;
    drag = null;
    d.node.classList.remove('dragging');
    d.nodes.forEach(function (n) { n.classList.remove('sliding'); n.style.transform = ''; });
    if (pendingRender && !(d.moved && d.to !== d.from)) renderTabs();
    if (d.moved && d.to !== d.from) {
      /* Reordered here as well as sent, so the strip does not sit in the old
         order waiting for the round trip. The shell's setTabs is the
         authority and will correct this if it disagrees. */
      tabs.splice(d.to, 0, tabs.splice(d.from, 1)[0]);
      renderTabs();
      send('tabMove', { id: d.id, to: d.to });
    }
    scheduleTabs();
  }
  tabsEl.addEventListener('pointerup', endDrag);
  tabsEl.addEventListener('pointercancel', endDrag);

  tabsEl.addEventListener('click', function (e) {
    var node = e.target.closest && e.target.closest('.tab');
    if (!node) return;
    var id = parseInt(node.dataset.id, 10);
    if (isNaN(id)) return;

    if (e.target.closest('.x')) { e.preventDefault(); send('tabClose', { id: id }); return; }

    /* Normally a no-op: pointerdown has already selected, because a tab that
       waits for the button to come back up feels slow and because a drag has
       to start on the tab it is going to move. This is for every click that
       arrives without one — assistive technology, and anything synthesising
       events rather than moving a mouse. */
    selectTab(id);
  });

  /* Middle-click closes, the way it does everywhere else with tabs. */
  tabsEl.addEventListener('auxclick', function (e) {
    if (e.button !== 1) return;
    var node = e.target.closest && e.target.closest('.tab');
    if (!node) return;
    e.preventDefault();
    var id = parseInt(node.dataset.id, 10);
    if (!isNaN(id)) send('tabClose', { id: id });
  });

  tabAdd.addEventListener('click', function () { send('tabNew', {}); });

  function setTabsPinned(on, quiet) {
    tabsPinned = !!on;
    scheduleTabs();
    if (quiet) return;
    send('pref', { key: 'tabsPin', value: tabsPinned ? '1' : '0' });
    toast(tabsPinned ? 'Tabs stay showing' : 'Tabs hide again');
  }

  /* A tab's dirty dot should appear as you type, not a round trip later. */
  MM.onDirty = function (v) {
    var t = byId(state.tabId);
    if (!t || t.dirty === v) return;
    t.dirty = v;
    var node = tabsEl.querySelector('.tab[data-id="' + state.tabId + '"]');
    if (node) node.classList.toggle('dirty', v);
  };

  window.addEventListener('resize', measureRest);
  renderTabs();

  /* ============================================================
     KEYBOARD
     ============================================================ */
  document.addEventListener('keydown', function (e) {
    var meta = e.metaKey || e.ctrlKey;

    if (e.key === 'Escape') {
      if (pk.open) return;
      /* Above find, because the browser is a modal sheet over everything. */
      if (hb.open) { e.preventDefault(); closeHistory(); return; }
      if (fx.open) { closeFind(); return; }
      if (themePop.classList.contains('open')) { themePop.classList.remove('open'); return; }
      if (help.classList.contains('open')) { closeHelp(); return; }
      if (state.zen) { setZen(false); return; }
      return;
    }
    if (e.ctrlKey && e.altKey && e.code === 'KeyZ') { e.preventDefault(); setZen(!state.zen); return; }
    if (e.ctrlKey && e.altKey && e.code === 'KeyS') { e.preventDefault(); setStyleCheck(!state.styleCheck); return; }
    if (e.ctrlKey && e.altKey && e.code === 'KeyD') {
      e.preventDefault();
      setFocusLevel(state.focusLevel === 'sentence' ? 'paragraph' : 'sentence');
      return;
    }
    if (!meta) return;

    var k = e.key.toLowerCase();
    /* ⌘P belongs to Print, so it is deliberately not handled here — the native
       File menu claims it before the web view sees the key. */
    if (k === 'k' && !e.shiftKey) { e.preventDefault(); pk.open ? closePicker() : openPalette(); }
    else if (k === 'k' && e.shiftKey) { e.preventDefault(); MM.insertLink(); }
    else if (k === 'r' && !e.shiftKey) { e.preventDefault(); openHeadings(); }
    else if (k === 'f' && e.shiftKey) { e.preventDefault(); setZen(!state.zen); }
    else if (k === 'f') { e.preventDefault(); fx.open ? closeFind() : openFind(); }
    else if (k === 'g') { e.preventDefault(); findStep(e.shiftKey ? -1 : 1); }
    else if (k === 'd' && e.shiftKey) { e.preventDefault(); setFocus(!state.focus); }
    else if (k === 't' && e.shiftKey) { e.preventDefault(); setTypewriter(!state.typewriter); }
    /* ⌥C produces 'ç' on a Mac layout, so matching on e.key never fired here
       and this only ever worked from the Edit menu. e.code is the physical
       key and is layout-independent. */
    else if (e.altKey && (k === 'c' || e.code === 'KeyC')) { e.preventDefault(); MM.copyRich(); }
    else if (k === 'b') { e.preventDefault(); MM.wrapSelection('**', '**', 'bold'); }
    else if (k === 'i') { e.preventDefault(); MM.wrapSelection('*', '*', 'italic'); }
    else if (k === 'e') { e.preventDefault(); MM.wrapSelection('`', '`', 'code'); }
    else if (k === 'm' && e.shiftKey) { e.preventDefault(); MM.setMode(state.mode === 'split' ? 'live' : 'split'); }
    /* Tab navigation. ⌃⇥ and ⌃⇧⇥ are in the Window menu, which claims them
       before the page ever sees them; these are the other pair everything
       with tabs also answers to. Matched on e.code, because shifted brackets
       are '}' and '{' and e.key would never be ']' here. */
    else if (e.shiftKey && e.code === 'BracketRight') { e.preventDefault(); stepTab(1); }
    else if (e.shiftKey && e.code === 'BracketLeft') { e.preventDefault(); stepTab(-1); }
    else if (k === 'l' && e.shiftKey) { e.preventDefault(); themePop.classList.toggle('open'); }
    else if (k === 'h' && e.shiftKey) {
      e.preventDefault();
      if (pk.open) closePicker();
      hb.open ? closeHistory() : openHistory();
    }
    else if (k === 'z' && !e.shiftKey) { e.preventDefault(); doUndo(); }
    else if ((k === 'z' && e.shiftKey) || (k === 'y' && !e.shiftKey)) { e.preventDefault(); doRedo(); }
    else if (k === '/') { e.preventDefault(); toggleHelp(); }
    else if (k === '1') { e.preventDefault(); MM.setMode('split'); }
    else if (k === '2') { e.preventDefault(); MM.setMode('live'); }
    /* text size. '=' is the unshifted key on the '+' cap, and the numeric
       keypad reports 'Add'/'Subtract', so accept the lot. */
    else if (k === '=' || k === '+' || e.code === 'NumpadAdd') { e.preventDefault(); stepSize(1); }
    else if (k === '-' || k === '_' || e.code === 'NumpadSubtract') { e.preventDefault(); stepSize(-1); }
    else if (k === '0') { e.preventDefault(); setSize(SIZE_DEFAULT); }
  });

  /* ============================================================
     NATIVE API
     ============================================================ */
  window.App = {
    /* A document arriving from disk. The fourth argument names the tab it
       belongs to; without one it replaces whatever is on screen, which is
       what this call meant before there were tabs and what it still means to
       a shell that never sends setTabs.

       Naming a tab that is not the one in front parks the document there
       instead of showing it — that is how a session is restored around
       whichever document was in front, and how a file opened into a new tab
       arrives with its text already waiting rather than flashing empty while
       the two messages cross.

       All the pinning and banking that used to be spelled out here now lives
       in sessionRestore, because a tab switch has to do exactly the same
       things in exactly the same order, and the two drifting apart is how
       history ends up filed under the wrong document. */
    loadDoc: function (text, name, dir, id) {
      var tid = (id == null) ? state.tabId : (id | 0);
      var seed = MM.sessionBlank(name, dir, text);
      if (tid === state.tabId) { swapTo(tid, seed, { fresh: true }); return; }
      sessions[tid] = seed;
      renderTabs();
    },

    /* The whole tab list, whenever the shell changes it: opened, closed,
       renamed, reordered, saved. The shell is the authority — this reconciles
       against it rather than merging with it, so the two cannot drift. */
    setTabs: function (list) {
      list = Array.isArray(list) ? list : [];
      var active = state.tabId;
      tabs = list.map(function (t) {
        if (t && t.active) active = t.id | 0;
        return {
          id: t.id | 0,
          name: (t && t.name) || 'Untitled.md',
          dir: (t && t.dir) || '',
          dirty: !!(t && t.dirty)
        };
      });
      if (!tabs.length) tabs = [{ id: active, name: state.fileName, dir: state.docDir, dirty: state.dirty }];

      /* Sessions for tabs that have gone. Dropped before the swap below, so
         that a swap away from a tab the shell has just closed does not park
         the whole text of a file nobody has open any more. */
      var live = {};
      tabs.forEach(function (t) { live[t.id] = 1; });
      Object.keys(sessions).forEach(function (k) { if (!live[k]) delete sessions[k]; });

      /* Names and folders move under parked sessions: Save As and Rename both
         land here, and a parked session carrying the old name would file its
         next history snapshot under a document that no longer exists. */
      tabs.forEach(function (t) {
        var s = sessions[t.id];
        if (!s) return;
        s.fileName = t.name; s.docDir = t.dir; s.dirty = t.dirty;
      });

      /* Adoption. Before the shell has said anything the page is showing its
         welcome document under a placeholder id of its own. The first setTabs
         replaces that id with a real one, and blanking the screen to do it
         would throw the welcome document away — which is precisely what the
         shell means to keep when it has nothing to restore. */
      if (active !== state.tabId && !sessions[active] && !byId(state.tabId)) {
        var adopted = MM.sessionCapture();
        var t0 = byId(active);
        if (t0) { adopted.fileName = t0.name; adopted.docDir = t0.dir; adopted.dirty = t0.dirty; }
        sessions[active] = adopted;
      }

      if (active !== state.tabId) swapTo(active);
      else {
        var mine = byId(state.tabId);
        if (mine && mine.name !== state.fileName) {
          state.fileName = mine.name;
          state.docDir = mine.dir;
          docName.textContent = mine.name;
        }
        renderTabs();
      }
    },

    /* The shell's tracking area, reporting whether the pointer is in the band
       along the top of the window. It has to come from there: the top 8px are
       a real AppKit drag strip and the page never sees a pointer in them. */
    setPeek: function (on) { peekNative = !!on; scheduleTabs(); },
    /* What gets written to disk. It has to be the document with the open
       block's own span replaced — rebuilding it from the block list would
       flatten every blank-line run in the file, and autosave would then
       commit that to the writer's file a second after they typed. */
    /* With an id, the text of any open tab — autosave runs against every
       dirty document, not only the one on screen. An unknown id answers null
       rather than '': every caller writes what it gets straight to disk, and
       an empty string is a legitimate document where a missing tab is not an
       answer at all. */
    getText: function (id) {
      if (id == null || (id | 0) === state.tabId) return MM.docText();
      var s = sessions[id | 0];
      return s ? s.text : null;
    },
    /* A block open for editing is a textarea, and textareas do not print.
       The shell calls this and waits a beat before paginating. */
    beforePrint: function () { MM.commitEditing(true); },
    setRecents: function (list) { recents = Array.isArray(list) ? list : []; },
    /* Commit first, like beforePrint. state.blocks still holds the pre-edit
       text while a block is open in live view, so Export as HTML silently
       left out whatever was being typed at the moment it ran. */
    getHTML: function () {
      MM.commitEditing(true);
      return state.blocks.map(function (b, i) { return MM.md(b, i); }).join('\n');
    },
    setSaved: function (name, dir, id) {
      var tid = (id == null) ? state.tabId : (id | 0);
      var t = byId(tid);
      if (t) { t.dirty = false; if (name) t.name = name; if (dir != null) t.dir = dir; }

      if (tid !== state.tabId) {
        var s = sessions[tid];
        if (s) {
          s.dirty = false; s.savedAt = Date.now();
          if (name) s.fileName = name;
          if (dir != null) s.docDir = dir;
        }
        renderTabs();
        return;
      }

      MM.markDirty(false);
      state.savedAt = Date.now();
      if (dir) state.docDir = dir;
      if (name) { state.fileName = name; $('.doc-title .name').textContent = name; }
      MM.updateStatus();
      MM.histSnapshot(true);
      renderTabs();
      toast('Saved');
    },
    /* The shell has counted enough consecutive autosave failures on this tab
       to be sure the file has stopped being written, or has just written it
       again and is taking that back. `why` is the system's own words, or null
       to clear. The status bar says so rather than a sheet: an unprompted
       write must not be able to take the keyboard away mid-sentence, which is
       the whole reason the autosave path is silent in the first place. */
    saveTrouble: function (id, why) {
      var tid = (id == null) ? state.tabId : (id | 0);
      if (tid !== state.tabId) {
        var s = sessions[tid];
        if (s) s.saveTrouble = why || null;
        return;
      }
      state.saveTrouble = why || null;
      MM.updateStatus();
      if (why) toast('Not saving — ' + why);
    },
    autoSaved: function (id) {
      var tid = (id == null) ? state.tabId : (id | 0);
      var at = byId(tid);
      if (at) at.dirty = false;
      if (tid !== state.tabId) {
        var bs = sessions[tid];
        if (bs) { bs.dirty = false; bs.savedAt = Date.now(); }
        renderTabs();
        return;
      }
      MM.markDirty(false); state.savedAt = Date.now(); MM.updateStatus(); renderTabs();
      /* Unforced, deliberately. Autosave fires a second after the last
         keystroke, so forcing here made every typing pause take a snapshot and
         serialise the whole store — the 20s throttle existed and autosave was
         walking straight past it. A snapshot on the interval is what history
         is for; this is just a file write. */
      MM.histSnapshot();
    },
    externalChange: function (text, id) {
      var tid = (id == null) ? state.tabId : (id | 0);
      if (tid !== state.tabId) {
        /* A background document changed underneath us. Its undo history
           described a text that is no longer on disk, so it goes: walking
           back into edits that were never in this file is worse than having
           nothing to walk back into. */
        var s = sessions[tid];
        if (s) {
          s.text = String(text == null ? '' : text);
          s.dirty = false; s.undo = []; s.redo = [];
          s.scrollSrc = 0; s.scrollPrev = 0; s.sel = null;
        }
        var bt = byId(tid);
        if (bt) bt.dirty = false;
        renderTabs();
        return;
      }
      var sp = el.prevPane.scrollTop, ss = el.srcScroll.scrollTop;
      MM.commitEditing(true);
      MM.setText(text, { immediate: true, markDirty: false });
      MM.markDirty(false);
      el.prevPane.scrollTop = sp; el.srcScroll.scrollTop = ss;
      toast('Reloaded from disk');
    },
    renamed: function (name, id) {
      var tid = (id == null) ? state.tabId : (id | 0);
      var t = byId(tid);
      if (t) t.name = name;
      if (tid === state.tabId) {
        state.fileName = name;
        docName.textContent = name;
      } else if (sessions[tid]) {
        sessions[tid].fileName = name;
      }
      renderTabs();
      toast('Renamed');
    },
    setFullscreen: function (on) {
      el.body.classList.toggle('no-titlebar', !!on);
      requestAnimationFrame(function () { MM.movePill(false); MM.autosizeSrc(); });
    },
    /* One or more images have been copied in beside the document. `at` is where
       a drop landed, in CSS pixels, or null when there was no pointer (paste,
       or File ▸ Insert Image…). */
    insertImages: function (paths, at) {
      if (!paths || !paths.length) return;

      /* pasteTarget is only meaningful for the paste it was set for, and the
         native side has several paths that never call back — a cancelled Save
         As, a failed write — each of which leaves it set. Honour it only when
         nothing better was named, and only while its node is still in the
         document: Save As blurs the open block, which commits and re-renders,
         detaching the very textarea being held here. Writing into a detached
         node put the file on disk, left no link, and marked the document dirty,
         with nothing on screen to show for it. */
      var ta = null;
      if (!at && state.pasteTarget && state.pasteTarget.isConnected) ta = state.pasteTarget;
      state.pasteTarget = null;
      if (!ta) ta = MM.textareaForInsert(at);
      if (!ta || !ta.isConnected) { toast('Could not place the image'); return; }

      /* An alt text placeholder rather than an empty one, and selected, so it
         can be typed straight over — the same move insertLink makes with its
         label. `![](file.png)` asks nothing of the writer and gets nothing,
         and every exported page and every PDF then carries an unlabelled
         image. Somebody who does not want alt text still only has to press
         Delete once, which is a fair trade for the ones who do. */
      var ALT = 'alt';
      var md = paths.map(function (p) { return '![' + ALT + '](' + mdDestination(p) + ')'; }).join('\n\n');
      /* And separated from whatever is already there, or the image is pulled
         into the end of that paragraph as an inline run. */
      var before = ta.value.slice(0, ta.selectionStart);
      var lead = '';
      if (before && !/\n\s*\n$/.test(before)) lead = /\n$/.test(before) ? '\n' : '\n\n';
      md = lead + md;

      ta.focus();
      /* The first one's alt. With several images only one can hold the caret,
         and the first is the one the eye is already on. */
      var altAt = ta.selectionStart + lead.length + 2;
      MM.replaceRange(ta, ta.selectionStart, ta.selectionEnd, md, altAt, altAt + ALT.length);
      toast(paths.length > 1 ? paths.length + ' images added' : 'Image added');
    },
    /* Kept for the original single-image bridge contract. */
    insertImage: function (relPath) { window.App.insertImages([relPath], null); },
    /* Called just before something that will steal the focus, so the caret can
       be put back afterwards. */
    pinInsertPoint: function () { MM.pinInsertPoint(); },
    setSystemTheme: function (t) { theme.systemDark = (t === 'dark'); revealThemeSystem(); },
    /* Which of the wikilinks in the document point at a file that is actually
       there, as { name: true|false }. One answer per batch the page asked
       about, not one per link and not one round trip per link. */
    setWikiTargets: function (map) { MM.setWikiTargets(map); },
    /* A wikilink has just created the file it named, so every cached answer
       about this folder is one render out of date. */
    forgetWikiTargets: function () { MM.forgetWikiTargets(); },
    /* The version history store, read back from its sidecar file at launch.
       Separate from setPrefs because it is a document store, not a setting:
       it is large, it arrives on its own schedule, and a failure to parse it
       must not take the window's appearance down with it. */
    setHistory: function (raw) { MM.histLoad(raw); },
    /* Pulled by the shell on quit and on losing focus, when there is no time to
       wait for the idle sweep. Pins the present and returns the store, or null
       if nothing has changed since the last write — so an app-switch on an
       untouched document costs nothing. */
    histCommit: function () { return MM.histCommit(); },
    /* The writer's own stylesheet, from
       ~/Library/Application Support/minimark/user.css. It goes in one <style>
       at the very end of <head>, which is after styles.css and after the
       theme block, so a plain selector of the same specificity wins and
       nobody has to reach for !important to change a colour.

       Replaced wholesale rather than appended: the shell re-sends this on
       every activation, and appending would stack a copy per switch back
       until the head was full of dead rules. */
    setUserCSS: function (css) {
        var node = document.getElementById('userCSS');
        if (!css) { if (node) node.parentNode.removeChild(node); return; }
        if (!node) {
          node = document.createElement('style');
          node.id = 'userCSS';
          document.head.appendChild(node);
        }
        node.textContent = css;
      },
    /* What the document in front is encoded as, or '' for UTF-8. The shell
       sends the empty string rather than "UTF-8" because every file anybody
       opens is UTF-8 and a status bar that says so all day says nothing; the
       one that is Latin-1 is the one worth a word about, before a page has
       been typed into it. */
    setEncoding: function (label) {
        var node = document.getElementById('stEnc');
        if (!node) return;
        node.textContent = label || '';
        node.hidden = !label;
        node.title = label ? 'This file is not UTF-8. It is saved back in the encoding it '
                           + 'arrived in, and promoted to UTF-8 only if you type something '
                           + 'that encoding cannot hold.' : '';
      },
    setPrefs: function (p) {
      p = p || {};
      if (p.themeAuto != null) theme.auto = p.themeAuto === '1';
      if (p.theme) theme.manual = p.theme;
      if (p.themeLight) theme.light = p.themeLight;
      if (p.themeDark) theme.dark = p.themeDark;
      if (p.font) theme.font = p.font;
      if (p.size != null && p.size !== '') {
        var si = parseInt(p.size, 10);
        if (!isNaN(si)) theme.size = Math.max(0, Math.min(SIZES.length - 1, si));
      }
      if (p.fmtUse) {
        try {
          var used = JSON.parse(p.fmtUse);
          Object.keys(used).forEach(function (id) {
            if (bbUse[id] != null) bbUse[id] = used[id];
          });
        } catch (err) {}
      }
      /* history no longer arrives with the prefs — it has its own store and
         its own entry point, App.setHistory */
      if (p.tabsPin === '1') setTabsPinned(true, true);
      if (p.zen === '1') setZenSilent(true);
      if (p.focusLevel) state.focusLevel = p.focusLevel === 'sentence' ? 'sentence' : 'paragraph';
      if (p.focus === '1') { state.focus = true; el.body.classList.add('focus'); }
      applyFocusLevel();
      if (p.typewriter === '1') { state.typewriter = true; twBtn.classList.add('on'); }
      if (p.styleCheck === '1') setStyleCheck(true, true);
      if (p.mode && p.mode !== state.mode) MM.setMode(p.mode, { animate: false });
      applyTheme(); MM.movePill(false);
      if (p.scroll) {
        var r = parseInt(p.scroll, 10) / 1000;
        setTimeout(function () {
          var h = el.prevPane.scrollHeight - el.prevPane.clientHeight;
          /* restore the preview and let the sync place the source to match */
          if (h > 4) el.prevPane.scrollTop = h * r;
        }, 260);
      }
    },
    command: function (name) {
      var map = {
        toggleMode: function () { MM.setMode(state.mode === 'split' ? 'live' : 'split'); },
        split: function () { MM.setMode('split'); },
        live: function () { MM.setMode('live'); },
        zen: function () { setZen(!state.zen); },
        focus: function () { setFocus(!state.focus); },
        focusParagraph: function () { setFocusLevel('paragraph'); },
        focusSentence: function () { setFocusLevel('sentence'); },
        typewriter: function () { setTypewriter(!state.typewriter); },
        styleCheck: function () { setStyleCheck(!state.styleCheck); },
        themes: function () { themePop.classList.toggle('open'); },
        palette: openPalette,
        headings: openHeadings,
        undo: doUndo,
        redo: doRedo,
        find: openFind,
        findNext: function () { findStep(1); },
        findPrev: function () { findStep(-1); },
        help: toggleHelp,
        /* the Edit menu lives in the native shell; these are the names it
           should send for the restore items */
        history: openHistory,
        restoreUndo: function () { if (MM.histUndoRestore()) toast('Restore undone'); },
        restoreOldest: function () { doRestore(null, 'the oldest snapshot'); },
        bigger: function () { stepSize(1); },
        smaller: function () { stepSize(-1); },
        resetSize: function () { setSize(SIZE_DEFAULT); },
        bold: function () { MM.wrapSelection('**', '**', 'bold'); },
        italic: function () { MM.wrapSelection('*', '*', 'italic'); },
        code: function () { MM.wrapSelection('`', '`', 'code'); },
        strike: function () { MM.wrapSelection('~~', '~~', 'text'); },
        link: MM.insertLink,
        copyRich: MM.copyRich,
        /* Tabs. Opening and closing belong to the shell — it owns the files
           and the "save this first?" sheet — so those are not here. What is
           here is everything that only moves the strip around. */
        nextTab: function () { stepTab(1); },
        prevTab: function () { stepTab(-1); },
        showTabs: flashTabs,
        toggleTabs: function () { setTabsPinned(!tabsPinned); }
      };
      HIST_STEPS.forEach(function (s) {
        map['restore' + s.id] = function () { doRestore(s.ms, s.label); };
      });
      /* hasOwnProperty, not a truthy lookup: `name` crosses the bridge from
         the shell, and a bare lookup finds 'constructor', 'toString' and the
         rest of Object.prototype and calls them. */
      if (Object.prototype.hasOwnProperty.call(map, name)) map[name]();
    },
    toast: toast
  };

  /* Restores zen at launch without writing the pref back. Everything setZen
     does apart from that has to happen here too: skipping resetZenReveal left
     a stale reveal latched, so the chrome stayed on screen through zen, and
     skipping the button state and the re-layout brought the session up with
     an unlit toggle over a bar that had never been repositioned. */
  function setZenSilent(on) {
    state.zen = on;
    el.body.classList.toggle('zen', on);
    resetZenReveal();
    var btn = $('#zenBtn');
    if (btn) btn.classList.toggle('on', on);
    send('zen', { on: on });
    requestAnimationFrame(function () {
      MM.autosizeSrc(); MM.movePill(false); MM.positionBar(false);
    });
  }

  /* persist mode toggles */
  var _setZen = setZen;
  setZen = function (on) { _setZen(on); send('pref', { key: 'zen', value: on ? '1' : '0' }); };
  var _setFocus = setFocus;
  setFocus = function (on) { _setFocus(on); send('pref', { key: 'focus', value: on ? '1' : '0' }); };
  var _setTw = setTypewriter;
  setTypewriter = function (on) { _setTw(on); send('pref', { key: 'typewriter', value: on ? '1' : '0' }); };

  /* ============================================================
     BOOT
     ============================================================ */
  var WELCOME = [
    '# minimark',
    '',
    'A quiet place to write markdown. Two ways to work:',
    '',
    '- **Split** puts raw markdown on the left, rendered on the right',
    '- **Live** is one surface. Click any paragraph to reveal its markdown',
    '',
    'Switch with the Split / Live control in the bottom bar, or `⌘⇧M`.',
    '',
    '## Getting around',
    '',
    'Press `⌘K` for the command palette. Everything lives in there, so nothing',
    'needs to live on the toolbar.',
    '',
    '| Key | Does |',
    '| --- | --- |',
    '| ⌘K | Command palette |',
    '| ⌘R | Jump to a heading |',
    '| ⌘F | Find and replace |',
    '| ⌃⌥Z | Zen mode |',
    '| ⌘⇧D | Focus mode |',
    '| ⌘⇧T | Typewriter scrolling |',
    '',
    '## Writing',
    '',
    'Click the **?** at the bottom right for the full syntax reference. Paste a web',
    'page and it arrives as clean markdown. Paste an image and it is saved beside',
    'your file.',
    '',
    'Click the filename in the middle of the bottom bar to rename it. The gear at',
    'the far left of that bar holds six themes and five typefaces.',
    '',
    '> Lists continue themselves on Enter. Tab nests them, and tidies a table',
    '> into aligned columns.',
    '',
    'Documents save themselves a second after you stop typing, and reload if',
    'something else changes the file.',
    '',
    '- [x] Look good',
    '- [ ] Write something',
    '',
    '---',
    '',
    'Made for Franco.'
  ].join('\n');

  buildHelp();
  renderThemePop();
  MM.setText(WELCOME, { immediate: true, markDirty: false });
  el.src.setSelectionRange(0, 0);
  el.body.dataset.mode = 'split';
  MM.movePill(false);
  MM.positionBar(false);
  applyTheme();
  MM.updateStatus();
  requestAnimationFrame(function () { MM.movePill(false); MM.positionBar(false); MM.autosizeSrc(); });
  window.addEventListener('resize', function () {
    MM.movePill(false); MM.positionBar(false); MM.autosizeSrc();
  });
  send('ready', {});
})();
