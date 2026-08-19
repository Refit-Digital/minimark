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

  function pickTheme(id) {
    var t = THEMES.find(function (x) { return x.id === id; });
    if (!t) return;
    theme.auto = false;
    theme.manual = id;
    if (t.kind === 'light') theme.light = id; else theme.dark = id;
    persistTheme();
    applyTheme();
    toast(t.name);
  }

  function setAuto(on) {
    theme.auto = on;
    persistTheme();
    applyTheme();
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
    if (row.dataset.auto) setAuto(!theme.auto);
    else if (row.dataset.font) pickFont(row.dataset.font);
    else pickTheme(row.dataset.theme);
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
    mq.addEventListener('change', function (e) { theme.systemDark = e.matches; applyTheme(); });
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
    MM.markCurrentLine(); MM.markCurrentBlock();
    toast(on ? 'Focus mode' : 'Focus off');
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

  MM.onDocRendered = buildScrub;
  MM.onPreviewScroll = function () {
    var ticks = scrub.querySelectorAll('.tick');
    if (!ticks.length) return;
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
    loadDoc: function (text, name, dir) {
      MM.commitEditing(true);
      /* Pin and bank the outgoing document while its key is still the current
         one. Everything below changes docDir and fileName, which is what
         histKey is built from, so a snapshot taken after this point would file
         the old document's last edits under the new document's name. */
      MM.histSnapshot(true);
      MM.histFlush();
      state.docDir = dir || '';
      MM.setText(text, { immediate: true, markDirty: false });
      MM.markDirty(false);
      state.fileName = name || 'Untitled.md';
      $('.doc-title .name').textContent = state.fileName;
      MM.invalidateAnchors();
      MM.setScroll('prev', 0); MM.setScroll('src', 0);
      if (state.mode === 'split') { el.src.focus(); el.src.setSelectionRange(0, 0); }
      MM.staggerBlocks(); MM.updateStatus();
      /* the file as it arrived is the baseline for this document's history */
      MM.histSnapshot(true);
      MM.undoReset();
      fx.idx = -1;
    },
    /* What gets written to disk. It has to be the document with the open
       block's own span replaced — rebuilding it from the block list would
       flatten every blank-line run in the file, and autosave would then
       commit that to the writer's file a second after they typed. */
    getText: function () { return MM.docText(); },
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
    setSaved: function (name, dir) {
      MM.markDirty(false);
      state.savedAt = Date.now();
      if (dir) state.docDir = dir;
      if (name) { state.fileName = name; $('.doc-title .name').textContent = name; }
      MM.updateStatus();
      MM.histSnapshot(true);
      toast('Saved');
    },
    autoSaved: function () {
      MM.markDirty(false); state.savedAt = Date.now(); MM.updateStatus();
      /* Unforced, deliberately. Autosave fires a second after the last
         keystroke, so forcing here made every typing pause take a snapshot and
         serialise the whole store — the 20s throttle existed and autosave was
         walking straight past it. A snapshot on the interval is what history
         is for; this is just a file write. */
      MM.histSnapshot();
    },
    externalChange: function (text) {
      var sp = el.prevPane.scrollTop, ss = el.srcScroll.scrollTop;
      MM.commitEditing(true);
      MM.setText(text, { immediate: true, markDirty: false });
      MM.markDirty(false);
      el.prevPane.scrollTop = sp; el.srcScroll.scrollTop = ss;
      toast('Reloaded from disk');
    },
    renamed: function (name) {
      state.fileName = name;
      docName.textContent = name;
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

      /* Blank-line separated: consecutive image links on one line run together
         into a single paragraph, which is never what dropping four files means. */
      var md = paths.map(function (p) { return '![](' + mdDestination(p) + ')'; }).join('\n\n');
      /* And separated from whatever is already there, or the image is pulled
         into the end of that paragraph as an inline run. */
      var before = ta.value.slice(0, ta.selectionStart);
      if (before && !/\n\s*\n$/.test(before)) md = (/\n$/.test(before) ? '\n' : '\n\n') + md;

      ta.focus();
      MM.replaceRange(ta, ta.selectionStart, ta.selectionEnd, md);
      toast(paths.length > 1 ? paths.length + ' images added' : 'Image added');
    },
    /* Kept for the original single-image bridge contract. */
    insertImage: function (relPath) { window.App.insertImages([relPath], null); },
    /* Called just before something that will steal the focus, so the caret can
       be put back afterwards. */
    pinInsertPoint: function () { MM.pinInsertPoint(); },
    setSystemTheme: function (t) { theme.systemDark = (t === 'dark'); applyTheme(); },
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
      if (p.zen === '1') setZenSilent(true);
      if (p.focus === '1') { state.focus = true; el.body.classList.add('focus'); }
      if (p.typewriter === '1') { state.typewriter = true; twBtn.classList.add('on'); }
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
        typewriter: function () { setTypewriter(!state.typewriter); },
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
        link: MM.insertLink,
        copyRich: MM.copyRich
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
    'Switch with the control above, the label in the bottom bar, or `⌘⇧M`.',
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
    'Click the **?** for the full syntax reference. Paste a web page and it',
    'arrives as clean markdown. Paste an image and it is saved beside your file.',
    '',
    'Click the filename in the top left to rename it. The button beside the **?**',
    'holds six themes and five typefaces.',
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
