/* ============================================================
   minimark — lenses

   A lens is not the style check. The style check says a word is wrong and
   says why; a lens says nothing at all. It colours a class of word and lets
   the writer draw their own conclusion. Four adverbs in one paragraph is a
   fact about the text, not an opinion about it.

   That distinction is the whole design and it is easy to erode. The rules
   here therefore carry no `why`, nothing counts them in the status bar, and
   nothing steps through them. If a tooltip ever appears on one of these, the
   lens has turned into a critic and the feature has stopped being worth
   having. There is nothing wrong with an adverb.

   Three, and only three, because these are the three that can be decided by
   looking at the words themselves. Adjectives, nouns, verbs and conjunctions
   need a part-of-speech tagger, which style-check.js declines for reasons
   that have not changed: done badly it cries wolf until the writer turns the
   whole thing off, which costs more than never having shipped it.

     adverb   a word ending -ly that is not on the list below
     long     a sentence over LONG_WORDS words
     repeat   a word used REPEAT_MIN times inside REPEAT_WINDOW words

   The lists are kept apart from the painter for the same reason the style
   dictionary is: adding a word people keep tripping over should not mean
   reading ui.js.
   ============================================================ */
window.MMLens = (function () {
  'use strict';

  var LENSES = [
    { id: 'adverb', name: 'Adverbs' },
    { id: 'long',   name: 'Long sentences' },
    { id: 'repeat', name: 'Repeated words' }
  ];

  /* ------------------------------------------------------------ adverbs

     Ending in -ly is a good proxy and a famously imperfect one. The test for
     this list is the one that matters: would colouring this word teach the
     writer anything? "Family" is a noun, "reply" is a verb, "apply" is a
     verb. None of them is an adverb and all of them end in -ly, so each one
     that stays off this list is a word the writer learns to ignore, and a
     lens the writer learns to ignore is off. */
  var NOT_ADVERBS = {};
  ('anomaly apply assembly beastly belly bristly bubbly bully burly butterfly ' +
   'chilly comely comply costly courtly crinkly cuddly curly daily deadly ' +
   'deathly dilly doily elderly family folly friendly frilly ghastly ghostly ' +
   'giggly gnarly grisly gully heavenly holly homely hourly imply italy jelly ' +
   'jolly knobbly leisurely likely lonely lovely lowly manly measly ' +
   'melancholy miserly molly monopoly monthly multiply nightly noduly orderly ' +
   'panoply pearly portly prickly quarterly rally reply ripply rumbly ' +
   'saintly sally scholarly seemly sickly silly sparkly squiggly stately ' +
   'supply surly tally timely trolly unlikely unruly weekly wiggly wobbly ' +
   'woolly worldly wrinkly yearly')
    .split(' ').forEach(function (w) { if (w) NOT_ADVERBS[w] = 1; });

  var ADVERB = /\b[A-Za-z][A-Za-z'’-]*ly\b/g;

  /* Every adverb in a run of text, as {at, len}. */
  function adverbs(text) {
    var out = [], m;
    if (!text) return out;
    ADVERB.lastIndex = 0;
    while ((m = ADVERB.exec(text))) {
      if (!m[0].length) { ADVERB.lastIndex++; continue; }
      var w = m[0].toLowerCase().replace(/[’']/g, '');
      /* "-ly" on its own, and two-letter words like "fly", are not adverbs
         anybody needs pointing out. */
      if (w.length < 5 || NOT_ADVERBS[w]) continue;
      out.push({ at: m.index, len: m[0].length });
    }
    return out;
  }

  /* --------------------------------------------------------- long sentences

     Thirty is not a law. It is the point past which a sentence usually wants
     reading twice, which is the thing worth being shown. */
  var LONG_WORDS = 30;

  /* Sentence splitting belongs to app.js, which already does it for focus
     mode and has the abbreviations and decimals handled. Passed in rather
     than reimplemented, so there is one answer to "where does this sentence
     end" in the whole app. */
  function longSentences(text, split, min) {
    var ranges = split(text || ''), out = [];
    var limit = min || LONG_WORDS;
    for (var i = 0; i < ranges.length; i++) {
      var s = text.slice(ranges[i][0], ranges[i][1]);
      var words = s.match(/[^\s]+/g);
      if (words && words.length > limit) out.push([ranges[i][0], ranges[i][1]]);
    }
    return out;
  }

  /* --------------------------------------------------------- repeated words

     Not "used often in the document" — in a long document every content word
     is. Used three times close together, which is the repetition a reader
     actually hears.

     Counted in words rather than characters, because a window measured in
     characters is a different size in a list than it is in prose. */
  var REPEAT_MIN = 3;
  var REPEAT_WINDOW = 200;
  var REPEAT_MIN_LEN = 4;

  /* Short words and the words every sentence is made of. Repetition is the
     point of these, and colouring "that" nine times teaches nobody
     anything. */
  var COMMON = {};
  ('about after again against all also although always among and another any ' +
   'are around because been before being between both but came can come could ' +
   'did does doing done down during each either else even ever every for from ' +
   'further get gets going gone got had has have having here how however into ' +
   'its itself just like made make many may might more most much must never ' +
   'next not now off once only onto other our out over own perhaps rather ' +
   'really said same shall she should since some such than that the their them ' +
   'then there these they thing things this those though through thus too ' +
   'under until upon used using very was way well were what when where which ' +
   'while who whom whose why will with within without would you your yours')
    .split(' ').forEach(function (w) { if (w) COMMON[w] = 1; });

  var WORD = /[A-Za-z][A-Za-z'’-]*/g;

  /* Tokenise, so the caller can build one stream across a whole document and
     hand it back. Each token is {word, at, len}; `at` is whatever offset base
     the caller passed in, which is how per-node offsets become document
     offsets. */
  function words(text, base) {
    var out = [], m;
    WORD.lastIndex = 0;
    while ((m = WORD.exec(String(text || '')))) {
      if (!m[0].length) { WORD.lastIndex++; continue; }
      out.push({ word: m[0].toLowerCase().replace(/[’']/g, ''),
                 at: (base || 0) + m.index, len: m[0].length });
    }
    return out;
  }

  /* Which tokens in the stream are repetitions, as a set of stream indices.

     A token is in if it belongs to a run of REPEAT_MIN occurrences of the
     same word that fits inside REPEAT_WINDOW words. Checked on consecutive
     triples, which is the same answer as sliding a window and considerably
     less code: if any three consecutive occurrences fit, all three are in. */
  function repeats(stream, opts) {
    var min = (opts && opts.min) || REPEAT_MIN;
    var span = (opts && opts.window) || REPEAT_WINDOW;
    var minLen = (opts && opts.minLength) || REPEAT_MIN_LEN;
    var where = {}, i;
    for (i = 0; i < stream.length; i++) {
      var w = stream[i].word;
      if (w.length < minLen || COMMON[w]) continue;
      (where[w] || (where[w] = [])).push(i);
    }
    var hit = {};
    Object.keys(where).forEach(function (w) {
      var list = where[w];
      if (list.length < min) return;
      for (var k = 0; k + min - 1 < list.length; k++) {
        if (list[k + min - 1] - list[k] <= span) {
          for (var j = k; j < k + min; j++) hit[list[j]] = 1;
        }
      }
    });
    return hit;
  }

  return {
    LENSES: LENSES,
    adverbs: adverbs,
    longSentences: longSentences,
    words: words,
    repeats: repeats,
    LONG_WORDS: LONG_WORDS,
    REPEAT_MIN: REPEAT_MIN,
    REPEAT_WINDOW: REPEAT_WINDOW,
    /* exposed so the tests assert against the real lists rather than a copy */
    counts: function () {
      return { notAdverbs: Object.keys(NOT_ADVERBS).length, common: Object.keys(COMMON).length };
    }
  };
})();
