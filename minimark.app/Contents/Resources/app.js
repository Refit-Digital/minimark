/* ============================================================
   minimark — core editor
   exposes window.MM for ui.js
   ============================================================ */
window.MM = (function () {
  'use strict';

  var $ = function (s) { return document.querySelector(s); };

  var el = {
    body: document.body,
    html: document.documentElement,
    title: $('.doc-title .name'),
    seg: $('#seg'), pill: $('#segPill'),
    src: $('#src'), hl: $('#hl'), srcScroll: $('#srcScroll'),
    doc: $('#doc'), prevPane: $('#previewPane'), stage: $('#stage'),
    sweep: $('#sweep'), toast: $('#toast'),
    stCount: $('#stCount'), stPos: $('#stPos'), stSaved: $('#stSaved')
  };

  var state = {
    text: '', blocks: [''], mode: 'split',
    editing: null, dirty: false,
    zen: false, focus: false, typewriter: false, styleCheck: false,
    /* 'paragraph' lights the block you are in, 'sentence' the sentence. */
    focusLevel: 'paragraph',
    /* The block the caret was last in. Live view has no other way to answer
       that once the block has been committed and is rendered HTML again. */
    lastBlock: 0,
    countIdx: 0, savedAt: null, fileName: 'Untitled.md', docDir: '',
    /* Why the autosave has stopped working, once the shell has counted enough
       consecutive failures to be sure it is not a passing sync client. Null
       whenever the file is being written, which is nearly always. */
    saveTrouble: null,
    /* Which of the shell's tabs is on screen. 0 until the shell says
       otherwise, which is also what an untabbed shell would leave it at, so
       every message carrying it stays meaningful either way. */
    tabId: 0,
    mathReady: false, mathPending: false,
    hlReady: false, hlPending: false
  };

  /* ---------------- scroll sync ----------------
     Proportional (scrollTop/max) sync cannot work: the two panes hold the
     same document at different heights, so equal fractions point at
     different content, and the error is worst near the ends. Time-based
     "ignore echoes for N ms" guards then made it worse, because a real
     scroll gesture fires events continuously and the guard swallowed the
     driving pane's own follow-up events.

     This system instead:
       1. builds a table of anchor pairs (block i's y in each pane) and
          interpolates between them, so the panes show the same content;
       2. pins both ends, so bottom means bottom and top means top;
       3. suppresses echoes by exact expected value rather than by time,
          which makes a feedback loop structurally impossible.

     The ladder is only as good as the moment it was measured, and that is
     where this used to fall down. #doc animates font-size, padding and
     max-width over 480ms whenever the mode, theme or typeface changes, and
     #sourcePane animates flex-grow alongside it. Building anchors on the
     first scroll during that window captures a half-finished layout and
     caches it as though it were final — the panes then agree at the top,
     where the error is nil, and diverge steadily further down. Nothing in
     the DOM announces "the transition finished", so the table is now
     invalidated by a ResizeObserver (which fires on every intermediate
     frame) and re-checked against a layout signature before every sync. */

  var anchors = null;        // { s: [y…], p: [y…] } content-space anchor pairs
  var anchorsDirty = true;
  var anchorSig = '';        // geometry fingerprint at build time
  var expect = { src: -1, prev: -1 };   // value we just wrote; its echo is ours

  function invalidateAnchors() { anchorsDirty = true; }

  /* Cheap fingerprint of everything that moves anchor geometry. If it has
     changed since the table was built the table is stale, whatever the dirty
     flag believes — this catches any cause we failed to anticipate. */
  function layoutSig() {
    return el.srcScroll.scrollHeight + '|' + el.srcScroll.clientWidth + '|' +
           el.prevPane.scrollHeight + '|' + el.prevPane.clientWidth + '|' +
           el.doc.childElementCount;
  }

  /* line index at which each block begins — mirrors splitBlocks exactly */
  function blockLineStarts(lines) {
    var starts = [], open = false, fence = null;
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      var f = /^\s{0,3}(```+|~~~+)/.exec(line);
      if (fence) {
        if (!open) { starts.push(i); open = true; }
        if (f && line.trim().indexOf(fence) === 0) fence = null;
        continue;
      }
      if (f) {
        fence = f[1][0].repeat(3);
        if (!open) { starts.push(i); open = true; }
        continue;
      }
      if (line.trim() === '') open = false;
      else if (!open) { starts.push(i); open = true; }
    }
    return starts;
  }

  /* y of a node in its scroll container's content space. The container's own
     rect is hoisted by the caller — measuring it once per build rather than
     once per node halves the layout reads on a long document. */
  function contentY(node, top0, scrollTop) {
    return node.getBoundingClientRect().top - top0 + scrollTop;
  }

  var TOP_ITEM = /^\s{0,3}([-*+]|\d+[.)])\s+/;

  /* A block is one anchor pair, so a block taller than the viewport is
     crossed on a single linear guess — which is exactly where a long list or
     table drifts. Where source lines and rendered rows provably correspond
     one-for-one we pin every row and the guess disappears. Anything we cannot
     prove (paragraphs, quotes, code) is left to interpolate, which is the
     honest answer for content that has no row structure to match. */
  function subAnchors(lines, from, to, lns, dv, h, ctx, push) {
    if (h < ctx.vh * 0.5) return;
    var j, k;

    var items = dv.querySelectorAll(':scope > ul > li, :scope > ol > li');
    if (items.length >= 2) {
      var il = [];
      for (j = from; j < to && j < lines.length; j++) if (TOP_ITEM.test(lines[j])) il.push(j);
      /* a mismatch means nested lists or wrapped items — bail rather than
         pair rows that do not belong together */
      if (il.length === items.length) {
        for (k = 0; k < items.length; k++) {
          if (lns[il[k]]) push(contentY(lns[il[k]], ctx.sTop, ctx.sScroll),
                               contentY(items[k], ctx.pTop, ctx.pScroll));
        }
        return;
      }
    }

    var rows = dv.querySelectorAll(':scope > table > tbody > tr');
    if (rows.length >= 2) {
      var tl = [];
      for (j = from; j < to && j < lines.length; j++) if (/^\s*\|/.test(lines[j])) tl.push(j);
      /* header row and delimiter row sit in front of the body rows */
      if (tl.length === rows.length + 2) {
        for (k = 0; k < rows.length; k++) {
          if (lns[tl[k + 2]]) push(contentY(lns[tl[k + 2]], ctx.sTop, ctx.sScroll),
                                   contentY(rows[k], ctx.pTop, ctx.pScroll));
        }
      }
    }
  }

  function buildAnchors() {
    anchorsDirty = false;
    anchors = null;
    anchorSig = layoutSig();

    var lines = String(state.text).split('\n');
    var starts = blockLineStarts(lines);
    var lns = el.hl.children, docs = el.doc.children;
    var n = Math.min(starts.length, docs.length);
    if (n < 2) return;

    var ctx = {
      sTop: el.srcScroll.getBoundingClientRect().top, sScroll: el.srcScroll.scrollTop,
      pTop: el.prevPane.getBoundingClientRect().top, pScroll: el.prevPane.scrollTop,
      vh: el.prevPane.clientHeight
    };

    var S = [], P = [];
    /* anchors must increase monotonically for interpolation to be sane */
    function push(sy, py) {
      if (S.length && (sy <= S[S.length - 1] || py <= P[P.length - 1])) return;
      S.push(sy); P.push(py);
    }

    for (var i = 0; i < n; i++) {
      var ln = lns[starts[i]], dv = docs[i];
      if (!ln || !dv) continue;
      var dr = dv.getBoundingClientRect();
      push(contentY(ln, ctx.sTop, ctx.sScroll), dr.top - ctx.pTop + ctx.pScroll);
      subAnchors(lines, starts[i], i + 1 < n ? starts[i + 1] : lines.length,
                 lns, dv, dr.height, ctx, push);
    }
    if (S.length >= 2) anchors = { s: S, p: P };
  }

  /* piecewise-linear map between the two anchor ladders */
  function mapY(from, to, y) {
    var n = from.length;
    if (y <= from[0]) return to[0] + (y - from[0]);
    for (var i = 0; i < n - 1; i++) {
      if (y < from[i + 1]) {
        var span = from[i + 1] - from[i];
        var f = span > 0 ? (y - from[i]) / span : 0;
        return to[i] + f * (to[i + 1] - to[i]);
      }
    }
    return to[n - 1] + (y - from[n - 1]);
  }

  function setScroll(which, y) {
    var pane = which === 'src' ? el.srcScroll : el.prevPane;
    y = Math.round(y);
    if (pane.scrollTop === y) return;
    expect[which] = y;
    pane.scrollTop = y;
  }

  function syncFrom(which) {
    if (state.mode !== 'split') return;
    /* the signature test is what makes a mid-transition table self-correct:
       the geometry it was measured against no longer exists, so rebuild */
    if (anchorsDirty || !anchors || layoutSig() !== anchorSig) buildAnchors();
    if (!anchors) return;

    var a = which === 'src' ? el.srcScroll : el.prevPane;
    var b = which === 'src' ? el.prevPane : el.srcScroll;
    var other = which === 'src' ? 'prev' : 'src';
    var from = which === 'src' ? anchors.s : anchors.p;
    var to = which === 'src' ? anchors.p : anchors.s;

    var maxA = a.scrollHeight - a.clientHeight;
    var maxB = b.scrollHeight - b.clientHeight;
    if (maxB <= 0) return;

    var target;
    if (maxA > 0 && a.scrollTop >= maxA - 1) target = maxB;      // bottom means bottom
    else if (a.scrollTop <= 0) target = 0;                        // top means top
    else target = mapY(from, to, a.scrollTop);

    target = Math.max(0, Math.min(maxB, Math.round(target)));
    if (Math.abs(target - b.scrollTop) < 1) return;
    expect[other] = target;
    b.scrollTop = target;
  }

  /* returns true when this scroll event is the echo of our own write */
  function isEcho(which, pane) {
    var e = expect[which];
    expect[which] = -1;
    return e >= 0 && Math.abs(pane.scrollTop - e) <= 1;
  }

  /* ---------------- native bridge ---------------- */
  var bridge = (window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.mm) || null;
  /* Reports whether the message actually left. Most callers do not care, but
     anything that clears local state on the strength of having sent something
     needs to know the difference between sent and swallowed. */
  function send(type, payload) {
    if (!bridge) return false;
    try {
      bridge.postMessage(Object.assign({ type: type }, payload || {}));
      return true;
    } catch (e) { return false; }
  }

  /* A file dropped on a bare web view is somewhere to navigate: WebKit would
     replace the whole editor with the file. The shell now intercepts image and
     document drags natively, before they reach the DOM at all, so this is only
     a backstop against a type it did not recognise.

     It must not be a blanket preventDefault. Dropping a .md file used to be
     handled by letting the navigation start and cancelling it in
     decidePolicyFor — cancelling the DOM event instead meant that navigation
     never began and dropping a document silently did nothing. Documents are
     taken natively now, but leaving the escape hatch open costs nothing and
     keeps the two layers from fighting over the same drop.

     Blocking every file drag is safe now, and would not have been before: the
     shell takes images and documents natively, so the only file that can still
     reach the DOM is one it did not recognise, and navigating to that is never
     what was meant. Type has to be read from dataTransfer.types, not .files —
     the file list is deliberately empty until the drop itself, so a dragover
     handler cannot see what is coming, and dragover is where the decision has
     to be made.

     Text dragged within the document carries no files and is untouched. */
  function carriesFiles(e) {
    var t = e.dataTransfer && e.dataTransfer.types;
    return !!(t && Array.prototype.indexOf.call(t, 'Files') >= 0);
  }
  function guardDrop(e) { if (carriesFiles(e)) e.preventDefault(); }
  window.addEventListener('dragover', guardDrop);
  window.addEventListener('drop', guardDrop);

  /* ---------------- lazy vendor loading ---------------- */
  function loadScript(src, cb) {
    var s = document.createElement('script');
    s.src = src; s.onload = cb; s.onerror = cb;
    document.head.appendChild(s);
  }
  function loadCSS(href) {
    var l = document.createElement('link');
    l.rel = 'stylesheet'; l.href = href;
    document.head.appendChild(l);
  }
  function ensureMath() {
    if (state.mathReady || state.mathPending) return;
    state.mathPending = true;
    loadCSS('vendor/katex.min.css');
    loadScript('vendor/katex.min.js', function () {
      state.mathReady = !!window.katex;
      state.mathPending = false;
      renderDoc(true);
    });
  }
  function ensureHL() {
    if (state.hlReady || state.hlPending) return;
    state.hlPending = true;
    loadScript('vendor/hljs.min.js', function () {
      state.hlReady = !!window.hljs;
      state.hlPending = false;
      renderDoc(true);
    });
  }

  /* ---------------- markdown pipeline ---------------- */
  marked.setOptions({ gfm: true, breaks: false });

  /* ---------------- wikilinks ----------------
     [[Another note]] and [[Another note|what to call it here]].

     Registered as a marked extension rather than done with a regex pass over
     the source, which is what the footnote handling above does. The reason is
     code: marked has already decided what is a code span and what is a fence
     by the time an inline tokenizer is asked, so `[[this]]` in backticks stays
     literal for free. A regex pre-pass has to work that out for itself and
     gets it wrong the first time somebody writes about wikilinks.

     The target is a bare filename by design — no slashes, no `..`, no path.
     That is what the syntax means in every tool that has it, and it means the
     shell can resolve it against the document's own folder and refuse
     anything that lands outside, rather than having to reason about a path a
     document handed it. */
  var WIKI = /^\[\[([^\[\]|\n]+?)(?:\|([^\[\]\n]*))?\]\]/;

  marked.use({
    extensions: [{
      name: 'wikilink',
      level: 'inline',
      /* marked calls this to find the next place worth trying, so returning
         the real index rather than 0 keeps it from tokenising every
         character of every paragraph */
      start: function (src) { var i = src.indexOf('[['); return i < 0 ? undefined : i; },
      tokenizer: function (src) {
        var m = WIKI.exec(src);
        if (!m) return;
        var target = m[1].trim();
        if (!target) return;
        return {
          type: 'wikilink', raw: m[0],
          target: target,
          label: (m[2] == null ? '' : m[2].trim()) || target
        };
      },
      renderer: function (t) {
        /* No href at all. A wikilink is not a URL and giving it one would
           mean the sanitiser's URL rules, the browser's navigation and the
           rel="noopener" pass all had an opinion about a string that is just
           a filename. The click handler reads data-wiki and nothing else. */
        return '<a class="wikilink" data-wiki="' + esc(t.target) + '">' + esc(t.label) + '</a>';
      }
    }]
  });

  /* ---------------- which wikilinks point at something ----------------

     A link to a note that exists and a link to one that does not used to look
     identical, so the only way to find a typo in a filename was to click every
     link in the document. The page cannot answer this itself: it knows a name,
     and the folder belongs to the shell.

     One round trip per render, not one per link. Every unresolved name in the
     document goes over together and the answers come back as a map, which is
     what makes this affordable on a document with forty links in it. Answers
     are cached for as long as the folder stays the same, so re-rendering on
     every keystroke asks nothing at all.

     Optimistic while it waits: an unanswered link is drawn as though it
     resolves. The alternative is a document that flickers "missing" across
     every link for a frame after each render, which is worse than being a
     beat late with the truth. */
  var wikiKnown = {};       // bare name -> true | false
  var wikiDir = null;       // the folder those answers were about
  var wikiAsking = {};      // names already out for an answer

  function paintWikilinks() {
    /* The folder moved under us — Save As, a tab switch, a rename. Nothing
       learned about the old one says anything about this one. */
    if (wikiDir !== state.docDir) {
      wikiDir = state.docDir;
      wikiKnown = {};
      wikiAsking = {};
    }

    var links = el.doc.querySelectorAll('a.wikilink[data-wiki]');
    var ask = [], seen = {};
    for (var i = 0; i < links.length; i++) {
      var name = links[i].getAttribute('data-wiki');
      var known = wikiKnown[name];
      links[i].classList.toggle('missing', known === false);
      if (known === undefined && !wikiAsking[name] && !seen[name]) {
        seen[name] = 1;
        ask.push(name);
      }
    }
    if (!ask.length) return;
    ask.forEach(function (n) { wikiAsking[n] = 1; });
    send('wikiCheck', { names: ask });
  }

  /* The shell's answer: { name: true|false }. Merged rather than replacing,
     because a document can render again while an earlier batch is still out. */
  function setWikiTargets(map) {
    if (!map || typeof map !== 'object') return;
    Object.keys(map).forEach(function (k) {
      wikiKnown[k] = !!map[k];
      delete wikiAsking[k];
    });
    var links = el.doc.querySelectorAll('a.wikilink[data-wiki]');
    for (var i = 0; i < links.length; i++) {
      var known = wikiKnown[links[i].getAttribute('data-wiki')];
      links[i].classList.toggle('missing', known === false);
    }
  }

  /* Something happened that the cached answers cannot survive: a wikilink
     created the file it named, or a document arrived from a different folder. */
  function forgetWikiTargets() {
    wikiKnown = {};
    wikiAsking = {};
    wikiDir = null;
    paintWikilinks();
  }

  /* ---------------- sanitiser ----------------
     Markdown may carry raw HTML and marked passes it straight through, so
     everything on its way to innerHTML comes through here. This is an
     allowlist walk over a parsed tree rather than a regex pass over a
     string: a tag or an attribute nobody anticipated is denied by default
     instead of waiting for someone to find the next hole.

     The regex version this replaces could be walked past three ways.
     `<img src=x /onerror=alert(1)>` never matched the handler pattern,
     because that pattern wanted whitespace before the attribute and HTML
     also accepts `/`. `<script src=…>` with no closing tag survived a
     rule that only removed matched pairs. And a single non-recursive
     `javascript:` strip turns `javjavascript:ascript:` back into
     `javascript:`. Parsing instead of pattern-matching removes the whole
     category, and entity-encoded payloads (`&#106;avascript:`) arrive
     already decoded, so they are checked as what they actually are. */

  /* Kept as-is. Everything here is prose, structure or code display. */
  var OK_TAGS = {};
  'A ABBR B BDI BDO BLOCKQUOTE BR CAPTION CITE CODE COL COLGROUP DD DEL DETAILS DFN DIV DL DT EM FIGCAPTION FIGURE H1 H2 H3 H4 H5 H6 HR I IMG INPUT INS KBD LI MARK OL P PRE Q RP RT RUBY S SAMP SECTION SMALL SPAN STRONG SUB SUMMARY SUP TABLE TBODY TD TFOOT TH THEAD TR U UL VAR WBR'
    .split(' ').forEach(function (t) { OK_TAGS[t] = 1; });

  /* Removed with their subtree. What is inside these is code, payload or
     metadata — never text the writer meant anyone to read. Any other
     unknown tag is unwrapped instead, so its text survives. */
  var KILL_TAGS = {};
  'SCRIPT STYLE IFRAME FRAME FRAMESET OBJECT EMBED APPLET NOSCRIPT TEMPLATE BASE LINK META HEAD TITLE FORM BUTTON TEXTAREA SELECT OPTION OPTGROUP FIELDSET LEGEND LABEL OUTPUT PROGRESS METER SVG MATH CANVAS AUDIO VIDEO SOURCE TRACK MAP AREA PORTAL DIALOG SLOT MARQUEE'
    .split(' ').forEach(function (t) { KILL_TAGS[t] = 1; });

  var OK_ATTR = {};
  'href src alt title class id lang dir width height align colspan rowspan scope headers span start reversed value type checked disabled open datetime cite label data-wiki'
    .split(' ').forEach(function (a) { OK_ATTR[a] = 1; });

  var URL_ATTR = { href: 1, src: 1, cite: 1 };

  /* file: is needed — a document's own images resolve to file:// URLs
     against its folder. data: is images only, and never image/svg+xml,
     which is a scripting context wearing a picture's clothes. */
  var OK_SCHEME = /^(?:https?|mailto|tel|file):/i;
  var OK_DATA_IMG = /^data:image\/(?:png|jpe?g|gif|webp|avif|bmp|x-icon);base64,[a-z0-9+/=\s]*$/i;

  /* marked emits table alignment as an inline style, so style is allowed
     through for exactly that one declaration and nothing else. */
  var OK_STYLE = /^\s*text-align\s*:\s*(?:left|right|center|justify)\s*;?\s*$/i;

  function safeURL(value, isImage) {
    /* Control characters and stray whitespace are stripped first: they are
       ignored when the URL is resolved but would otherwise hide a scheme,
       as in `jav&#x09;ascript:`. */
    var s = String(value).replace(/[\u0000-\u001F\u007F]/g, '').trim();
    if (!s) return null;
    if (/^[a-z][a-z0-9+.\-]*:/i.test(s)) {          /* it declares a scheme */
      if (OK_SCHEME.test(s)) return s;
      if (isImage && OK_DATA_IMG.test(s)) return s;
      return null;                                   /* javascript:, vbscript:, data:text/html, anything unrecognised */
    }
    if (s.slice(0, 2) === '//') return null;         /* protocol-relative */
    return s;                                        /* relative path or fragment */
  }

  function scrubAttrs(node) {
    var isImage = node.tagName === 'IMG';
    var attrs = node.attributes;
    for (var i = attrs.length - 1; i >= 0; i--) {
      var raw = attrs[i].name, name = raw.toLowerCase(), value = attrs[i].value;

      if (name === 'style') {
        if (!OK_STYLE.test(value)) node.removeAttribute(raw);
        continue;
      }
      /* on* is redundant with the allowlist and kept as a belt-and-braces
         guard: an event handler must never survive a bug in the list. */
      if (name.indexOf('on') === 0 || !OK_ATTR[name]) { node.removeAttribute(raw); continue; }
      if (URL_ATTR[name]) {
        var safe = safeURL(value, isImage);
        if (safe === null) node.removeAttribute(raw);
        else if (safe !== value) node.setAttribute(raw, safe);
      }
    }
    /* A link that leaves the document should not hand the destination a
       handle back to this window. */
    if (node.tagName === 'A' && node.getAttribute('href')) {
      node.setAttribute('rel', 'noopener noreferrer');
    }
  }

  function scrubTree(parent) {
    var child = parent.firstChild;
    while (child) {
      var next = child.nextSibling;
      if (child.nodeType === 1) {
        var tag = child.tagName;
        if (KILL_TAGS[tag]) {
          parent.removeChild(child);
        } else if (OK_TAGS[tag]) {
          scrubAttrs(child);
          scrubTree(child);
        } else {
          scrubTree(child);
          unwrapNode(child);       /* unknown but harmless: keep the text */
        }
      } else if (child.nodeType === 8) {
        parent.removeChild(child); /* comments */
      }
      child = next;
    }
  }

  function unwrapNode(node) {
    var parent = node.parentNode;
    if (!parent) return;
    while (node.firstChild) parent.insertBefore(node.firstChild, node);
    parent.removeChild(node);
  }

  /* One inert document, reused. It is not browsing-context connected, so
     assigning to it neither runs scripts nor fetches images, and reusing it
     keeps this cheap enough to sit in the per-block render path. */
  var scrubDoc = null;

  function clean(html) {
    if (!html) return '';
    try {
      if (!scrubDoc) scrubDoc = document.implementation.createHTMLDocument('mm-scrub');
      scrubDoc.body.innerHTML = String(html);
      scrubTree(scrubDoc.body);
      return scrubDoc.body.innerHTML;
    } catch (e) {
      /* Never hand back the unsanitised input on failure. */
      return esc(String(html));
    }
  }

  var esc = function (s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  };

  /* pull $…$ and $$…$$ out before marked sees them */
  function extractMath(src, store) {
    var codes = [];
    src = src.replace(/(`+)([\s\S]*?)\1/g, function (m) {
      codes.push(m); return 'C' + (codes.length - 1) + '';
    });
    src = src.replace(/\$\$([\s\S]+?)\$\$/g, function (m, tex) {
      store.push({ tex: tex, display: true }); return 'M' + (store.length - 1) + '';
    });
    src = src.replace(/(^|[^\\$])\$(?!\s)((?:[^$\\\n]|\\.)+?)(?<!\s)\$(?!\d)/g, function (m, pre, tex) {
      store.push({ tex: tex, display: false }); return pre + 'M' + (store.length - 1) + '';
    });
    src = src.replace(/C(\d+)/g, function (m, i) { return codes[+i]; });
    return src;
  }

  function injectMath(html, store) {
    return html.replace(/M(\d+)/g, function (m, i) {
      var it = store[+i];
      if (!it) return '';
      if (!state.mathReady) { ensureMath(); return '<code>' + esc(it.display ? '$$' + it.tex + '$$' : '$' + it.tex + '$') + '</code>'; }
      try {
        return window.katex.renderToString(it.tex, { displayMode: it.display, throwOnError: false, output: 'html' });
      } catch (e) {
        return '<span class="math-error">' + esc(it.tex) + '</span>';
      }
    });
  }

  function frontMatter(src) {
    var m = /^---\r?\n([\s\S]*?)\r?\n---\s*$/.exec(src);
    if (!m) return null;
    var rows = m[1].split('\n').filter(function (l) { return l.trim(); });
    if (!rows.length) return null;
    var out = '<dl class="fm-card">';
    rows.forEach(function (l) {
      var i = l.indexOf(':');
      if (i === -1) { out += '<dt></dt><dd>' + esc(l.trim()) + '</dd>'; return; }
      out += '<dt>' + esc(l.slice(0, i).trim()) + '</dt><dd>' + esc(l.slice(i + 1).trim()) + '</dd>';
    });
    return out + '</dl>';
  }

  /* Each block is parsed on its own, so a [ref]: definition sitting in another
     block is invisible to the reference that needs it and the link renders as
     literal brackets. Collect every definition in the document once per render
     and hand the set to any block that actually uses one. */
  var LINK_DEF = /^[ \t]{0,3}\[[^\]\n]+\]:[ \t]*\S+(?:[ \t]+(?:"[^"\n]*"|'[^'\n]*'|\([^)\n]*\)))?[ \t]*$/;
  var USES_REF = /\]\s*\[/;
  var FENCE_START = /^[ \t]{0,3}(```|~~~)/;
  var linkDefs = '';

  function collectLinkDefs(text) {
    var lines = String(text).split('\n'), out = [], fence = false;
    for (var i = 0; i < lines.length; i++) {
      var l = lines[i];
      if (FENCE_START.test(l)) { fence = !fence; continue; }
      if (!fence && LINK_DEF.test(l)) out.push(l.trim());
    }
    linkDefs = out.join('\n');
  }

  function md(srcText, index) {
    srcText = srcText || '';
    if (index === 0) { var fm = frontMatter(srcText); if (fm) return fm; }

    var fnDef = /^\[\^([^\]\s]+)\]:\s*([\s\S]*)$/.exec(srcText);
    if (fnDef) {
      /* Guarded like the main marked.parse below. This was the one call that
         was not, and md() is reached from App.getHTML(): a throw here left
         the native side with no string at all, which it read as "" and wrote
         to the file, so one malformed footnote emptied an HTML export. */
      var inline;
      try { inline = clean(marked.parseInline(fnDef[2] || '')); }
      catch (e) { inline = esc(fnDef[2] || ''); }
      return '<div class="fn-def"><span class="fn-id">' + esc(fnDef[1]) + '.</span><div>' +
             inline + '</div></div>';
    }

    var store = [];
    var prepared = extractMath(srcText, store);
    prepared = prepared.replace(/\[\^([^\]\s]+)\]/g, function (m, id) {
      return '<sup class="fn-ref">' + esc(id) + '</sup>';
    });

    if (linkDefs && USES_REF.test(prepared) && !FENCE_START.test(prepared)) {
      prepared += '\n\n' + linkDefs;
    }

    var out;
    try { out = marked.parse(prepared); } catch (e) { out = '<p></p>'; }
    out = injectMath(clean(out).trim(), store);
    return out || '<p><br></p>';
  }

  function highlightIn(root) {
    var blocks = root.querySelectorAll('pre code[class*="language-"]');
    if (!blocks.length) return;
    if (!state.hlReady) { ensureHL(); return; }
    blocks.forEach(function (b) {
      if (b.dataset.hl) return;
      var lang = (b.className.match(/language-([\w-]+)/) || [])[1];
      try {
        if (lang && window.hljs.getLanguage(lang)) {
          b.innerHTML = window.hljs.highlight(b.textContent, { language: lang }).value;
        } else {
          b.innerHTML = window.hljs.highlightAuto(b.textContent).value;
        }
        b.dataset.hl = '1';
      } catch (e) {}
    });
  }

  /* Relative image paths resolve against the document's folder, not the bundle
     the page itself was loaded from.

     Only relative paths need that folder. An absolute one is already complete,
     so it must still be rewritten in a document that has never been saved —
     bailing out up front left `/Users/…/photo.png` to resolve against the app
     bundle's Resources directory, where it does not exist. */
  /* encodeURI leaves # and ? alone, which is right for a web address and wrong
     for a filename: a folder called "Q?" or an image called "fig#2.png" would
     otherwise be read as a query or a fragment and the file would not load.
     Slashes have to survive, so they cannot simply be encodeURIComponent'd. */
  function encodePath(p) {
    return encodeURI(p).replace(/[#?]/g, function (c) {
      return c === '#' ? '%23' : '%3F';
    });
  }

  function fixImages(root) {
    var dir = state.docDir ? encodePath(state.docDir.replace(/\/+$/, '')) : '';
    root.querySelectorAll('img[src]').forEach(function (img) {
      var s = img.getAttribute('src') || '';
      if (!s || /^(https?:|data:|file:|\/\/)/i.test(s)) return;
      if (s.charAt(0) === '/') { img.src = 'file://' + encodePath(s); return; }
      if (!dir) return;                  /* nowhere to resolve a relative path yet */
      img.src = 'file://' + dir + '/' + encodePath(s);
    });
  }

  /* ---------------- blocks ---------------- */
  function splitBlocks(text) {
    var lines = String(text).split('\n');
    var blocks = [], cur = [], fence = null;
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      var f = /^\s{0,3}(```+|~~~+)/.exec(line);
      if (fence) {
        cur.push(line);
        if (f && line.trim().indexOf(fence) === 0) fence = null;
        continue;
      }
      if (f) { fence = f[1][0].repeat(3); cur.push(line); continue; }
      if (line.trim() === '') { if (cur.length) { blocks.push(cur.join('\n')); cur = []; } }
      else cur.push(line);
    }
    if (cur.length) blocks.push(cur.join('\n'));
    return blocks.length ? blocks : [''];
  }

  /* joinBlocks is lossy on purpose: it is how a *fragment* of blocks is turned
     back into markdown. It must never be used to rebuild the whole document,
     because it flattens every run of blank lines in the file to exactly one
     and drops any trailing newline. Use spliceBlock for that. */
  function joinBlocks(bs) {
    return bs.filter(function (b, i) { return b !== '' || i === 0; }).join('\n\n');
  }

  /* Where each block actually sits in state.text. Blocks are contiguous
     substrings of the document in order, so one forward scan finds them all;
     a block that exists only as editing state (the empty one a writer has
     just opened) collapses to a zero-width span at the right place. */
  function blockSpans() {
    var text = state.text, bs = state.blocks, spans = [], at = 0;
    for (var i = 0; i < bs.length; i++) {
      var b = bs[i];
      if (b === '') { spans.push([at, at]); continue; }
      var k = text.indexOf(b, at);
      if (k === -1) k = Math.min(at, text.length);
      spans.push([k, k + b.length]);
      at = k + b.length;
    }
    return spans;
  }

  /* Writing `value` into block i. A block that is only editing state — the
     empty one a writer has just opened — occupies no span at all, because
     markdown cannot express an empty paragraph. Filling one in therefore has
     to *insert* it along with its separators; splicing a zero-width span
     would weld the new paragraph onto the end of the previous one. Returns
     the new text and where inside it the value came to rest. */
  function blockEdit(i, value) {
    var spans = blockSpans(), span = spans[i], text = state.text;
    if (!span) return { text: text, at: text.length };
    if (state.blocks[i] !== '') {
      return { text: text.slice(0, span[0]) + value + text.slice(span[1]), at: span[0] };
    }
    if (value === '') return { text: text, at: span[0] };
    if (spans.length === 1) return { text: value, at: 0 };
    var at = span[0];
    if (i > 0) return { text: text.slice(0, at) + '\n\n' + value + text.slice(at), at: at + 2 };
    return { text: value + '\n\n' + text.slice(at), at: 0 };
  }

  /* Replace the span that `count` blocks starting at `i` occupy, and leave
     every other byte of the document — the writer's blank-line runs, their
     trailing newline, whatever indentation sits between blocks — untouched. */
  function spliceBlock(i, count, text) {
    if (count === 1) return blockEdit(i, text).text;
    var spans = blockSpans();
    if (!spans.length) return text;
    var head = spans[i] || spans[spans.length - 1];
    var tail = spans[i + count - 1] || head;
    return state.text.slice(0, head[0]) + text + state.text.slice(tail[1]);
  }

  /* An empty paragraph has no markdown of its own, so it is kept as one extra
     blank line: the gap the writer left survives in the file and in the source
     pane. Reopening the file shows the wider gap rather than an empty block,
     because splitBlocks has nothing to build one from. */
  function emptyBlockText(i) {
    var spans = blockSpans(), span = spans[i];
    if (!span) return state.text;
    /* A trailing empty block is scaffolding, not content: the writer clicked
       below the document for somewhere to type and then left without typing.
       Widening the gap for it appended a blank line to the file on every such
       click, and they accumulated. Give the text back exactly as it stands. */
    if (i === state.blocks.length - 1 && state.blocks[i] === '') return state.text;
    if (state.blocks[i] === '') {   /* never had a span; just widen the gap */
      return state.text.slice(0, span[0]) + '\n' + state.text.slice(span[0]);
    }
    var at = i > 0 ? spans[i - 1][1] : span[0];
    var t = dropBlockText(i);
    return t.slice(0, at) + '\n' + t.slice(at);
  }

  /* The document exactly as it should be written to disk right now — state.text
     alone is stale whenever live view has a block open. */
  function docText() {
    var ed = state.editing;
    if (!ed) return state.text;
    if (ed.ta.value.trim() === '' && state.blocks.length > 1) return emptyBlockText(ed.i);
    return blockEdit(ed.i, ed.ta.value).text;
  }

  /* Removing a block has to take one of its separators with it, or emptying a
     paragraph leaves a widening gap behind. */
  function dropBlockText(i) {
    var spans = blockSpans(), s = spans[i];
    if (!s) return state.text;
    var a = i > 0 ? spans[i - 1][1] : s[0];
    var b = i > 0 ? s[1] : (spans[i + 1] ? spans[i + 1][0] : s[1]);
    return state.text.slice(0, a) + state.text.slice(b);
  }

  function blockKind(s) {
    var t = String(s).trimStart();
    if (/^(```|~~~)/.test(t)) return 'code';
    if (/^>/.test(t)) return 'quote';
    if (/^([-*+]|\d+[.)])\s/.test(t)) return 'list';
    if (/^\|/.test(t)) return 'table';
    if (/^#{1,6}\s/.test(t)) return 'heading';
    return 'para';
  }

  /* ---------------- raw pane tinting ---------------- */
  function inlineTint(s) {
    s = s.replace(/`([^`]+)`/g, '<span class="t-code">`$1`</span>');
    /* Before the ordinary link rule, which would otherwise take the inner
       pair of brackets and leave the outer two sitting there untinted. */
    s = s.replace(/(\[\[)([^\[\]|\n]+?)(?:(\|)([^\[\]\n]*))?(\]\])/g, function (m, o, target, bar, label, c) {
      return '<span class="t-mark">' + o + '</span><span class="t-link">' + target + '</span>' +
             (bar ? '<span class="t-mark">' + bar + '</span><span class="t-link">' + label + '</span>' : '') +
             '<span class="t-mark">' + c + '</span>';
    });
    s = s.replace(/(!?\[)([^\]]*)(\])(\([^)]*\))/g,
      '<span class="t-mark">$1</span><span class="t-link">$2</span><span class="t-mark">$3$4</span>');
    s = s.replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g,
      '<span class="t-mark">$1</span><span class="t-bold">$2</span><span class="t-mark">$1</span>');
    s = s.replace(/~~(?=\S)([\s\S]*?\S)~~/g,
      '<span class="t-mark">~~</span><span class="t-strike">$1</span><span class="t-mark">~~</span>');
    s = s.replace(/(^|[^\*\w])(\*)(?=\S)([^\*\n]*?\S)\2/g,
      '$1<span class="t-mark">*</span><span class="t-em">$3</span><span class="t-mark">*</span>');
    s = s.replace(/(^|[^_\w])(_)(?=\S)([^_\n]*?\S)\2/g,
      '$1<span class="t-mark">_</span><span class="t-em">$3</span><span class="t-mark">_</span>');
    return s;
  }

  function tintLine(raw) {
    var line = esc(raw), m;
    if ((m = /^(\s*)(#{1,6})(\s+)(.*)$/.exec(raw)))
      return m[1] + '<span class="t-mark">' + m[2] + '</span>' + m[3] + '<span class="t-head">' + inlineTint(esc(m[4])) + '</span>';
    if ((m = /^(\s*)(>+)(\s?)(.*)$/.exec(raw)))
      return m[1] + '<span class="t-mark">' + m[2] + '</span>' + m[3] + '<span class="t-quote">' + inlineTint(esc(m[4])) + '</span>';
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(raw))
      return '<span class="t-hr">' + line + '</span>';
    if ((m = /^(\s*)([-*+]|\d+[.)])(\s+)(\[[ xX]\]\s+)?(.*)$/.exec(raw)))
      return m[1] + '<span class="t-mark">' + m[2] + '</span>' + m[3] +
             (m[4] ? '<span class="t-link">' + esc(m[4]) + '</span>' : '') + inlineTint(esc(m[5]));
    if (/^\s*\|/.test(raw))
      return line.replace(/\|/g, '<span class="t-mark">|</span>');
    return inlineTint(line);
  }

  function tint(text) {
    var lines = String(text).split('\n');
    var out = [], fence = false, fm = false;
    for (var i = 0; i < lines.length; i++) {
      var raw = lines[i], inner;
      if (i === 0 && raw.trim() === '---') { fm = true; inner = '<span class="t-fm">' + esc(raw) + '</span>'; }
      else if (fm) {
        inner = '<span class="t-fm">' + esc(raw) + '</span>';
        if (raw.trim() === '---') fm = false;
      } else if (/^\s{0,3}(```+|~~~+)/.test(raw)) {
        fence = !fence; inner = '<span class="t-fence">' + esc(raw) + '</span>';
      } else if (fence) {
        inner = '<span class="t-code">' + esc(raw) + '</span>';
      } else {
        inner = tintLine(raw);
      }
      out.push('<span class="ln">' + inner + '</span>');
    }
    return out.join('\n') + '\n';
  }

  /* ---------------- rendering ---------------- */
  var renderTimer = null;

  /* Measuring a textarea's natural height means collapsing it first, and a
     collapsed textarea drags two scroll positions down with it: the pane
     clamps its scrollTop to the briefly-shorter content, and the textarea
     itself scrolls to keep the caret in view. Both used to be put back a
     frame late — the pane's by the next typewriter pass, the textarea's by
     its own scroll handler — and that one late frame is the flash. Measure,
     then restore both before the browser is given a chance to paint. */
  /* Same reason as autosize below: `auto` floors at the rows attribute, not at
     the content. It shows less here, because the source pane is nearly always
     taller than two rows, but an empty document still got a field with a blank
     line under the caret. */
  function autosizeSrc() {
    var keep = el.srcScroll.scrollTop;
    el.src.style.height = '0px';
    el.src.style.height = el.src.scrollHeight + 'px';
    if (el.src.scrollTop !== 0) el.src.scrollTop = 0;
    if (el.srcScroll.scrollTop !== keep) setScroll('src', keep);
  }

  function paintSource() {
    el.hl.innerHTML = tint(state.text);
    autosizeSrc();
    markCurrentLine();
    invalidateAnchors();
  }

  /* keepBlocks renders state.blocks as they stand instead of re-deriving them
     from state.text. Markdown has no way to write an empty paragraph — it is
     whitespace, and joinBlocks drops it — so a block the writer has just
     opened but not yet typed into cannot survive a round trip through the
     text. It is editing state, not content, and only state.blocks can hold it. */
  function renderDoc(preserveScroll, keepBlocks) {
    var top = preserveScroll ? el.prevPane.scrollTop : null;
    if (!keepBlocks) state.blocks = splitBlocks(state.text);
    collectLinkDefs(state.text);
    var frag = document.createDocumentFragment();
    for (var i = 0; i < state.blocks.length; i++) {
      var d = document.createElement('div');
      d.className = 'blk';
      d.dataset.i = String(i);
      d.innerHTML = md(state.blocks[i], i);
      frag.appendChild(d);
    }
    el.doc.innerHTML = '';
    el.doc.appendChild(frag);
    highlightIn(el.doc);
    fixImages(el.doc);
    invalidateAnchors();
    if (top !== null && el.prevPane.scrollTop !== top) setScroll('prev', top);
    paintWikilinks();
    if (MM.onDocRendered) MM.onDocRendered();
    /* every block node the bin could have been parked against has just been
       thrown away, and the index it held may now name a different block */
    hideBin();
    markCurrentBlock();
  }

  function scheduleRender() {
    if (renderTimer) clearTimeout(renderTimer);
    renderTimer = setTimeout(function () {
      renderTimer = null;
      renderDoc(true);
      /* followCaret parks the caret's block at 34% of the preview, which is
         a second opinion about where the page should sit. In typewriter mode
         the source is already being held at 42% and the sync mirrors it, so
         letting both run means they undo each other every 90ms — which is
         precisely the up-and-down the writer sees. */
      if (state.mode === 'split' && !state.typewriter) followCaret();
    }, 90);
  }

  function setText(text, opts) {
    opts = opts || {};
    state.lastBlock = 0;
    state.text = String(text == null ? '' : text);
    if (opts.fromSource !== true) el.src.value = state.text;
    paintSource();
    if (opts.immediate) renderDoc(true); else scheduleRender();
    updateStatus();
    if (opts.markDirty !== false) markDirty(true);
  }

  /* ---------------- status ---------------- */
  var COUNTS = ['words', 'chars', 'read'];

  function stats() {
    var t = state.text;
    var words = (t.trim().match(/[^\s]+/g) || []).length;
    return { words: words, chars: t.length, mins: words ? Math.max(1, Math.round(words / 220)) : 0 };
  }

  function updateStatus() {
    var s = stats(), kind = COUNTS[state.countIdx % COUNTS.length], html;
    if (kind === 'words') html = '<b>' + s.words.toLocaleString() + '</b> word' + (s.words === 1 ? '' : 's');
    else if (kind === 'chars') html = '<b>' + s.chars.toLocaleString() + '</b> character' + (s.chars === 1 ? '' : 's');
    else html = '<b>' + s.mins + '</b> min read';
    el.stCount.innerHTML = html;
    updateCaretStatus();
    updateSaved();
  }

  function updateSaved() {
    /* A file that has stopped being written outranks the time of the last one
       that was. "saved 4m ago" is true and useless in that state: it is the
       last good write being reported as though nothing had changed since. */
    if (state.saveTrouble) {
      el.stSaved.textContent = 'not saving';
      el.stSaved.title = state.saveTrouble + '\n\nThe text on screen is safe. Use \u2318S to save it somewhere else.';
      el.stSaved.classList.add('trouble');
      return;
    }
    el.stSaved.classList.remove('trouble');
    el.stSaved.title = '';
    if (!state.savedAt) { el.stSaved.textContent = ''; return; }
    var d = Math.round((Date.now() - state.savedAt) / 1000);
    var txt = d < 5 ? 'saved just now' : d < 60 ? 'saved ' + d + 's ago'
            : d < 3600 ? 'saved ' + Math.round(d / 60) + 'm ago'
            : 'saved ' + new Date(state.savedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    el.stSaved.textContent = txt;
  }
  setInterval(updateSaved, 15000);

  function updateCaretStatus() {
    if (state.mode === 'live') {
      var i = state.editing ? state.editing.i + 1 : 0;
      /* "Block" is the codebase's word for it. A writer has paragraphs, and
         the status bar is written for the writer. */
      el.stPos.textContent = i ? ('Paragraph ' + i + ' of ' + state.blocks.length)
                               : (state.blocks.length + ' paragraph' + (state.blocks.length === 1 ? '' : 's'));
      return;
    }
    var pos = el.src.selectionStart || 0;
    el.stPos.textContent = 'Ln ' + (el.src.value.slice(0, pos).split('\n').length);
  }

  function markDirty(v) {
    /* Stamped before the early return: this is called on every edit, but only
       transitions past it, and the history writer needs to know the writer is
       still going, not just that they have started. */
    if (v) histActivity = Date.now();
    if (state.dirty === v) return;
    state.dirty = v;
    el.body.classList.toggle('dirty', v);
    /* Carries the tab. Only the document on screen can be edited, so the id is
       always the active one, but the shell autosaves and closes tabs that are
       not — it has to be able to file this against the right one rather than
       against whichever happens to be in front when the message lands. */
    send('dirty', { dirty: v, id: state.tabId });
    if (MM.onDirty) MM.onDirty(v);
  }

  var toastTimer = null;
  function toast(msg) {
    el.toast.textContent = msg;
    el.toast.classList.add('show');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.toast.classList.remove('show'); }, 1500);
  }

  /* ---------------- caret ↔ block ---------------- */
  /* These used to assume every separator was exactly '\n\n', which put the
     caret in the wrong block in any file with a double blank line in it. */
  function blockStartOffsets() {
    return blockSpans().map(function (s) { return s[0]; });
  }
  function blockIndexForOffset(off) {
    var offs = blockStartOffsets(), idx = 0;
    for (var i = 0; i < offs.length; i++) if (off >= offs[i]) idx = i;
    return idx;
  }
  function currentLineIndex() {
    return el.src.value.slice(0, el.src.selectionStart || 0).split('\n').length - 1;
  }

  function markCurrentLine() {
    if (!state.focus && !state.typewriter) return;
    var n = currentLineIndex(), kids = el.hl.children;
    for (var i = 0; i < kids.length; i++) kids[i].classList.toggle('cur', i === n);
    paintLineSentences();
  }
  /* Which block focus mode should keep lit when no block is open. In split
     view the source textarea holds the real caret and answers this properly.
     In live view it does not: el.src is off screen and its caret sits wherever
     the last full assignment left it, which is the end of the document — so
     closing a block used to throw the focus to the last paragraph in the file.
     Live view remembers instead. */
  function markCurrentBlock() {
    if (!state.focus) return;
    var i;
    if (state.editing) i = state.editing.i;
    else if (state.mode === 'live') i = state.lastBlock;
    else i = blockIndexForOffset(el.src.selectionStart || 0);
    i = Math.max(0, Math.min(state.blocks.length - 1, i == null ? 0 : i));
    var kids = el.doc.children;
    for (var k = 0; k < kids.length; k++) kids[k].classList.toggle('cur', k === i);
  }

  /* ---------------- sentences ----------------
     Focus mode can light the sentence rather than the paragraph, which means
     the editor has to know where a sentence ends. There is no correct answer
     to that in general, so this aims to be wrong rarely and never
     catastrophically: the cost of a bad split is one clause dimmed that
     should not have been, which the next keystroke corrects.

     A terminator ends a sentence when whitespace or the end of the text
     follows it, closing quotes and brackets excepted, and when what precedes
     it is not something that routinely carries a full stop of its own. */
  var ABBREV = /(?:^|[\s(\[])(?:mr|mrs|ms|dr|prof|rev|sr|jr|st|vs|etc|approx|fig|no|vol|pp|al|inc|ltd|co|dept|est|max|min|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec|e\.g|i\.e)\.$/i;
  var CLOSERS = '”’")]»';

  function sentences(text) {
    text = String(text == null ? '' : text);
    var out = [], start = 0, i = 0, n = text.length;
    while (i < n) {
      var c = text[i];
      if (c !== '.' && c !== '!' && c !== '?') { i++; continue; }
      var j = i;
      while (j + 1 < n && '.!?'.indexOf(text[j + 1]) > -1) j++;   /* "?!", "..." */
      var k = j + 1;
      while (k < n && CLOSERS.indexOf(text[k]) > -1) k++;         /* he said "no." */
      var ends = k >= n || /\s/.test(text[k]);
      if (ends && c === '.') {
        var lead = text.slice(0, i + 1);
        /* Dr. Foster, e.g. this, and J. R. Hartley — all of which carry a
           full stop that is not the end of anything. */
        if (ABBREV.test(lead.slice(-14))) ends = false;
        else if (/(?:^|[\s(\[])[A-Za-z]\.$/.test(lead.slice(-3))) ends = false;
      }
      if (!ends) { i = k; continue; }
      var e = k;
      while (e < n && /[ \t]/.test(text[e])) e++;   /* the space after belongs to what it follows */
      out.push([start, e]);
      start = e; i = e;
    }
    if (start < n) out.push([start, n]);
    return out.length ? out : [[0, n]];
  }

  /* Which of those the caret is in. A caret sitting exactly on a boundary
     belongs to the sentence it is about to type into, not the one it just
     finished, which is what makes typing past a full stop move the light on
     rather than leaving it behind. */
  function sentenceAt(ranges, pos) {
    for (var i = 0; i < ranges.length; i++) {
      if (pos < ranges[i][1]) return i;
    }
    return ranges.length - 1;
  }

  /* Wrap character ranges of a subtree's text in spans, leaving whatever
     markup is already in there alone — the tinted source line has spans of
     its own and this must not disturb them. Text nodes are collected before
     any splitting starts, because splitting one invalidates a live walker. */
  function wrapRanges(root, ranges, cur) {
    var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
    var nodes = [], n;
    while ((n = walker.nextNode())) nodes.push(n);
    var made = [], at = 0;
    for (var i = 0; i < nodes.length; i++) {
      var node = nodes[i], len = node.nodeValue.length, from = at;
      at += len;
      if (!len) continue;
      var frag = document.createDocumentFragment(), taken = 0, touched = false;
      for (var r = 0; r < ranges.length; r++) {
        var a = Math.max(ranges[r][0], from), b = Math.min(ranges[r][1], from + len);
        if (b <= a) continue;
        if (a - from > taken) frag.appendChild(document.createTextNode(node.nodeValue.slice(taken, a - from)));
        var span = document.createElement('span');
        span.className = 'sn' + (r === cur ? ' cur' : '');
        span.appendChild(document.createTextNode(node.nodeValue.slice(a - from, b - from)));
        frag.appendChild(span);
        made.push(span);
        taken = b - from;
        touched = true;
      }
      if (!touched) continue;
      if (taken < len) frag.appendChild(document.createTextNode(node.nodeValue.slice(taken)));
      node.parentNode.replaceChild(frag, node);
    }
    return made;
  }

  function unwrapAll(spans) {
    var parents = [];
    for (var i = 0; i < spans.length; i++) {
      var s = spans[i], p = s.parentNode;
      if (!p) continue;
      p.replaceChild(document.createTextNode(s.textContent), s);
      if (parents.indexOf(p) === -1) parents.push(p);
    }
    for (var j = 0; j < parents.length; j++) parents[j].normalize();
  }

  function focusSentence() { return state.focus && state.focusLevel === 'sentence'; }

  /* ---------------- sentence focus, the two places it can happen ----------
     Both come down to the same constraint: to dim text you have to dim the
     element that draws it, and you cannot dim part of a textarea. So wherever
     the caret is, the text under it is drawn by something else and the
     textarea is made transparent over the top — which is exactly the trick
     #hl and #src already use for the source pane, applied twice more.

     Where there is no caret in the text at all — live view with no block open
     — sentence focus falls back to lighting the paragraph. No caret, no
     sentence, and inventing one would light a sentence the writer is not in. */

  /* Live view: a mirror of the open block's textarea, behind it. */
  function paintBlockSentences() {
    var ed = state.editing;
    if (!ed || !ed.node) return;
    var hl = ed.node.querySelector('.blk-hl');
    if (!focusSentence() || state.mode !== 'live') {
      if (hl && hl.parentNode) hl.parentNode.removeChild(hl);
      return;
    }
    if (!hl) {
      hl = document.createElement('div');
      hl.className = 'blk-hl';
      hl.setAttribute('aria-hidden', 'true');
      ed.node.insertBefore(hl, ed.ta);
    }
    var v = ed.ta.value;
    var rs = sentences(v), at = sentenceAt(rs, ed.ta.selectionStart || 0);
    var out = '';
    for (var i = 0; i < rs.length; i++) {
      out += '<span class="sn' + (i === at ? ' cur' : '') + '">' +
             esc(v.slice(rs[i][0], rs[i][1])) + '</span>';
    }
    /* pre-wrap gives a trailing newline no line box of its own, but a textarea
       shows the empty line it makes. One more newline puts it back. */
    hl.innerHTML = out + (v.slice(-1) === '\n' ? '\n' : '');

    /* Measured off the textarea rather than declared in CSS. The block has a
       negative-margin bleed for its hover background, so `left: 0` inside it
       lands on the padding box and not on the field — and even if that were
       corrected once, it would be a second place holding the same number,
       waiting to disagree with the first. */
    hl.style.left = ed.ta.offsetLeft + 'px';
    hl.style.top = ed.ta.offsetTop + 'px';
    hl.style.width = ed.ta.offsetWidth + 'px';
    /* min-height rather than height, and it is not the same thing. autosize
       sets the field's height from its scrollHeight after setting height to
       'auto', and a textarea at 'auto' is two rows tall regardless of what is
       in it — so an open block holding one line is a line taller than its
       text. The mirror has to fill the same box or the background behind the
       last line goes missing. min-height matches it without ever being able
       to clip, which a fixed height could if the two ever disagreed. */
    hl.style.minHeight = ed.ta.offsetHeight + 'px';
  }

  /* Split view: inside the tinted line the caret is on. */
  var lineSpans = [];
  function paintLineSentences() {
    if (lineSpans.length) { unwrapAll(lineSpans); lineSpans = []; }
    if (!focusSentence() || state.mode !== 'split') return;
    var line = el.hl.querySelector('.ln.cur');
    if (!line) return;
    var rs = sentences(line.textContent);
    if (rs.length < 2) return;              /* one sentence is the whole line */
    var caret = el.src.selectionStart || 0;
    var lineStart = el.src.value.lastIndexOf('\n', Math.max(0, caret - 1)) + 1;
    lineSpans = wrapRanges(line, rs, sentenceAt(rs, caret - lineStart));
  }

  function mapRenderedToSource(src, target) {
    var content = 0, i = 0, n = src.length;
    while (i < n && content < target) {
      var atLineStart = (i === 0 || src[i - 1] === '\n');
      if (atLineStart) {
        var m = /^[ \t]*(?:#{1,6}[ \t]+|>[ \t]?|(?:[-*+]|\d+[.)])[ \t]+(?:\[[ xX]\][ \t]+)?)/.exec(src.slice(i));
        if (m && m[0].length) { i += m[0].length; continue; }
      }
      var ch = src[i];
      if (ch === '\\') { i += 2; content++; continue; }
      if (ch === '(' && i > 0 && src[i - 1] === ']') {
        var close = src.indexOf(')', i); i = close === -1 ? n : close + 1; continue;
      }
      if (ch === '*' || ch === '_' || ch === '`' || ch === '~' || ch === '[' || ch === ']' || ch === '!') { i++; continue; }
      i++; content++;
    }
    return i;
  }

  /* ---------------- live block editing ---------------- */
  /* same collapse-and-restore care as autosizeSrc, one pane over */
  /* Zero rather than auto, and that is the whole fix for a block that sat one
     line taller than its text. `height: auto` on a textarea does not mean "as
     tall as the content" — it means as tall as the `rows` attribute, which
     defaults to 2. scrollHeight measured in that state can never come back
     smaller than two rows, so every one-line paragraph opened into a two-line
     field. At height 0 there is no floor to clear, and scrollHeight is the
     content plus the padding, which under border-box is exactly the height to
     set. */
  function autosize(ta) {
    var keep = el.prevPane.scrollTop;
    ta.style.height = '0px';
    ta.style.height = (ta.scrollHeight + 2) + 'px';
    if (ta.scrollTop !== 0) ta.scrollTop = 0;
    if (el.prevPane.scrollTop !== keep) setScroll('prev', keep);
  }

  /* index of the block the last commit removed for being empty, else -1.
     Removing it renumbers everything below, so an index captured before the
     commit points one block too far down and must be corrected. */
  var lastDropped = -1;

  /* Where the caret stood when the last block closed. The palette commits
     the open block before it reads the document, so a command run from it
     would otherwise have no caret left to work from. */
  var lastCaret = 0;

  function commitEditing(silent) {
    var ed = state.editing;
    if (!ed) { lastDropped = -1; return false; }
    state.editing = null;
    var value = ed.ta.value, i = ed.i;
    lastCaret = ed.ta.selectionStart || 0;
    var parts = splitBlocks(value);
    var drop = value.trim() === '' && state.blocks.length > 1;
    lastDropped = drop ? i : -1;
    state.lastBlock = drop && i > 0 ? i - 1 : i;
    /* Compare the document before and after rather than the block against
       its parts. joinBlocks normalises runs of blank lines, so a change
       that normalised away read as "unchanged" and never marked the file
       dirty — the edit was then dropped on quit. */
    var before = state.text;
    state.text = drop ? emptyBlockText(i) : spliceBlock(i, 1, value);
    el.src.value = state.text;
    paintSource(); renderDoc(true); updateStatus();
    if (state.text !== before && !silent) markDirty(true);
    undoBreak();
    return true;
  }

  /* Publish a block list that may contain an empty block and put the caret in
     block `focus`. renderDoc is told to keep the list as given, because
     re-deriving it from state.text would silently delete the empty block. */
  function applyBlocks(next, focus, text) {
    undoMark(true);            /* read while the open block still holds the old text */
    state.editing = null;
    var before = state.text;
    state.blocks = next.length ? next : [''];
    state.text = text == null ? joinBlocks(state.blocks) : text;
    el.src.value = state.text;
    paintSource(); renderDoc(true, true); updateStatus();
    /* Opening an empty block changes the block list but not a byte of the
       document, and marking dirty here made autosave write the file for a
       click that typed nothing. Dirty follows the text, not the scaffolding. */
    if (state.text !== before) markDirty(true);
    editBlock(focus, 0, true);
  }

  /* swap block i for the given sequence and open the last of them */
  function replaceBlock(i, parts) {
    /* every empty part is editing state, not content — including a leading
       one, which joinBlocks would otherwise write out as two blank lines */
    var text = spliceBlock(i, 1, parts.filter(function (b) { return b !== ''; }).join('\n\n'));
    var nb = state.blocks.slice();
    nb.splice.apply(nb, [i, 1].concat(parts));
    applyBlocks(nb, i + parts.length - 1, text);
  }

  function insertEmptyBlockAt(at) {
    at = Math.max(0, Math.min(state.blocks.length, at));
    var nb = state.blocks.slice();
    nb.splice(at, 0, '');
    /* an empty block is nothing at all in markdown, so the text is unchanged */
    applyBlocks(nb, at, state.text);
  }

  function editBlock(i, caret, scrollIntoView) {
    if (state.mode !== 'live') return;
    if (state.editing && state.editing.i === i) return;
    commitEditing();
    if (lastDropped >= 0 && i > lastDropped) i--;
    i = Math.max(0, Math.min(state.blocks.length - 1, i));
    var node = el.doc.children[i];
    if (!node) return;
    var src = state.blocks[i];

    node.classList.add('editing');
    node.innerHTML = '';
    var ta = document.createElement('textarea');
    /* One row, so nothing about this field's natural size can floor the
       measurement autosize takes a line later. */
    ta.className = 'blk-edit'; ta.rows = 1; ta.spellcheck = true; ta.value = src;
    node.appendChild(ta);
    autosize(ta);
    state.editing = { node: node, ta: ta, i: i };
    state.lastBlock = i;

    ta.addEventListener('beforeinput', undoBeforeInput);
    ta.addEventListener('input', function () {
      autosize(ta); markDirty(true);
      paintBlockSentences();
      if (state.typewriter) typewriterLive();
    });
    ta.addEventListener('blur', function () {
      setTimeout(function () { if (state.editing && state.editing.ta === ta) commitEditing(); }, 0);
    });
    ta.addEventListener('keydown', liveKeydown);
    ta.addEventListener('click', undoBreak);
    ta.addEventListener('paste', onPaste);
    /* keyup rather than keydown: the caret has not moved yet when the key
       goes down, so a mirror painted then is one keystroke behind. */
    ta.addEventListener('keyup', paintBlockSentences);
    ta.addEventListener('click', paintBlockSentences);
    ta.addEventListener('select', paintBlockSentences);

    ta.focus();
    var p = caret == null ? src.length : Math.max(0, Math.min(src.length, caret));
    ta.setSelectionRange(p, p);
    if (scrollIntoView) node.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    markCurrentBlock();
    paintBlockSentences();
    updateCaretStatus();
    undoBreak();
    if (state.typewriter) typewriterLive();
  }

  function liveKeydown(e) {
    var ed = state.editing; if (!ed) return;
    if (NAV_KEYS.test(e.key)) undoBreak();
    var ta = ed.ta, v = ta.value, s = ta.selectionStart, t = ta.selectionEnd;

    if (e.key === 'Escape') { e.preventDefault(); commitEditing(); return; }

    if (e.key === 'Tab') { e.preventDefault(); handleTab(ta, e.shiftKey); return; }

    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      var i0 = ed.i; commitEditing();
      /* if the block we just left was empty it has gone, and its slot is
         already where the new one belongs */
      insertEmptyBlockAt(lastDropped >= 0 ? i0 : i0 + 1);
      return;
    }

    if (e.key === 'Enter' && !e.shiftKey && s === t) {
      var kind = blockKind(v);
      if (kind === 'list' || kind === 'quote') {
        var r = continueList(ta, e);
        /* the writer ended the list on an empty marker at the foot of the
           block — carry them into a new paragraph rather than leaving the
           caret inside the list, where the next words become a lazy
           continuation of the final item */
        if (r === 'end') { replaceBlock(ed.i, [ta.value.replace(/\n+$/, ''), '']); return; }
        if (r) return;
      }
      if (kind === 'para' || kind === 'heading') {
        e.preventDefault();
        replaceBlock(ed.i, [v.slice(0, s), v.slice(s)]);
        return;
      }
    }

    if (e.key === 'ArrowUp' && s === t && v.lastIndexOf('\n', Math.max(0, s - 1)) === -1) {
      if (ed.i > 0) { e.preventDefault(); editBlock(ed.i - 1, null, true); }
      return;
    }
    if (e.key === 'ArrowDown' && s === t && v.indexOf('\n', s) === -1) {
      if (ed.i < state.blocks.length - 1) { e.preventDefault(); editBlock(ed.i + 1, 0, true); }
      return;
    }
    if (e.key === 'Backspace' && s === 0 && t === 0 && ed.i > 0) {
      e.preventDefault();
      undoMark(true);
      var i2 = ed.i, tail = v;
      var prev = state.blocks[i2 - 1];
      state.text = spliceBlock(i2 - 1, 2, tail.trim() === '' ? prev : (prev + '\n' + tail));
      state.editing = null;
      el.src.value = state.text;
      paintSource(); renderDoc(true); updateStatus(); markDirty(true);
      editBlock(i2 - 1, prev.length, true);
      return;
    }
    if (wrapOnType(ta, e)) return;
  }

  /* Where the pointer went down. A drag that begins inside an open block
     belongs to that block's textarea for as long as it lasts, including after
     the pointer has left it — which is exactly what selecting upwards does the
     moment it reaches the top edge. Neither handler below can work that out
     from the event it is given: a textarea's selection is not part of the
     document selection, so window.getSelection() reports "collapsed", the
     guard that asks it waves the drag through, and the block is committed and
     rebuilt underneath the selection being made. */
  var downInEdit = false;
  document.addEventListener('pointerdown', function (e) {
    var t = e.target;
    downInEdit = !!(t && t.closest && t.closest('.blk-edit'));
  }, true);

  /* A wikilink was clicked: tell the shell, which owns the folder and is the
     only half that can say whether the file is there. Returns true when it
     handled the event, so the caller can stop.

     Held ⌘ is deliberately not special here the way it is for a web link.
     There is nothing else a wikilink could usefully do. */
  function followWiki(e) {
    var a = e.target && e.target.closest ? e.target.closest('a.wikilink') : null;
    var name = a && a.getAttribute('data-wiki');
    if (!name) return false;
    e.preventDefault();
    send('openWiki', { name: name });
    return true;
  }

  /* Live view catches this on mouseup, before the block it is in becomes a
     textarea. Split view has no such race and can use the click, which is
     what a link should answer to. */
  el.doc.addEventListener('click', function (e) {
    if (state.mode === 'live') return;
    var sel = window.getSelection();
    if (sel && !sel.isCollapsed) return;
    followWiki(e);
  });

  el.doc.addEventListener('mouseup', function (e) {
    if (state.mode !== 'live') return;
    if (downInEdit) return;
    if (e.target.closest('.blk-edit')) return;
    var sel = window.getSelection();
    if (sel && !sel.isCollapsed) return;
    /* Before the link rule below and before the block opens: a wikilink is
       for following, and in live view the block would otherwise be turned
       into a textarea by the same click, taking the link with it. */
    if (followWiki(e)) return;
    if (e.target.tagName === 'A') { if (e.metaKey) return; e.preventDefault(); }
    if (e.target.tagName === 'INPUT') return;

    var blk = e.target.closest('.blk');
    if (!blk) { clickedPastBlocks(e); return; }
    var i = parseInt(blk.dataset.i, 10), caret = null;
    try {
      var r = document.caretRangeFromPoint(e.clientX, e.clientY);
      if (r && blk.contains(r.startContainer)) {
        var pre = document.createRange();
        pre.selectNodeContents(blk); pre.setEnd(r.startContainer, r.startOffset);
        caret = mapRenderedToSource(state.blocks[i], pre.toString().replace(/^\s+/, '').length);
      }
    } catch (err) {}
    editBlock(i, caret, false);
  });

  /* Clicks in the pane's own box — the gutters either side of the measure,
     the space above the first block — never reached the handler above,
     because that one is bound to #doc. */
  el.prevPane.addEventListener('mouseup', function (e) {
    if (state.mode !== 'live') return;
    if (downInEdit) return;
    if (e.target !== el.prevPane && e.target !== el.doc) return;
    var sel = window.getSelection();
    if (sel && !sel.isCollapsed) return;
    clickedPastBlocks(e);
  });

  /* A click that misses every block means one of two things. Below the last
     block the writer is reaching for room to carry on, so hand them a fresh
     paragraph. Anywhere else they are stepping away from the text, so commit
     and release the caret rather than yanking them to the foot of the
     document, which is what this used to do in both cases. */
  function clickedPastBlocks(e) {
    var kids = el.doc.children, last = kids[kids.length - 1];
    var below = !!last && e.clientY > last.getBoundingClientRect().bottom;
    commitEditing();
    if (!below) {
      if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
      markCurrentBlock();
      return;
    }
    var n = state.blocks.length;
    /* never stack a second empty paragraph on top of an existing one */
    if (!String(state.blocks[n - 1] || '').trim()) editBlock(n - 1, null, false);
    else insertEmptyBlockAt(n);
  }

  /* ---------------- selection across rendered blocks ----------------
     Only the block being written in is a field. Every other one is ordinary
     rendered HTML, so a selection that spans them belongs to the document and
     nothing was listening for it: Backspace did nothing, typing did nothing,
     and ⌘C handed over the rendered text rather than the markdown behind it.
     Everything below maps such a selection back onto state.text and edits the
     document itself, which is the only place a cross-block edit can happen. */

  /* One end of a selection, as a block index and an offset into that block's
     markdown. Rendered offsets and source offsets are different things —
     '**bold**' is eight characters of source and four of text — which is what
     mapRenderedToSource is for; it is the same walk the click-to-caret path
     already does, so the two agree by construction. */
  function blkPoint(node, offset) {
    var host = node && (node.nodeType === 1 ? node : node.parentNode);
    var blk = host && host.closest ? host.closest('.blk') : null;
    if (!blk || !el.doc.contains(blk)) return null;
    var i = parseInt(blk.dataset.i, 10);
    if (!(i >= 0) || state.blocks[i] == null) return null;
    var pre = document.createRange();
    pre.selectNodeContents(blk);
    try { pre.setEnd(node, offset); } catch (err) { return null; }
    return { i: i, off: mapRenderedToSource(state.blocks[i], pre.toString().replace(/^\s+/, '').length) };
  }

  /* What the current selection covers, in state.text offsets, or null when
     there is nothing here to act on — a caret rather than a selection, a
     selection inside a field that owns it already, or the source view, where
     the textarea does all of this itself. */
  function renderedRange() {
    if (state.mode !== 'live' || state.editing) return null;
    var sel = window.getSelection();
    if (!sel || !sel.rangeCount || sel.isCollapsed) return null;
    var r = sel.getRangeAt(0);
    var a = blkPoint(r.startContainer, r.startOffset);
    var b = blkPoint(r.endContainer, r.endOffset);
    if (!a || !b) return null;
    var spans = blockSpans();
    if (!spans[a.i] || !spans[b.i]) return null;
    var from = spans[a.i][0] + a.off, to = spans[b.i][0] + b.off;
    if (to < from) { var t = from; from = to; to = t; }
    return from === to ? null : { from: from, to: to };
  }

  /* Whole blocks taken out leave a separator behind on each side, so the two
     halves meet across a run of blank lines rather than the single gap the
     writer would expect, and at either end of the document across a gap with
     nothing on the far side of it at all. Only a run that is purely newlines
     is touched: anything else is the writer's own indentation, and squaring
     that up is not this function's business. */
  function collapseSeam(text, at) {
    var a = at, b = at;
    while (a > 0 && text[a - 1] === '\n') a--;
    while (b < text.length && text[b] === '\n') b++;
    if (b - a < 3) return { text: text, at: at };
    var edge = (a === 0 || b === text.length);
    return {
      text: text.slice(0, a) + (edge ? '' : '\n\n') + text.slice(b),
      at: a + (edge ? 0 : 2)
    };
  }

  /* Replace everything the selection covers with `insert` and leave the writer
     in the block where the two halves met, caret at the join. Returns false
     when there was no such selection, so callers can fall through to whatever
     they would otherwise have done. */
  function replaceRendered(insert) {
    var r = renderedRange();
    if (!r) return false;
    undoMark(true);
    var joined = collapseSeam(state.text.slice(0, r.from) + insert + state.text.slice(r.to),
                              r.from + insert.length);
    var sel = window.getSelection();
    if (sel) sel.removeAllRanges();
    state.text = joined.text;
    el.src.value = state.text;
    paintSource(); renderDoc(true); updateStatus(); markDirty(true);
    var i = blockIndexForOffset(joined.at);
    var span = blockSpans()[i];
    editBlock(i, span ? joined.at - span[0] : null, false);
    return true;
  }

  /* Anything with a modifier on it already belongs to somebody — the shortcut
     map in ui.js, the find bar, the command palette — and so does anything
     typed while a field has focus. What is left is the plain typing and
     deleting a writer would expect to land on the text they have highlighted. */
  document.addEventListener('keydown', function (e) {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    var t = document.activeElement;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    if (!renderedRange()) return;
    if (e.key === 'Backspace' || e.key === 'Delete') { e.preventDefault(); replaceRendered(''); return; }
    if (e.key === 'Enter') { e.preventDefault(); replaceRendered('\n\n'); return; }
    /* one character is a printable key; 'Shift', 'ArrowUp' and 'Process' are
       not, and neither is anything an input method is still composing */
    if (e.key.length === 1) { e.preventDefault(); replaceRendered(e.key); }
  });

  /* The clipboard should carry what the document says, not what it looks
     like. Copying rendered text meant pasting a heading back in as a plain
     line and a list back in as a run of sentences. */
  document.addEventListener('copy', function (e) {
    var r = renderedRange();
    if (!r || !e.clipboardData) return;
    e.preventDefault();
    e.clipboardData.setData('text/plain', state.text.slice(r.from, r.to));
  });

  document.addEventListener('cut', function (e) {
    var r = renderedRange();
    if (!r || !e.clipboardData) return;
    e.preventDefault();
    e.clipboardData.setData('text/plain', state.text.slice(r.from, r.to));
    replaceRendered('');
  });

  /* Pasting over a rendered selection converts the same way onPaste does for
     a textarea, and has to, or the two paths disagree about what a paste from
     a browser turns into depending on where the caret happened to be. */
  document.addEventListener('paste', function (e) {
    if (!renderedRange() || !e.clipboardData) return;
    e.preventDefault();
    var plain = e.clipboardData.getData('text/plain') || '';
    var html = e.clipboardData.getData('text/html') || '';
    var insert = plain;
    if (html && /<(p|div|h[1-6]|ul|ol|li|table|blockquote|pre|strong|em|a)\b/i.test(html) && td()) {
      try { insert = td().turndown(html).trim(); } catch (err) { insert = plain; }
    }
    replaceRendered(insert);
  });

  /* ---------------- deleting a block ----------------
     A soft bin in the right-hand gutter of whichever block the pointer is
     over. One node that moves, rather than one per block: renderDoc tears
     down and rebuilds every block, and anything living inside a .blk would
     end up in the selection, in copied text, in exported HTML and in the
     character count mapRenderedToSource walks to place the caret. Out here in
     the pane's own box it is none of those things. */
  var bin = document.createElement('button');
  var binFor = -1;
  bin.id = 'blkBin';
  bin.type = 'button';
  bin.tabIndex = -1;
  bin.title = 'Delete this paragraph';
  bin.setAttribute('aria-label', 'Delete this paragraph');
  bin.innerHTML = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.35" ' +
                  'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
                  '<path d="M2.9 4.4h10.2M6.4 4.4V2.9h3.2v1.5M4.4 4.4l.55 8.05a1 1 0 0 0 1 .95h4.1a1 1 0 0 0 1-.95L11.6 4.4"/>' +
                  '<path d="M6.7 6.8v4.2M9.3 6.8v4.2"/></svg>';
  el.prevPane.appendChild(bin);

  function hideBin() { binFor = -1; if (bin) bin.classList.remove('on'); }

  function showBinOn(blk) {
    var i = parseInt(blk.dataset.i, 10);
    /* nothing to delete a document down to nothing with, and never over the
       block being written in, where the caret is the thing under the pointer */
    if (!(i >= 0) || state.blocks.length < 2 || (state.editing && state.editing.i === i)) return hideBin();
    binFor = i;
    /* .blk is positioned, #doc is not, so both of these are already in the
       pane's coordinates — the same ones the bin is placed in */
    var want = blk.offsetLeft + blk.offsetWidth + 12;
    var room = el.prevPane.clientWidth - bin.offsetWidth - 8;
    bin.style.left = Math.max(0, Math.min(want, room)) + 'px';
    bin.style.top = blk.offsetTop + 'px';
    bin.classList.add('on');
  }

  el.doc.addEventListener('mouseover', function (e) {
    if (state.mode !== 'live') return hideBin();
    var blk = e.target.closest ? e.target.closest('.blk') : null;
    if (blk) showBinOn(blk);
    /* and no else. Leaving a block for the gutter must not take the bin with
       it, because the gutter is precisely where the writer is reaching. */
  });
  el.prevPane.addEventListener('mouseleave', hideBin);

  /* Keep the focus where it is: without this the open block blurs on the way
     down, commits on a timer, and the click lands after the renumbering. */
  bin.addEventListener('mousedown', function (e) { e.preventDefault(); });

  bin.addEventListener('click', function (e) {
    e.preventDefault(); e.stopPropagation();
    var i = binFor;
    if (i < 0) return;
    /* a block open elsewhere still holds text state.text has not been told
       about, and committing it can drop an empty one, which renumbers
       everything below it */
    if (commitEditing() && lastDropped >= 0 && i > lastDropped) i--;
    if (i < 0 || i >= state.blocks.length || state.blocks.length < 2) { hideBin(); return; }
    undoMark(true);
    state.text = dropBlockText(i);
    el.src.value = state.text;
    hideBin();
    paintSource(); renderDoc(true); updateStatus(); markDirty(true);
    undoBreak();
  });

  /* ---------------- smart editing helpers ---------------- */
  /* ---------------- undo ----------------
     WebKit's own undo stack cannot serve this editor. Assigning to a
     textarea's .value throws the stack away, and every formatting command,
     tab, list continuation and markdown paste does exactly that; in live view
     the textarea holding the stack is destroyed the moment the caret leaves
     the block, so nothing survives a block boundary either. The document
     therefore keeps its own stack, in document offsets rather than per-field,
     and both views restore into it. */
  var undoStack = [], redoStack = [], undoAt = 0, undoStepAt = 0, undoBusy = false;
  var UNDO_LIMIT = 500;
  var UNDO_COALESCE = 550;    /* a pause this long ends the current step */
  var UNDO_STEP_MAX = 4000;   /* …and no step swallows more than this much typing */

  /* state.text lags behind an open block, so both the text and the caret have
     to be read through the block's span rather than off state.text directly */
  function undoSnapshot() {
    var ed = state.editing;
    if (!ed) {
      return {
        text: state.text,
        sel: state.mode === 'split'
          ? { start: el.src.selectionStart || 0, end: el.src.selectionEnd || 0 }
          : null
      };
    }
    var edit = blockEdit(ed.i, ed.ta.value);
    return {
      text: edit.text,
      sel: { start: edit.at + (ed.ta.selectionStart || 0), end: edit.at + (ed.ta.selectionEnd || 0) }
    };
  }

  /* Record where the document stands *before* a change lands. Keystrokes
     inside the coalesce window fold into the one entry, which is what makes
     ⌘Z take back a word rather than a letter. */
  function undoMark(force) {
    if (undoBusy) return;
    var now = Date.now(), top = undoStack[undoStack.length - 1];
    var open = top && now - undoAt < UNDO_COALESCE && now - undoStepAt < UNDO_STEP_MAX;
    undoAt = now;
    if (!force && open) return;
    var snap = undoSnapshot();
    if (top && top.text === snap.text) { if (!open) undoStepAt = now; return; }
    undoStack.push(snap);
    if (undoStack.length > UNDO_LIMIT) undoStack.shift();
    redoStack.length = 0;
    undoStepAt = now;
  }

  function undoReset() { undoStack.length = 0; redoStack.length = 0; undoAt = 0; undoStepAt = 0; }

  /* End the open step without recording anything. Moving the caret, leaving a
     block or switching view all mean the next keystroke belongs to a new step,
     however fast it follows the last one. */
  function undoBreak() { undoAt = 0; undoStepAt = 0; }

  /* where two versions of the document part company — the caret belongs there
     when the step being applied carries no recorded selection of its own */
  function firstDiff(a, b) {
    a = String(a); b = String(b);
    var n = Math.min(a.length, b.length), i = 0;
    while (i < n && a.charCodeAt(i) === b.charCodeAt(i)) i++;
    return i;
  }

  function undoApply(snap, from) {
    undoBusy = true;
    state.editing = null;       /* whatever block is open is about to be rebuilt */
    setText(snap.text, { immediate: true });
    var sel = snap.sel;
    if (!sel) {
      var at = Math.min(firstDiff(from, snap.text), snap.text.length);
      sel = { start: at, end: at };
    }
    if (state.mode === 'split') {
      el.src.focus();
      el.src.setSelectionRange(sel.start, sel.end);
      markCurrentLine(); markCurrentBlock(); updateCaretStatus(); followCaret();
    } else {
      var bi = blockIndexForOffset(sel.start);
      editBlock(bi, sel.start - (blockStartOffsets()[bi] || 0), true);
    }
    undoBusy = false;
    undoAt = 0; undoStepAt = 0;  /* the next keystroke opens a fresh step */
  }

  function undo() {
    var cur = undoSnapshot();
    /* a step that matches the present is a no-op — drop it and take the one
       underneath, or ⌘Z appears to do nothing */
    while (undoStack.length && undoStack[undoStack.length - 1].text === cur.text) undoStack.pop();
    if (!undoStack.length) return false;
    redoStack.push(cur);
    undoApply(undoStack.pop(), cur.text);
    return true;
  }

  function redo() {
    if (!redoStack.length) return false;
    var cur = undoSnapshot();
    undoStack.push(cur);
    undoApply(redoStack.pop(), cur.text);
    return true;
  }

  /* Typing and deleting build one step; anything structural gets its own. */
  function undoBeforeInput(e) {
    var t = (e && e.inputType) || '';
    undoMark(t !== 'insertText' && t !== 'insertCompositionText' &&
             t !== 'deleteContentBackward' && t !== 'deleteContentForward');
  }

  function replaceRange(ta, from, to, text, selStart, selEnd) {
    var v = ta.value;
    undoMark(true);
    ta.value = v.slice(0, from) + text + v.slice(to);
    var a = selStart == null ? from + text.length : selStart;
    var b = selEnd == null ? a : selEnd;
    ta.setSelectionRange(a, b);
    pushChange(ta);
  }

  function pushChange(ta) {
    if (ta === el.src) { setText(ta.value, { fromSource: true }); }
    else { autosize(ta); markDirty(true); }
  }

  /* ---------------- editor sessions ----------------
     One window, several documents open at once. A session is everything that
     makes a document feel like where you left it: its text, both undo stacks,
     where each pane was scrolled to, and the caret. The tab strip in ui.js
     decides which one is on screen; this decides what one *is*.

     The shell holds the tab list, the paths and the dirty flags, because it
     owns the files. It deliberately does not hold the text of a background
     document: shipping a 500-entry undo stack across the bridge on every tab
     switch would cost megabytes for something neither side needs to persist.
     So the sessions live here, in the page, and the two halves meet at an id.

     Version history is not part of a session and does not need to be. The
     store is keyed by folder + filename, so it already follows the document
     rather than the tab; a swap only has to pin and bank the outgoing one
     before its key changes, which is what loadDoc has always done. */

  function sessionCapture() {
    commitEditing(true);
    return {
      text: docText(),
      fileName: state.fileName,
      docDir: state.docDir,
      dirty: state.dirty,
      savedAt: state.savedAt,
      /* Travels with the tab: an unwritable file is a property of the
         document, not of which one happens to be on screen. */
      saveTrouble: state.saveTrouble,
      /* Copies. The live stacks are mutated in place by every keystroke, so
         handing over the arrays themselves would leave a parked session
         growing along with the one on screen. */
      undo: undoStack.slice(),
      redo: redoStack.slice(),
      scrollSrc: el.srcScroll.scrollTop,
      scrollPrev: el.prevPane.scrollTop,
      /* so focus mode lights the paragraph you left this tab in, rather than
         the first one, when you come back to it */
      lastBlock: state.lastBlock,
      sel: state.mode === 'split'
        ? { start: el.src.selectionStart || 0, end: el.src.selectionEnd || 0 }
        : null
    };
  }

  function sessionBlank(name, dir, text) {
    return {
      text: text || '', fileName: name || 'Untitled.md', docDir: dir || '',
      dirty: false, savedAt: null, saveTrouble: null, undo: [], redo: [],
      scrollSrc: 0, scrollPrev: 0, sel: null, lastBlock: 0
    };
  }

  /* Put a session on screen. `opts.fresh` is for a document arriving from
     disk rather than coming back from another tab: it drops the undo history
     and takes a baseline snapshot, which is what loadDoc used to do inline. */
  function sessionRestore(s, opts) {
    opts = opts || {};
    commitEditing(true);

    /* Bank the outgoing document while its key is still the current one.
       histKey() is built from docDir and fileName, both of which are about to
       change, so a snapshot taken after this point would file the last edits
       of the document being left under the name of the one arriving. */
    histSnapshot(true);
    histFlush();

    state.docDir = s.docDir || '';
    state.fileName = s.fileName || 'Untitled.md';
    state.savedAt = s.savedAt || null;
    state.saveTrouble = s.saveTrouble || null;

    setText(s.text || '', { immediate: true, markDirty: false });
    state.lastBlock = s.lastBlock || 0;

    /* Set, not marked. The shell already knows this tab's dirty state — it is
       what it just told us — so routing it back through markDirty would post
       a `dirty` message describing a change that never happened. */
    state.dirty = !!s.dirty;
    el.body.classList.toggle('dirty', state.dirty);

    undoStack.length = 0;
    redoStack.length = 0;
    if (!opts.fresh) {
      Array.prototype.push.apply(undoStack, s.undo || []);
      Array.prototype.push.apply(redoStack, s.redo || []);
    }
    undoAt = 0; undoStepAt = 0;

    invalidateAnchors();
    updateStatus();
    staggerBlocks();

    /* Scroll and caret after the frame. The panes have not grown to the new
       document's height yet, so a write now is clamped by whatever the old
       document's scrollHeight allowed — which, for a short document arriving
       after a long one, is nothing. */
    var sel = s.sel;
    requestAnimationFrame(function () {
      autosizeSrc();
      setScroll('prev', s.scrollPrev || 0);
      setScroll('src', s.scrollSrc || 0);
      if (state.mode === 'split') {
        el.src.focus();
        el.src.setSelectionRange(sel ? sel.start : 0, sel ? sel.end : 0);
      }
    });

    /* The document as it stands is the baseline for its history. Harmless on
       a tab that already has one: histSnapshot returns early when the text
       matches the head it is already holding. */
    histSnapshot(true);
  }

  var LIST_RE = /^(\s*)(?:([-*+])|(\d+)([.)]))(\s+)(\[[ xX]\]\s+)?(.*)$/;
  var QUOTE_RE = /^(\s*)(>+)(\s?)(.*)$/;

  function continueList(ta, e) {
    var v = ta.value, s = ta.selectionStart;
    var ls = v.lastIndexOf('\n', s - 1) + 1;
    var le = v.indexOf('\n', s); if (le === -1) le = v.length;
    var line = v.slice(ls, le);

    var m = LIST_RE.exec(line);
    if (m) {
      var body = m[7], task = m[6];
      if (!body.trim() && s >= le) {
        e.preventDefault(); replaceRange(ta, ls, le, '');
        /* an empty marker on the last line means "I am done with this list" */
        return le >= v.length ? 'end' : true;
      }
      var marker = m[2] ? m[2] : (parseInt(m[3], 10) + 1) + m[4];
      e.preventDefault();
      var ins = '\n' + m[1] + marker + m[5] + (task ? task.replace(/\[[xX]\]/, '[ ]') : '');
      replaceRange(ta, s, ta.selectionEnd, ins);
      return true;
    }
    var q = QUOTE_RE.exec(line);
    if (q) {
      if (!q[4].trim() && s >= le) {
        e.preventDefault(); replaceRange(ta, ls, le, '');
        return le >= v.length ? 'end' : true;
      }
      e.preventDefault();
      replaceRange(ta, s, ta.selectionEnd, '\n' + q[1] + q[2] + (q[3] || ' '));
      return true;
    }
    return false;
  }

  function alignTable(text) {
    var lines = text.split('\n').filter(function (l) { return l.trim(); });
    var rows = lines.map(function (l) {
      var t = l.trim().replace(/^\|/, '').replace(/\|$/, '');
      return t.split('|').map(function (c) { return c.trim(); });
    });
    var cols = Math.max.apply(null, rows.map(function (r) { return r.length; }));
    var sepIdx = rows.findIndex(function (r) { return r.every(function (c) { return /^:?-{1,}:?$/.test(c); }); });
    var align = [];
    if (sepIdx > -1) {
      align = rows[sepIdx].map(function (c) {
        var l = c.startsWith(':'), r = c.endsWith(':');
        return l && r ? 'c' : r ? 'r' : 'l';
      });
    }
    var w = [];
    rows.forEach(function (r, ri) {
      if (ri === sepIdx) return;
      for (var c = 0; c < cols; c++) w[c] = Math.max(w[c] || 3, (r[c] || '').length);
    });
    function pad(s, n, a) {
      s = s || '';
      var gap = n - s.length;
      if (a === 'r') return new Array(gap + 1).join(' ') + s;
      if (a === 'c') { var L = Math.floor(gap / 2); return new Array(L + 1).join(' ') + s + new Array(gap - L + 1).join(' '); }
      return s + new Array(gap + 1).join(' ');
    }
    return rows.map(function (r, ri) {
      if (ri === sepIdx) {
        return '| ' + w.map(function (n, c) {
          var a = align[c] || 'l';
          var bar = new Array(n + 1).join('-');
          return a === 'c' ? ':' + bar.slice(2) + ':' : a === 'r' ? bar.slice(1) + ':' : bar;
        }).join(' | ') + ' |';
      }
      return '| ' + w.map(function (n, c) { return pad(r[c], n, align[c] || 'l'); }).join(' | ') + ' |';
    }).join('\n');
  }

  function handleTab(ta, shift) {
    var v = ta.value, s = ta.selectionStart, t = ta.selectionEnd;
    var ls = v.lastIndexOf('\n', s - 1) + 1;
    var le = v.indexOf('\n', t); if (le === -1) le = v.length;
    var chunk = v.slice(ls, le);

    if (/^\s*\|/.test(chunk.split('\n')[0])) {
      // grow the range to cover every contiguous table row
      var a = ls, b = le;
      while (a > 0) {
        var pStart = v.lastIndexOf('\n', a - 2) + 1;
        if (!/^\s*\|/.test(v.slice(pStart, a - 1))) break;
        a = pStart;
      }
      while (b < v.length) {
        var nEnd = v.indexOf('\n', b + 1); if (nEnd === -1) nEnd = v.length;
        if (!/^\s*\|/.test(v.slice(b + 1, nEnd))) break;
        b = nEnd;
      }
      var table = v.slice(a, b);
      var formatted = alignTable(table);
      if (formatted !== table) { replaceRange(ta, a, b, formatted, a + formatted.length); return; }
    }

    if (s !== t || LIST_RE.test(chunk.split('\n')[0])) {
      var lines = chunk.split('\n');
      var out = lines.map(function (l) {
        if (shift) return l.replace(/^ {1,2}|^\t/, '');
        return l.trim() === '' ? l : '  ' + l;
      }).join('\n');
      var delta = out.length - chunk.length;
      replaceRange(ta, ls, le, out, s + (shift ? Math.max(-2, delta) : 2), t + delta);
      return;
    }
    replaceRange(ta, s, t, '  ');
  }

  var PAIRS = { '*': '*', '_': '_', '`': '`', '"': '"', "'": "'", '(': ')', '[': ']', '{': '}' };
  function wrapOnType(ta, e) {
    if (e.metaKey || e.ctrlKey || e.altKey) return false;
    if (e.key.length !== 1 || !PAIRS[e.key]) return false;
    var s = ta.selectionStart, t = ta.selectionEnd;
    if (s === t) return false;
    e.preventDefault();
    var sel = ta.value.slice(s, t);
    replaceRange(ta, s, t, e.key + sel + PAIRS[e.key], s + 1, t + 1);
    return true;
  }

  /* ---------------- paste ---------------- */
  var turndown = null;
  function td() {
    if (!turndown && window.TurndownService) {
      turndown = new window.TurndownService({
        headingStyle: 'atx', bulletListMarker: '-', codeBlockStyle: 'fenced', emDelimiter: '*'
      });
      turndown.addRule('strike', {
        filter: ['del', 's'], replacement: function (c) { return '~~' + c + '~~'; }
      });
    }
    return turndown;
  }

  function onPaste(e) {
    var ta = e.target;
    if (!ta || ta.tagName !== 'TEXTAREA') return;
    var dt = e.clipboardData;
    if (!dt) return;

    if (dt.files && dt.files.length) {
      var f = dt.files[0];
      if (/^image\//.test(f.type)) {
        e.preventDefault();
        var reader = new FileReader();
        reader.onload = function () {
          var b64 = String(reader.result).split(',')[1] || '';
          var ext = (f.type.split('/')[1] || 'png').replace('jpeg', 'jpg');
          state.pasteTarget = ta;
          send('pasteImage', { data: b64, ext: ext });
          toast('Saving image…');
        };
        /* Without this a failed read was completely silent — not even the
           "Saving image…" toast appeared, so the paste looked ignored. */
        reader.onerror = function () { toast('Could not read that image'); };
        reader.readAsDataURL(f);
        return;
      }
    }

    var plain = dt.getData('text/plain') || '';
    var html = dt.getData('text/html') || '';
    var s = ta.selectionStart, t = ta.selectionEnd, sel = ta.value.slice(s, t);

    /* Remember a pasted URL so ⌘⇧K can drop it straight into the link.
       insertLink has always read state.lastURL, but nothing ever wrote it,
       so the link command produced an empty () every time. */
    if (/^(https?|mailto):\S+$/i.test(plain.trim())) state.lastURL = plain.trim();

    if (sel && /^(https?|mailto):\S+$/i.test(plain.trim())) {
      e.preventDefault();
      replaceRange(ta, s, t, '[' + sel + '](' + plain.trim() + ')');
      return;
    }

    if (html && /<(p|div|h[1-6]|ul|ol|li|table|blockquote|pre|strong|em|a)\b/i.test(html) && td()) {
      e.preventDefault();
      var mdText;
      try { mdText = td().turndown(html).trim(); } catch (err) { mdText = plain; }
      replaceRange(ta, s, t, mdText);
      toast('Pasted as markdown');
      return;
    }
  }

  el.src.addEventListener('paste', onPaste);

  /* ---------------- source pane ---------------- */
  /* The typewriter hold has to be applied in the same task that repainted the
     source, not in the keyup that follows it. keyup is a separate task, and
     the browser is free to paint between the two — one frame of the new text
     sitting at the old scroll position, then a snap. Holding the line here
     means the reflow and the correction land in the same frame. keyup still
     runs it for the keys that move the caret without producing input. */
  el.src.addEventListener('beforeinput', undoBeforeInput);
  el.src.addEventListener('input', function () {
    setText(el.src.value, { fromSource: true });
    updateCaretStatus();
    if (state.typewriter) typewriterSplit();
  });
  el.src.addEventListener('keyup', function () { updateCaretStatus(); markCurrentLine(); markCurrentBlock(); if (state.typewriter) typewriterSplit(); });
  el.src.addEventListener('click', function () { undoBreak(); updateCaretStatus(); markCurrentLine(); markCurrentBlock(); });
  el.src.addEventListener('scroll', function () { el.src.scrollTop = 0; });

  var NAV_KEYS = /^(Arrow(Up|Down|Left|Right)|Home|End|PageUp|PageDown)$/;
  el.src.addEventListener('keydown', function (e) {
    if (NAV_KEYS.test(e.key)) undoBreak();
    if (e.key === 'Tab') { e.preventDefault(); handleTab(el.src, e.shiftKey); return; }
    if (e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey && el.src.selectionStart === el.src.selectionEnd) {
      if (continueList(el.src, e)) return;
    }
    wrapOnType(el.src, e);
  });

  /* Either pane may drive; whichever one receives a scroll that is not the
     echo of our own write is the driver for that event. No timers, no hover
     gating, so a continuous gesture syncs on every frame and swapping panes
     mid-scroll is seamless. */
  el.srcScroll.addEventListener('scroll', function () {
    if (isEcho('src', el.srcScroll)) return;
    syncFrom('src');
  });

  el.prevPane.addEventListener('scroll', function () {
    if (MM.onPreviewScroll) MM.onPreviewScroll();

    if (state.scrollSaveT) clearTimeout(state.scrollSaveT);
    state.scrollSaveT = setTimeout(function () {
      var r = el.prevPane.scrollHeight - el.prevPane.clientHeight;
      send('pref', { key: 'scroll', value: r > 4 ? String(Math.round(el.prevPane.scrollTop / r * 1000)) : '0' });
    }, 600);

    if (isEcho('prev', el.prevPane)) return;
    syncFrom('prev');
  });

  window.addEventListener('resize', invalidateAnchors);

  /* Layout moves for reasons no event announces: the 320–480ms transitions on
     #doc's font-size / padding / max-width and #sourcePane's flex-grow, images
     decoding, web fonts settling, KaTeX and highlight.js arriving late. A
     ResizeObserver catches all of them, and fires on every intermediate frame
     of an animation, so a table built mid-transition is discarded rather than
     cached. These callbacks only set a flag — they never write to the DOM, so
     they cannot feed back into themselves. */
  if (window.ResizeObserver) {
    var roDirty = new ResizeObserver(invalidateAnchors);
    roDirty.observe(el.doc);
    roDirty.observe(el.prevPane);
    var inner = document.querySelector('.editor-inner');
    if (inner) roDirty.observe(inner);

    /* The source pane's width animates too, which rewraps every line. The
       textarea drives .editor-inner's height and only ever re-measured on
       window resize, so the pane kept its pre-animation height. Gated on
       width alone, so the height this writes can never re-trigger it. */
    var lastW = -1;
    var roWidth = new ResizeObserver(function (entries) {
      var w = Math.round(entries[0].contentRect.width);
      if (w === lastW) return;
      lastW = w;
      autosizeSrc();
      invalidateAnchors();
    });
    roWidth.observe(el.srcScroll);
  }

  /* an image finishes decoding after the render that measured its slot */
  document.addEventListener('load', function (e) {
    if (e.target && e.target.tagName === 'IMG') invalidateAnchors();
  }, true);

  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(invalidateAnchors).catch(function () {});
  }

  function followCaret() {
    var i = blockIndexForOffset(el.src.selectionStart || 0);
    var node = el.doc.children[i];
    if (!node) return;
    var pr = el.prevPane.getBoundingClientRect(), nr = node.getBoundingClientRect();
    if (nr.top < pr.top + 12 || nr.bottom > pr.bottom - 12) {
      setScroll('prev', el.prevPane.scrollTop + (nr.top - pr.top) - el.prevPane.clientHeight * 0.34);
    }
  }

  /* ---------------- typewriter ---------------- */
  /* Typewriter scrolling holds the caret's line at a fixed height. Two things
     made it shudder. It re-issued a *smooth* scroll on every keystroke, so
     each character interrupted and restarted the previous animation; and it
     measured the line against #hl's own box, forgetting that #hl is inset by
     the pane's top padding, so the target was always a padding's worth too
     high. Now it snaps, and only when the line has actually moved. */
  var twLine = -1;

  function typewriterSplit() {
    var n = currentLineIndex(), node = el.hl.children[n];
    if (!node) return;
    var y = el.hl.offsetTop + node.offsetTop;
    var max = Math.max(0, el.srcScroll.scrollHeight - el.srcScroll.clientHeight);
    var target = Math.max(0, Math.min(max, y - el.srcScroll.clientHeight * 0.42));
    twLine = n;
    /* typing inside a line leaves the line where it is; moving the page then
       would be movement the writer never asked for */
    if (Math.abs(el.srcScroll.scrollTop - target) < 2) return;
    el.srcScroll.scrollTop = target;
  }

  function typewriterLive() {
    if (!state.editing) return;
    var r = state.editing.node.getBoundingClientRect();
    var pr = el.prevPane.getBoundingClientRect();
    var max = Math.max(0, el.prevPane.scrollHeight - el.prevPane.clientHeight);
    var target = Math.max(0, Math.min(max,
      el.prevPane.scrollTop + (r.top - pr.top) - el.prevPane.clientHeight * 0.42));
    if (Math.abs(el.prevPane.scrollTop - target) < 2) return;
    el.prevPane.scrollTop = target;
  }

  /* ---------------- the chrome bar ----------------
     One bar with two homes. Live view sits it in the window's top-left
     corner; split view hangs it off the top edge, centred on the divider.
     The divider is measured rather than assumed, so if the split ever becomes
     draggable the bar follows it for free — but while the panes are
     mid-animation the divider has no width yet, and then the midpoint of the
     window is the honest answer.

     The native shell has to place the real NSWindow buttons inside the bar,
     so the same number goes over the bridge. Only when it changes: each post
     crosses into Swift and moves three buttons and a drag strip. */
  var barDivider = null, barBridged = '';

  function positionBar(animate) {
    var bar = $('#titlebar');
    if (!bar) return;
    if (!barDivider) barDivider = $('#divider');

    /* Measured, not read from the custom properties, because the two modes
       are different sizes and the stylesheet owns which one is in force.
       Nothing transitions width or height, so this is the final size the
       moment the mode attribute changes. */
    var w = bar.offsetWidth || 103, h = bar.offsetHeight || 32;
    var pad = parseFloat(getComputedStyle(document.documentElement)
                           .getPropertyValue('--bar-pad')) || 10;

    /* Split view normally hangs the bar off the middle of the top edge. While
       the tab strip is out that would put the three window buttons in the
       middle of a row of tabs, so the bar comes back to the corner for as
       long as the strip is showing and springs back to the divider when it
       goes. The transform is already spring-eased, so the move reads as the
       bar being drawn along by the strip rather than as a jump. */
    var x = 0;
    if (state.mode === 'split' && !el.body.classList.contains('tabs-open')) {
      var d = barDivider && barDivider.getBoundingClientRect();
      var centre = (d && d.width > 0) ? d.left + d.width / 2 : window.innerWidth / 2;
      x = Math.round(centre - w / 2);
    }
    x = Math.max(0, Math.min(x, Math.max(0, window.innerWidth - w)));

    if (!animate) bar.style.transition = 'none';
    document.documentElement.style.setProperty('--bar-x', x + 'px');
    if (!animate) requestAnimationFrame(function () { bar.style.transition = ''; });

    var sig = x + ':' + w + ':' + h;
    if (sig !== barBridged) { barBridged = sig; send('barX', { x: x + pad, w: w, h: h }); }
  }

  /* ---------------- mode switching ---------------- */
  function movePill(animate) {
    var btns = el.seg.querySelectorAll('button'), target = btns[0];
    btns.forEach(function (b) {
      var on = b.dataset.mode === state.mode;
      b.setAttribute('aria-selected', on ? 'true' : 'false');
      if (on) target = b;
    });
    if (!animate) el.pill.style.transition = 'none';
    el.pill.style.width = target.offsetWidth + 'px';
    el.pill.style.transform = 'translateX(' + (target.offsetLeft - 2) + 'px)';
    if (!animate) requestAnimationFrame(function () { el.pill.style.transition = ''; });
  }

  /* fill is 'backwards', not 'both', and the difference is the whole of focus
     mode working. 'backwards' holds the from-state through the delay, which is
     what stops a block flashing in before its turn. 'both' also holds the
     to-state afterwards, for ever — and a filled animation sits above the
     cascade, so every block came out of this pinned at opacity 1 and
     `body.focus .blk { opacity: .26 }` could never apply to it again. Since
     switching to live view is what runs this, focus mode did nothing at all
     in live view until something happened to rebuild the blocks. */
  function staggerBlocks() {
    Array.prototype.slice.call(el.doc.children, 0, 26).forEach(function (b, i) {
      try {
        b.animate([{ opacity: 0, transform: 'translateY(9px)' }, { opacity: 1, transform: 'none' }],
          { duration: 430, delay: Math.min(i * 24, 280), easing: 'cubic-bezier(.22,1,.36,1)', fill: 'backwards' });
      } catch (e) {}
    });
  }

  function runSweep() {
    el.sweep.classList.remove('run');
    void el.sweep.offsetWidth;
    el.sweep.classList.add('run');
  }

  function setMode(m, opts) {
    undoBreak();
    opts = opts || {};
    if (m !== 'split' && m !== 'live') return;
    var same = state.mode === m, prev = state.mode;
    var carryBlock = null, carryOffset = null;

    if (!same) {
      if (prev === 'split') {
        if (document.activeElement === el.src) carryBlock = blockIndexForOffset(el.src.selectionStart || 0);
      } else {
        if (state.editing) {
          carryBlock = state.editing.i;
          carryOffset = (blockStartOffsets()[state.editing.i] || 0) + (state.editing.ta.selectionStart || 0);
        }
        commitEditing(true);
      }
    }

    state.mode = m;
    el.body.dataset.mode = m;
    movePill(true);
    positionBar(true);
    send('pref', { key: 'mode', value: m });
    renderDoc(true);

    if (!same && opts.animate !== false) { runSweep(); staggerBlocks(); }

    if (m === 'live') {
      el.src.blur();
      if (carryBlock != null) setTimeout(function () { editBlock(carryBlock, null, true); }, 240);
    } else {
      if (carryOffset != null) { el.src.focus(); el.src.setSelectionRange(carryOffset, carryOffset); }
      requestAnimationFrame(function () { autosizeSrc(); followCaret(); markCurrentLine(); });
    }
    updateStatus();
  }

  el.seg.addEventListener('click', function (e) {
    var b = e.target.closest('button[data-mode]');
    if (b) setMode(b.dataset.mode);
  });

  el.stCount.addEventListener('click', function () { state.countIdx++; updateStatus(); });

  /* ---------------- formatting ---------------- */
  function activeTextarea() {
    if (state.editing) return state.editing.ta;
    if (document.activeElement && document.activeElement.tagName === 'TEXTAREA') return document.activeElement;
    if (state.mode === 'split') return el.src;
    return null;
  }

  /* Where in the document an insert should land, remembered before something
     steals the focus. Opening an NSOpenPanel resigns first responder, which
     blurs the open block, which commits and re-renders it — so by the time the
     user has picked a file there is no caret left to insert at, and the image
     would silently go to the end of the document. */
  var insertPin = null;
  function pinInsertPoint() {
    var ta = activeTextarea();
    if (!ta) { insertPin = null; return; }
    if (ta === el.src) insertPin = { src: true, at: ta.selectionStart };
    else if (state.editing) insertPin = { i: state.editing.i, at: ta.selectionStart };
    else insertPin = null;
  }

  /* A textarea to insert into when something arrives without a caret of its
     own — a drop, or a picked file. In live view nothing is editable until a
     block is opened, so activeTextarea returns null and an insert would go
     nowhere at all; `at` is where the pointer was, so the image can land in the
     block it was aimed at rather than at the end of the document. */
  function textareaForInsert(at) {
    var pin = insertPin; insertPin = null;

    /* A drop names its own target. Anything the caret happens to be doing is
       less relevant than where the user pointed, so `at` takes precedence. */
    if (!at) {
      if (pin && pin.src && el.src) {
        el.src.setSelectionRange(pin.at, pin.at);
        return el.src;
      }
      if (pin && pin.i != null && state.mode === 'live') {
        editBlock(pin.i, pin.at, false);
        if (state.editing) return state.editing.ta;
      }
      var ta = activeTextarea();
      if (ta && ta.isConnected) return ta;
    }

    if (state.mode === 'split') return el.src;

    /* Live view. Find the block under the pointer, falling back to the end. */
    if (state.mode !== 'live' || !state.blocks.length) return null;
    var i = -1;
    if (at) {
      var node = document.elementFromPoint(at.x, at.y);
      while (node && node.parentNode !== el.doc) node = node.parentNode;
      if (node) i = Array.prototype.indexOf.call(el.doc.children, node);
    }
    if (i < 0) {
      /* Aimed at nothing the document owns — the gap below the last block, or
         a piece of chrome. The end is the least surprising place left. */
      var open = state.editing;
      if (!at && open && open.ta && open.ta.isConnected) return open.ta;
      i = state.blocks.length - 1;
    }

    /* editBlock commits any open editor first, and commitEditing resets
       lastDropped, so the index it then adjusts by is always -1 here and the
       raw block index passes through unshifted. */
    editBlock(i, (state.blocks[i] || '').length, false);
    return state.editing ? state.editing.ta : null;
  }

  function wrapSelection(pre, post, placeholder) {
    var ta = activeTextarea(); if (!ta) return;
    post = post == null ? pre : post;
    var s = ta.selectionStart, e2 = ta.selectionEnd, v = ta.value;
    var sel = v.slice(s, e2) || (placeholder || '');
    var already = v.slice(s - pre.length, s) === pre && v.slice(e2, e2 + post.length) === post;
    if (already) replaceRange(ta, s - pre.length, e2 + post.length, sel, s - pre.length, s - pre.length + sel.length);
    else replaceRange(ta, s, e2, pre + sel + post, s + pre.length, s + pre.length + sel.length);
  }

  function insertLink() {
    var ta = activeTextarea(); if (!ta) return;
    var s = ta.selectionStart, e2 = ta.selectionEnd, v = ta.value;
    var sel = v.slice(s, e2);
    var clip = state.lastURL || '';
    if (sel && /^(https?|mailto):/i.test(sel.trim())) {
      // selection is a URL → label placeholder gets selected
      replaceRange(ta, s, e2, '[label](' + sel.trim() + ')', s + 1, s + 6);
      return;
    }
    var label = sel || 'label';
    var text = '[' + label + '](' + clip + ')';
    // select the label so it can be typed over straight away
    replaceRange(ta, s, e2, text, s + 1, s + 1 + label.length);
  }

  /* ---------------- version history ----------------
     Snapshots form a chain: the newest is held in full and every older one as
     a delta against the snapshot that follows it. Editing is overwhelmingly
     local, so a delta is usually tens of bytes, and that is what lets a long
     span of history stay small.

     Where it lives: a sidecar file, written by the shell via the `histWrite`
     message and handed back at launch through App.setHistory. It used to live
     in a preference, because the page is loaded with loadFileURL and WKWebView
     gives file:// origins an opaque security origin where localStorage does not
     persist. But that is a limit on this page, not on the app — the native side
     can write a file, so it does. The ceiling below is therefore generous, and
     thinning is a backstop against one runaway document rather than the thing
     holding the whole feature up.

     The ceiling is a guarantee, not a hope: histTrim's ladder ends in rungs
     that can always free bytes (collapse a document to its head, then evict
     documents outright), so it cannot stall above the limit the way a
     back[]-only thinner does when every document is short but large. */

  var HIST_EVERY = 20000;      // at most one snapshot per 20s
  var HIST_MAX = 60;           // snapshots per document
  var HIST_BYTES = 2000000;    // serialised ceiling for the whole store
  var HIST_DOCS = 8;           // documents remembered
  var HIST_DROP_BUDGET = 12;   // expensive thinning steps per trim — see histTrim

  var hist = { docs: {} };     // key -> { head, t, back: [{t,p,s,m}], seen }
  var histLast = 0;
  var histUndo = null;         // text replaced by the most recent restore
  var histDirty = false;       // store has changed since the last write
  var histCapped = null;       // key of a document too large to keep history for
  var histActivity = 0;        // last edit, however small — see markDirty

  function histKey() {
    return (state.docDir || '') + '/' + (state.fileName || 'Untitled.md');
  }

  function histDoc(create) {
    var k = histKey(), d = hist.docs[k];
    if (!d && create) {
      d = hist.docs[k] = { head: docText(), t: Date.now(), back: [], seen: Date.now() };
      histTouch(k);
    }
    return d;
  }

  /* Serialised size, measured per document and cached.
     The old trim loop called JSON.stringify on the whole store once per
     iteration of a 500-pass guard — on a store the size of its own ceiling
     that is the most expensive thing the editor does, and it ran on a timer
     while someone was typing. Only a document that actually changed needs
     re-measuring, and only one changes at a time. */
  var histSizes = {};          // key -> JSON length of hist.docs[key]

  function histTouch(k) { delete histSizes[k]; }

  function histDocBytes(k) {
    if (histSizes[k] == null) {
      /* Infinity, not 0, when it cannot be measured. A document too large to
         serialise is the one thing that must not be allowed to look free —
         reporting 0 would hide it from the ceiling permanently, which is the
         only way left for the ladder to fail to converge. */
      try { histSizes[k] = JSON.stringify(hist.docs[k]).length; }
      catch (e) { histSizes[k] = Infinity; }
    }
    return histSizes[k];
  }

  function histBytes() {
    var keys = Object.keys(hist.docs), n = 10;   /* {"docs":{}} */
    for (var i = 0; i < keys.length; i++) {
      /* the key as a JSON string, its colon, and the joining comma */
      n += JSON.stringify(keys[i]).length + 1 + histDocBytes(keys[i]) + 1;
    }
    return n;
  }

  /* Documents ordered least worth keeping first: oldest `seen` wins, and the
     one on screen is always last so it is given up only when nothing else is
     left to give. */
  function histRankedKeys() {
    var cur = histKey();
    return Object.keys(hist.docs).sort(function (a, b) {
      if (a === cur) return 1;
      if (b === cur) return -1;
      return (hist.docs[a].seen || 0) - (hist.docs[b].seen || 0);
    });
  }

  /* the older text, expressed against the newer one it follows */
  function histDelta(newer, older) {
    var n = Math.min(newer.length, older.length), p = 0, s = 0;
    while (p < n && newer.charCodeAt(p) === older.charCodeAt(p)) p++;
    while (s < n - p && newer.charCodeAt(newer.length - 1 - s) === older.charCodeAt(older.length - 1 - s)) s++;
    return { p: p, s: s, m: older.slice(p, older.length - s) };
  }
  function histApply(newer, d) {
    return newer.slice(0, d.p) + d.m + newer.slice(newer.length - d.s);
  }

  /* the document as it stood at back[i]; i of -1 means the head */
  function histAt(d, i) {
    var t = d.head;
    for (var k = 0; k <= i; k++) t = histApply(t, d.back[k]);
    return t;
  }

  function histSnapshot(force) {
    var now = Date.now();
    if (!force && now - histLast < HIST_EVERY - 1500) return;
    /* docText(), not state.text: a block open for editing in live view lives in
       a textarea and has not been folded back into state.text yet, so a
       snapshot taken mid-edit would record the block as it was before the edit.
       This is the same reason App.getText goes through docText. */
    var text = docText();
    var k = histKey(), d = hist.docs[k];

    /* First sight of this document. Its entry is the baseline — the file as it
       arrived — and it is created with head already equal to the text, so there
       is no delta to record yet. It still has to be counted against HIST_DOCS
       here: every snapshot on an unedited document takes the early return
       below, so without this, opening documents would pile up entries that the
       cap never sees. */
    if (!d) {
      hist.docs[k] = { head: text, t: now, back: [], seen: now };
      histTouch(k);
      histCapDocs();
      histMark();
      return;
    }

    if (d.head === text) return;
    d.seen = now;                /* after the early return: an unchanged
                                    document has not been "seen" in any sense
                                    that should affect eviction ranking */
    histLast = now;
    var delta = histDelta(text, d.head);
    d.back.unshift({ t: d.t, p: delta.p, s: delta.s, m: delta.m });
    d.head = text; d.t = now;
    histTouch(k);
    histTrim();
    histMark();
  }

  /* Remove the snapshot whose loss leaves the smallest hole in the timeline.
     Applied repeatedly this thins distant history and leaves the last hour
     dense, which is the shape you want when trying to get back five minutes. */
  function histDropOne() {
    var keys = Object.keys(hist.docs);
    if (!keys.length) return false;
    keys.sort(function (a, b) { return hist.docs[b].back.length - hist.docs[a].back.length; });
    var k = keys[0], d = hist.docs[k];
    if (!d || d.back.length < 3) return false;
    var best = -1, bestGap = Infinity;
    for (var i = 1; i < d.back.length - 1; i++) {
      var gap = d.back[i - 1].t - d.back[i + 1].t;
      if (gap < bestGap) { bestGap = gap; best = i; }
    }
    if (best < 1) return false;
    /* The survivor has to be re-expressed against its new predecessor. Both
       texts come out of one forward walk rather than two calls to histAt: each
       of those replays the chain from head, and on a large document that is the
       dominant cost of the whole trim. */
    var newer = d.head, j;
    for (j = 0; j <= best - 1; j++) newer = histApply(newer, d.back[j]);
    var older = histApply(histApply(newer, d.back[best]), d.back[best + 1]);
    var t = d.back[best + 1].t, delta = histDelta(newer, older);
    d.back.splice(best, 2, { t: t, p: delta.p, s: delta.s, m: delta.m });
    histTouch(k);
    return true;
  }

  /* Throw away a whole chain, keeping only the document's newest text.
     The rung below histDropOne: it works on a document of any length, which
     matters because histDropOne needs three snapshots to merge two into one
     and can free nothing at all from a document holding two large ones. */
  function histCollapse() {
    var keys = histRankedKeys();
    for (var i = 0; i < keys.length; i++) {
      var d = hist.docs[keys[i]];
      if (d && d.back.length) {
        d.back = [];
        histTouch(keys[i]);
        return true;
      }
    }
    return false;
  }

  /* The last rung. A collapsed document is just its current text with no
     history attached, so dropping it loses no recoverable state — for the
     document on screen, head is state.text and identical to what a restore
     would already give you. */
  function histEvict() {
    var keys = histRankedKeys();
    if (!keys.length) return false;
    delete hist.docs[keys[0]];
    histTouch(keys[0]);
    return true;
  }

  /* Bring the store within both ceilings.
     Every rung is tried in order and each one is strictly weaker than the last,
     so the ladder always terminates and always terminates *under* the limit.
     That is the part the previous version could not promise: its only rung was
     histDropOne, which bails on any document with fewer than three snapshots,
     so three documents each holding one full-document delta — the shape you get
     from opening three files and pasting over each — left it with nothing to
     drop and no way to report that it had failed. It sat permanently over the
     ceiling, silently. */
  /* The cheap half of the ladder: forget the documents least worth remembering.
     Split out because the create path needs it on its own. */
  function histCapDocs() {
    var keys = Object.keys(hist.docs);
    if (keys.length <= HIST_DOCS) return;
    histRankedKeys().slice(0, keys.length - HIST_DOCS).forEach(function (k) {
      delete hist.docs[k];
      histTouch(k);
    });
  }

  function histTrim(full) {
    histCapDocs();
    /* histDropOne is the rung that preserves the most and costs the most: it
       rebuilds document text to re-express one snapshot against another, so on
       a large document a long run of them is a visible stall while someone is
       typing. Hence a budget — but exhausting it only ends this pass, it never
       escalates. Being briefly over the ceiling until the next sweep is
       harmless; throwing away a chain because thinning was slow is not. Writes
       run the ladder unbudgeted (`full`), so nothing over the ceiling ever
       reaches disk. */
    var drops = full ? Infinity : HIST_DROP_BUDGET;
    var here = histKey(), evicted = false;

    for (var guard = 0; guard < 5000; guard++) {
      var d = hist.docs[here];
      var over = (d && d.back.length > HIST_MAX) || histBytes() > HIST_BYTES;
      if (!over) break;
      if (drops <= 0) break;            /* budget spent; the next sweep resumes */
      if (histDropOne()) { drops--; continue; }

      /* Thinning can free nothing at all — the structural case this ladder
         exists for, where every chain is too short to merge. Escalate now
         rather than waiting for a sweep that would find the same thing. */
      if (histCollapse()) continue;     /* give up a whole chain, keep the text */
      if (histEvict()) {                /* give up the document */
        if (!hist.docs[here]) evicted = true;
        continue;
      }
      break;                            /* nothing left to give */
    }

    /* A document bigger than the whole ceiling is evicted by the last rung, and
       would then reappear as a document with no history — indistinguishable
       from one just opened. Record that it was size, so the picker can say so.
       Only an eviction that actually happened in this pass counts: deriving it
       from bare membership marks every document the store has never seen. */
    if (evicted) histCapped = here;
    else if (histCapped === here && hist.docs[here]) histCapped = null;
    return histBytes() <= HIST_BYTES;
  }

  /* Persistence is idle-driven and deliberately lazy.

     It used to be a 1200ms trailing debounce hanging off histSnapshot, with
     autoSaved() calling histSnapshot(true) — forced, so it walked straight past
     the 20s throttle. The shell autosaves one second after the last keystroke,
     so every pause long enough to trigger an autosave — the end of a sentence,
     a moment's thought — serialised the entire multi-document store and pushed
     it into UserDefaults about a second later. A writing session is mostly
     pauses, so that is most of a writing session.

     A debounce is the wrong shape for this regardless of its length: reset by
     the very activity that makes a write worth doing, it fires on every lull
     and, under genuinely unbroken typing, never fires at all.

     So the write is gated on real quiet instead. A snapshot marks the store
     dirty and nothing else; the periodic sweep writes only once no edit has
     landed for HIST_IDLE. Blur, document switch and quit flush unconditionally,
     because for those there may not be a later. */

  var HIST_IDLE = 20000;       // quiet time before a write

  function histMark() { histDirty = true; }

  function histFlush() {
    if (!histDirty) return;
    if (histBytes() > HIST_BYTES) histTrim(true);
    var json = histDump();
    if (json == null) return;               /* unserialisable: keep it dirty */
    /* Cleared only once the message is confirmed away. send swallows a dead
       bridge and a postMessage throw, so clearing first would silently discard
       everything accumulated since the last successful write, with nothing left
       to trigger a retry. */
    if (send('histWrite', { json: json })) histDirty = false;
  }

  /* The write half of the periodic sweep: only when the writer has stopped. */
  function histFlushIfIdle() {
    if (histDirty && Date.now() - histActivity >= HIST_IDLE) histFlush();
  }

  /* The serialised store, or null if it could not be serialised at all.
     An empty store is a legitimate value — it is what an eviction leaves — and
     must be writable, or the file it was evicted from stays on disk and comes
     back at the next launch. Only genuine failure returns null, so that a
     failure can never blank a good file. */
  function histDump() {
    try { return JSON.stringify(hist); } catch (e) { return null; }
  }

  /* What the shell pulls on quit and on losing focus, where there may not be a
     later. Pins the present first — the periodic snapshot is 20s apart and the
     quit path writes the document directly rather than through setSaved, so
     without this the last stretch of editing never reaches history at all,
     which is the exact loss this store exists to prevent. */
  function histCommit() {
    histSnapshot(true);
    if (!histDirty) return null;            /* nothing new since the last write */
    if (histBytes() > HIST_BYTES) histTrim(true);
    var json = histDump();
    if (json == null) return null;
    histDirty = false;
    return json;
  }

  /* Every entry is checked before it is adopted. The sidecar is an ordinary
     file in the user's Application Support folder, so a malformed one is
     reachable without anything else having gone wrong — and an entry missing
     `back` would throw inside histTrim on the first snapshot, out through
     App.loadDoc, and stop the document opening at all. */
  function histValid(d) {
    if (!d || typeof d.head !== 'string' || !Array.isArray(d.back)) return false;
    if (typeof d.t !== 'number' || !isFinite(d.t)) return false;
    for (var i = 0; i < d.back.length; i++) {
      var b = d.back[i];
      if (!b || typeof b.m !== 'string') return false;
      if (typeof b.p !== 'number' || typeof b.s !== 'number') return false;
      if (typeof b.t !== 'number' || !isFinite(b.t)) return false;
      if (b.p < 0 || b.s < 0) return false;
    }
    return true;
  }

  function histLoad(raw) {
    if (!raw) return;
    var h;
    try { h = JSON.parse(raw); } catch (e) { return; }
    if (!h || !h.docs || typeof h.docs !== 'object') return;

    var clean = {}, dropped = false;
    Object.keys(h.docs).forEach(function (k) {
      var d = h.docs[k];
      if (histValid(d)) {
        if (typeof d.seen !== 'number' || !isFinite(d.seen)) d.seen = d.t;
        clean[k] = d;
      } else dropped = true;
    });

    hist = { docs: clean };
    histSizes = {};
    histCapped = null;
    /* Deliberately not trimmed here. This runs from App.setHistory, which the
       shell sends during handleReady — before App.loadDoc, so histKey() is
       still the untitled placeholder. Trimming now would rank the document
       about to be opened as evictable and protect one that does not exist.
       The first snapshot trims with the real key, a moment later. */
    if (dropped) histMark();
  }

  /* the newest snapshot that is at least `ms` old, or null if history does
     not reach back that far */
  function histFind(ms) {
    var d = histDoc(false); if (!d) return null;
    var cutoff = Date.now() - ms;
    if (d.t <= cutoff) return { t: d.t, text: d.head };
    for (var i = 0; i < d.back.length; i++) {
      if (d.back[i].t <= cutoff) return { t: d.back[i].t, text: histAt(d, i) };
    }
    return null;
  }

  function histOldest() {
    var d = histDoc(false); if (!d) return null;
    if (!d.back.length) return { t: d.t, text: d.head };
    var i = d.back.length - 1;
    return { t: d.back[i].t, text: histAt(d, i) };
  }

  function histWords(t) { return (String(t).trim().match(/[^\s]+/g) || []).length; }

  /* what a restore would do, without doing it */
  function histPeek(ms) {
    var snap = ms == null ? histOldest() : histFind(ms);
    if (!snap) return null;
    var now = docText();
    return {
      t: snap.t,
      same: snap.text === now,
      words: histWords(snap.text),
      delta: histWords(snap.text) - histWords(now)
    };
  }

  function histRestore(ms) {
    var snap = ms == null ? histOldest() : histFind(ms);
    if (!snap) return null;
    if (snap.text === docText()) return { t: snap.t, same: true };
    histSnapshot(true);            /* pin the present before leaving it */
    histUndo = docText();
    undoMark(true);                /* …and let plain ⌘Z walk back out of it */
    setText(snap.text, { immediate: true });
    return { t: snap.t };
  }

  function histUndoRestore() {
    if (histUndo == null) return false;
    var back = histUndo;
    histUndo = null;
    undoMark(true);
    setText(back, { immediate: true });
    return true;
  }

  function histStats() {
    var capped = histCapped === histKey();
    var d = histDoc(false);
    if (!d) return { count: 0, span: 0, bytes: histBytes(), capped: capped };
    return {
      count: d.back.length + 1,
      span: Date.now() - (d.back.length ? d.back[d.back.length - 1].t : d.t),
      bytes: histBytes(),
      capped: capped
    };
  }

  /* ---------------- browsing the chain ----------------

     histFind and histPeek answer "what was it n minutes ago", which is all the
     eight fixed steps in the menu ever needed. The store holds up to HIST_MAX
     snapshots per document though, so most of what it keeps was unreachable:
     the steps land on whatever happens to be nearest and everything between
     them stays invisible. These three let the whole chain be listed, read and
     restored by position instead.

     Indices run newest first: 0 is the head, k+1 is back[k]. */

  /* One forward walk, not one histAt per entry. histAt replays the chain from
     the head every time it is called, so building this list with it would be
     O(n²) full-document rebuilds — sixty of them, on the keypress that opens
     the browser. Walking once and reading the running text costs n. */
  function histList() {
    var d = histDoc(false);
    if (!d) return [];
    var now = docText(), nowWords = histWords(now);
    var rows = [{ i: 0, t: d.t, words: histWords(d.head), same: d.head === now }];
    var text = d.head;
    for (var k = 0; k < d.back.length; k++) {
      text = histApply(text, d.back[k]);
      rows.push({ i: k + 1, t: d.back[k].t, words: histWords(text), same: text === now });
    }
    for (var j = 0; j < rows.length; j++) rows[j].delta = rows[j].words - nowWords;
    return rows;
  }

  function histTextAt(n) {
    var d = histDoc(false);
    if (!d) return null;
    n = Math.max(0, Math.min(d.back.length, n | 0));
    return n === 0 ? d.head : histAt(d, n - 1);
  }

  function histRestoreAt(n) {
    var d = histDoc(false);
    if (!d) return null;
    n = Math.max(0, Math.min(d.back.length, n | 0));
    /* Read the text and its timestamp before pinning the present: the pin
       pushes a new head and every index below shifts by one. */
    var text = n === 0 ? d.head : histAt(d, n - 1);
    var t = n === 0 ? d.t : d.back[n - 1].t;
    if (text == null) return null;
    if (text === docText()) return { t: t, same: true };
    histSnapshot(true);            /* pin the present before leaving it */
    histUndo = docText();
    undoMark(true);                /* …and let plain ⌘Z walk back out of it */
    setText(text, { immediate: true });
    return { t: t };
  }

  setInterval(function () { histSnapshot(); histFlushIfIdle(); }, HIST_EVERY);

  /* The moments where there may not be a later. pagehide covers the web view
     going away; blur covers switching apps, which the shell also treats as a
     commit point, and the two collapse harmlessly because histFlush is a no-op
     on a clean store. */
  window.addEventListener('blur', histFlush);
  window.addEventListener('pagehide', histFlush);

  /* ---------------- block-level formatting ---------------- */

  /* the line the caret sits on, as [start, end) offsets */
  function lineSpan(v, from, to) {
    var ls = v.lastIndexOf('\n', from - 1) + 1;
    var le = v.indexOf('\n', to); if (le === -1) le = v.length;
    return [ls, le];
  }

  function setHeading(level) {
    var ta = activeTextarea(); if (!ta) return;
    var v = ta.value, s = ta.selectionStart, e2 = ta.selectionEnd;
    var sp = lineSpan(v, s, s), line = v.slice(sp[0], sp[1]);
    var m = /^(\s*)(#{1,6})\s*/.exec(line);
    var indent = m ? m[1] : /^\s*/.exec(line)[0];
    var body = m ? line.slice(m[0].length) : line.slice(indent.length);
    /* clicking the level you already have takes the heading off again */
    var mark = (m && m[2].length === level) ? '' : (new Array(level + 1).join('#') + ' ');
    var out = indent + mark + body, d = out.length - line.length;
    replaceRange(ta, sp[0], sp[1], out,
                 Math.max(sp[0], s + d), Math.max(sp[0], e2 + d));
  }

  var QUOTE_PREFIX = /^(\s*)>\s?/;
  var LIST_PREFIX = /^(\s*)(?:[-*+]|\d+[.)])\s+/;

  function toggleLinePrefix(kind) {
    var ta = activeTextarea(); if (!ta) return;
    var v = ta.value;
    var sp = lineSpan(v, ta.selectionStart, ta.selectionEnd);
    var lines = v.slice(sp[0], sp[1]).split('\n');
    var re = kind === 'quote' ? QUOTE_PREFIX : LIST_PREFIX;
    var add = kind === 'quote' ? '> ' : '- ';
    /* already prefixed throughout means the writer wants it gone */
    var on = lines.every(function (l) { return !l.trim() || re.test(l); });
    var out = lines.map(function (l) {
      if (!l.trim()) return l;
      return on ? l.replace(re, '$1') : l.replace(/^(\s*)/, '$1' + add);
    }).join('\n');
    replaceRange(ta, sp[0], sp[1], out, sp[0], sp[0] + out.length);
  }

  /* ---------------- table rows ----------------

     A table is the one block a writer cannot simply type another line into:
     the new line has to carry the right number of pipes, sit on the right
     side of the dashes, and keep whatever spacing the rest of the table
     uses. Three commands do that bookkeeping instead.

     Everything below takes the text of one block and an offset into it, so
     both views share one transform: live view hands over the block open in
     its textarea, split view the slice of the document the caret fell in.
     Rows are parsed into cells rather than pushed around as strings, so the
     column versions of these commands are the same parse with a different
     splice. */

  var TABLE_LINE = /^\s*\|/;
  var DELIM_CELL = /^:?-+:?$/;

  /* One row cut at the pipes it is actually written with. Both outer pipes
     are optional in GFM and a pipe inside a cell can be escaped, so neither
     can be assumed away. Every piece is kept as written, spacing and all,
     because writing a new row means copying how this one was spaced. */
  function rowCells(line) {
    var indent = /^[ \t]*/.exec(line)[0];
    var body = line.slice(indent.length);
    var lead = body.charAt(0) === '|';
    if (lead) body = body.slice(1);
    var cells = [], cur = '';
    for (var i = 0; i < body.length; i++) {
      var ch = body.charAt(i);
      if (ch === '\\' && i + 1 < body.length) { cur += ch + body.charAt(++i); continue; }
      if (ch === '|') { cells.push(cur); cur = ''; continue; }
      cur += ch;
    }
    /* Writing after the last pipe is a final cell; whitespace after it is
       the row being closed off, and belongs to no cell at all. */
    var closed = cells.length > 0 && cur.trim() === '';
    if (!closed) cells.push(cur);
    return { indent: indent, lead: lead, closed: closed, tail: closed ? cur : '', cells: cells };
  }

  function rowText(r) {
    return r.indent + (r.lead ? '|' : '') + r.cells.join('|') + (r.closed ? '|' + r.tail : '');
  }

  function isDelimRow(r) {
    return r.cells.length > 0 && r.cells.every(function (c) { return DELIM_CELL.test(c.trim()); });
  }

  /* The table the caret is in, or null. `text` is one block and `at` an
     offset into it. The run ends at the first line that is not a row, so
     prose written directly under a table is outside it and stays safe. */
  function tableAt(text, at) {
    text = String(text);
    if (blockKind(text) !== 'table') return null;
    var lines = text.split('\n'), starts = [], p = 0, i;
    for (i = 0; i < lines.length; i++) { starts.push(p); p += lines[i].length + 1; }
    at = Math.max(0, Math.min(text.length, at | 0));
    var ln = 0;
    for (i = 0; i < lines.length; i++) if (at >= starts[i]) ln = i;
    if (!TABLE_LINE.test(lines[ln])) return null;
    var first = ln, last = ln;
    while (first > 0 && TABLE_LINE.test(lines[first - 1])) first--;
    while (last < lines.length - 1 && TABLE_LINE.test(lines[last + 1])) last++;
    var rows = lines.slice(first, last + 1).map(rowCells);
    /* GFM puts the delimiter on the second line and nowhere else, so a row
       of dashes further down is a row whose cells happen to hold dashes and
       is the writer's to delete. The first line is tested as well, so a
       table that has already lost its header cannot lose its dashes too. */
    var delim = rows.length > 1 && isDelimRow(rows[1]) ? 1 : (isDelimRow(rows[0]) ? 0 : -1);
    /* Ragged tables are ordinary in the wild, and a renderer pads the short
       rows and drops the long ones against the delimiter. That is the count
       used here too; a table with no delimiter falls back to its first row,
       and either way one table has one answer. */
    var cols = Math.max(1, rows[delim > 0 ? delim : 0].cells.length);
    return { text: text, lines: lines, starts: starts, first: first, last: last,
             rows: rows, delim: delim, row: ln - first, cols: cols };
  }

  /* A new row spaced like the one it is going next to: each cell is that
     row's cell with the writing taken out of it, so the pipes land in the
     same columns. An aligned table stays aligned and a compact one stays
     compact without either having to be recognised as such. */
  function blankRow(t, tmpl) {
    var cells = [];
    for (var c = 0; c < t.cols; c++) {
      var s = tmpl.cells[c];
      cells.push(s == null ? ' ' : s.replace(/[\s\S]/g, ' '));
    }
    return { indent: tmpl.indent, lead: tmpl.lead, closed: tmpl.closed,
             tail: tmpl.tail, cells: cells };
  }

  /* Where a writer would start typing in a row: inside the first cell, past
     whatever padding the table puts in front of it. */
  function firstCellAt(row, tmpl) {
    var c0 = row.cells[0] == null ? '' : row.cells[0];
    var t0 = tmpl.cells[0] == null ? '' : tmpl.cells[0];
    var pre = /^[ \t]*/.exec(t0)[0].length;
    return row.indent.length + (row.lead ? 1 : 0) + Math.min(pre, c0.length);
  }

  /* One row edit, text in and text out. `op` is 'above', 'below' or
     'delete'. Returns null when there is no table under the caret, or why
     the ask was refused: 'header' for the two rows that are the table
     rather than anything in it, 'last' for the only row there is. */
  function tableRowEdit(text, at, op) {
    var t = tableAt(text, at);
    if (!t) return null;
    var rows = t.rows, tmpl = rows[t.row], landed, i;
    if (op === 'delete') {
      /* The header names the columns and the dashes are what make the thing
         a table at all. Taking either out is not deleting a row, it is
         deleting the table, and the writer has the block itself for that. */
      if (t.row <= t.delim) return 'header';
      if (rows.length < 2) return 'last';
      rows.splice(t.row, 1);
      landed = Math.min(t.row, rows.length - 1);
      /* The last body row gone leaves the delimiter directly above, which is
         no place for a caret; the header is the nearest row left. */
      if (landed === t.delim) landed = Math.max(0, t.delim - 1);
    } else {
      landed = op === 'above' ? t.row : t.row + 1;
      /* Nothing may come between the header and its delimiter, and a row put
         above the header would quietly become the header. Either way the
         first place a body row can go is under the dashes. */
      if (landed <= t.delim) landed = t.delim + 1;
      rows.splice(landed, 0, blankRow(t, tmpl));
    }
    var out = rows.map(rowText);
    var head = t.starts[t.first], tail = t.starts[t.last] + t.lines[t.last].length;
    var caret = head;
    for (i = 0; i < landed; i++) caret += out[i].length + 1;
    return {
      text: text.slice(0, head) + out.join('\n') + text.slice(tail),
      at: caret + firstCellAt(rows[landed], op === 'delete' ? rows[landed] : tmpl)
    };
  }

  /* The block the caret is in, as a span of the field that holds it. Split
     view holds the whole document, so the block has to be found — and the
     blocks are re-cut from the field's own value rather than read off
     state.blocks, which split view refreshes on a timer and which can
     therefore be a keystroke behind what the writer is looking at.

     Live view has one block open and nothing else on the page is editable.
     Arriving with none open means the command came from the palette, which
     commits the open block before it reads the document; the block the
     writer was last in is reopened where they left it rather than the
     command answering that there is no table anywhere. */
  function caretBlock() {
    if (state.mode === 'live' && !state.editing && state.blocks.length) {
      editBlock(Math.min(Math.max(0, state.lastBlock | 0), state.blocks.length - 1), lastCaret, false);
    }
    var ta = activeTextarea();
    if (!ta) return null;
    if (ta !== el.src) return { ta: ta, from: 0, to: ta.value.length };
    var v = ta.value, at = ta.selectionStart || 0;
    var bs = splitBlocks(v), p = 0, span = [0, 0];
    for (var i = 0; i < bs.length; i++) {
      if (bs[i] === '') continue;
      var k = v.indexOf(bs[i], p);
      if (k === -1) break;
      span = [k, k + bs[i].length];
      if (at <= span[1]) break;
      p = span[1];
    }
    return { ta: ta, from: span[0], to: span[1] };
  }

  /* Through replaceRange like every other formatting command, so the change
     is one step on the document's own undo stack and one ⌘Z puts the table
     back the way it was. */
  function tableRow(op) {
    var b = caretBlock();
    var r = b && tableRowEdit(b.ta.value.slice(b.from, b.to),
                              (b.ta.selectionStart || 0) - b.from, op);
    if (r === 'header') { toast('The header row has to stay'); return false; }
    if (r === 'last') { toast('That is the only row left'); return false; }
    /* Nowhere near a table: say where the commands work rather than nothing
       at all, which reads as the command having failed. */
    if (!r) { toast('Put the caret in a table row'); return false; }
    replaceRange(b.ta, b.from, b.to, r.text, b.from + r.at, b.from + r.at);
    b.ta.focus();
    return true;
  }

  /* ---------------- selection geometry ---------------- */
  var MIRROR_PROPS = ['fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'fontVariant',
    'letterSpacing', 'lineHeight', 'textTransform', 'wordSpacing', 'textIndent',
    'whiteSpace', 'wordWrap', 'overflowWrap', 'wordBreak', 'tabSize',
    'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
    'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth', 'boxSizing'];

  /* A textarea will not say where its selection sits on screen. Lay the same
     text out in a hidden div with identical metrics and measure that instead. */
  function selectionRect(ta) {
    if (!ta) return null;
    var s = ta.selectionStart, e2 = ta.selectionEnd;
    var cs = getComputedStyle(ta), tr = ta.getBoundingClientRect();
    var m = document.createElement('div');
    for (var i = 0; i < MIRROR_PROPS.length; i++) m.style[MIRROR_PROPS[i]] = cs[MIRROR_PROPS[i]];
    m.style.position = 'absolute';
    m.style.top = '0px'; m.style.left = '-99999px';
    m.style.width = tr.width + 'px';
    m.style.height = 'auto';
    m.style.visibility = 'hidden';
    m.style.whiteSpace = 'pre-wrap';
    m.style.overflowWrap = 'break-word';
    m.appendChild(document.createTextNode(ta.value.slice(0, s)));
    var mark = document.createElement('span');
    mark.textContent = ta.value.slice(s, e2) || '​';
    m.appendChild(mark);
    m.appendChild(document.createTextNode(ta.value.slice(e2) + '​'));
    document.body.appendChild(m);
    var mr = m.getBoundingClientRect(), rr = mark.getBoundingClientRect();
    document.body.removeChild(m);
    return {
      left: tr.left + (rr.left - mr.left),
      top: tr.top + (rr.top - mr.top) - ta.scrollTop,
      width: rr.width,
      height: rr.height
    };
  }

  function copyRich() {
    var htmlParts = state.blocks.map(function (b, i) { return md(b, i); }).join('\n');
    send('copyRich', { html: htmlParts, text: state.text });
    toast('Copied as rich text');
  }

  /* ---------------- link clicks ---------------- */
  document.addEventListener('click', function (e) {
    var a = e.target.closest('a[href]');
    if (!a) return;
    e.preventDefault();
    var href = a.getAttribute('href');
    if (/^(https?|mailto):/i.test(href)) send('openURL', { url: href });
  });

  /* ---------------- exposed ---------------- */
  var MM = {
    el: el, state: state, send: send,
    md: md, esc: esc, toast: toast,
    setText: setText, renderDoc: renderDoc, paintSource: paintSource,
    splitBlocks: splitBlocks, joinBlocks: joinBlocks,
    blockSpans: blockSpans, spliceBlock: spliceBlock, docText: docText,
    blockStartOffsets: blockStartOffsets, blockIndexForOffset: blockIndexForOffset,
    editBlock: editBlock, commitEditing: commitEditing,
    setMode: setMode, movePill: movePill, positionBar: positionBar,
    staggerBlocks: staggerBlocks,
    updateStatus: updateStatus, updateCaretStatus: updateCaretStatus,
    markDirty: markDirty, markCurrentLine: markCurrentLine, markCurrentBlock: markCurrentBlock,
    sentences: sentences, sentenceAt: sentenceAt,
    paintBlockSentences: paintBlockSentences, paintLineSentences: paintLineSentences,
    wrapSelection: wrapSelection, insertLink: insertLink, copyRich: copyRich,
    setHeading: setHeading, toggleLinePrefix: toggleLinePrefix, selectionRect: selectionRect,
    tableRow: tableRow, tableAt: tableAt, tableRowEdit: tableRowEdit,
    insertEmptyBlockAt: insertEmptyBlockAt, textareaForInsert: textareaForInsert,
    pinInsertPoint: pinInsertPoint,
    histSnapshot: histSnapshot, histPeek: histPeek, histRestore: histRestore,
    histUndoRestore: histUndoRestore, histLoad: histLoad, histStats: histStats,
    histFlush: histFlush, histCommit: histCommit,
    histList: histList, histTextAt: histTextAt, histRestoreAt: histRestoreAt,
    histCanUndo: function () { return histUndo != null; },
    activeTextarea: activeTextarea, replaceRange: replaceRange,
    undo: undo, redo: redo, undoMark: undoMark, undoReset: undoReset, undoBreak: undoBreak,
    canUndo: function () { return undoStack.length > 0; },
    canRedo: function () { return redoStack.length > 0; },
    autosizeSrc: autosizeSrc, followCaret: followCaret,
    typewriterSplit: typewriterSplit, typewriterLive: typewriterLive,
    currentLineIndex: currentLineIndex, stats: stats,
    setScroll: setScroll, invalidateAnchors: invalidateAnchors,
    sessionCapture: sessionCapture, sessionRestore: sessionRestore,
    sessionBlank: sessionBlank,
    setWikiTargets: setWikiTargets, forgetWikiTargets: forgetWikiTargets,
    onDocRendered: null, onPreviewScroll: null, onDirty: null
  };
  return MM;
})();
