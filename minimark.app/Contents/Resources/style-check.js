/* ============================================================
   minimark — style check

   The dictionary and the matcher, kept apart from the editor because this is
   the file people will want to argue with. Adding an entry should not mean
   reading ui.js, and disagreeing with one should not mean forking the app.

   Three lists, and deliberately only three:

     filler       words that can be struck out and the sentence means exactly
                  the same thing. The commonest and most useful of the three.
     cliche       phrases that were vivid once. They are not wrong, they are
                  worn, and a reader's eye slides off them.
     redundancy   two words doing one word's work: "past history", "free
                  gift", "advance planning".

   What is deliberately NOT here: parts of speech, passive voice, sentence
   length, readability scores. Those need a parser or a model to do properly,
   and done badly they cry wolf until the writer turns the whole feature off,
   which costs more than never having shipped it. Everything in this file is
   decidable by looking at the words themselves.

   Every entry carries a `why`. A highlight that will not say what is wrong
   with the sentence is just a colour.

   Matching is case-insensitive and on word boundaries, so "just" does not
   fire inside "adjust" and "Very" is caught at the head of a sentence.
   ============================================================ */
window.MMStyle = (function () {
  'use strict';

  /* ---------------------------------------------------------------- filler
     The test for this list: strike the word out and read the sentence again.
     If it says the same thing, it belongs here. */
  var FILLER = [
    ['very', 'Strike it out, or use a stronger word.'],
    ['really', 'Strike it out.'],
    ['quite', 'Strike it out, or say how much.'],
    ['rather', 'Strike it out, or say how much.'],
    ['fairly', 'Strike it out, or say how much.'],
    ['somewhat', 'Strike it out, or say how much.'],
    ['just', 'Usually strikes out cleanly.'],
    ['actually', 'Usually strikes out cleanly.'],
    ['basically', 'Usually strikes out cleanly.'],
    ['essentially', 'Usually strikes out cleanly.'],
    ['literally', 'Strike it out unless you mean it literally.'],
    ['simply', 'Often tells the reader the thing is easy when it is not.'],
    ['obviously', 'If it is obvious, it does not need saying.'],
    ['clearly', 'If it is clear, it does not need saying.'],
    ['certainly', 'Strike it out.'],
    ['definitely', 'Strike it out.'],
    ['absolutely', 'Strike it out.'],
    ['totally', 'Strike it out.'],
    ['completely', 'Strike it out unless the completeness is the point.'],
    ['extremely', 'Strike it out, or use a stronger word.'],
    ['incredibly', 'Strike it out, or use a stronger word.'],
    ['honestly', 'Implies the rest was not.'],
    ['frankly', 'Implies the rest was not.'],
    ['arguably', 'Either argue it or drop it.'],
    ['sort of', 'Strike it out, or commit.'],
    ['kind of', 'Strike it out, or commit.'],
    ['a bit', 'Strike it out, or say how much.'],
    ['pretty much', 'Strike it out, or commit.'],
    ['more or less', 'Strike it out, or commit.'],
    ['in order to', 'Just "to".'],
    ['in order for', 'Just "for".'],
    ['the fact that', 'Almost always rewritable: "that", or nothing.'],
    ['due to the fact that', 'Just "because".'],
    ['despite the fact that', 'Just "although".'],
    ['in spite of the fact that', 'Just "although".'],
    ['for the purpose of', 'Just "to".'],
    ['with regard to', 'Just "about".'],
    ['in terms of', 'Usually rewritable.'],
    ['it should be noted that', 'Note it, or do not.'],
    ['it is important to note that', 'Note it, or do not.'],
    ['needless to say', 'Then do not say it.'],
    ['it goes without saying', 'Then let it.'],
    ['as a matter of fact', 'Strike it out.'],
    ['at this point in time', 'Just "now".'],
    ['at this moment in time', 'Just "now".'],
    ['in my opinion', 'You are writing it, so it is.'],
    ['i think that', 'You are writing it, so you do.'],
    ['i believe that', 'You are writing it, so you do.'],
    ['i would argue that', 'Then argue it.'],
    ['began to', 'Usually just the verb: "began to fall" → "fell".'],
    ['started to', 'Usually just the verb.'],
    ['proceeded to', 'Usually just the verb.'],
    ['there is', 'Often hides the real subject: "there is a bug that…" → "a bug…".'],
    ['there are', 'Often hides the real subject.'],
    ['a number of', 'Say the number, or "several", or "some".'],
    ['a variety of', 'Say which.'],
    ['a range of', 'Say which.'],
    ['various', 'Say which.'],
    ['several', 'Say how many, if you know.'],
    ['one of the most', 'Either it is the most or it is not.'],
    ['very unique', 'Unique is not a matter of degree.'],
    ['on a regular basis', 'Just "regularly", or say how often.'],
    ['in the process of', 'Usually strikes out cleanly.']
  ];

  /* -------------------------------------------------------------- cliché
     Not wrong. Worn. The reader has met every one of these before and will
     skim past it, which is the opposite of what the sentence wanted. */
  var CLICHE = [
    ['at the end of the day', 'Say the thing itself.'],
    ['when all is said and done', 'Say the thing itself.'],
    ['think outside the box', 'Worn out.'],
    ['low-hanging fruit', 'Worn out.'],
    ['low hanging fruit', 'Worn out.'],
    ['move the needle', 'Worn out.'],
    ['circle back', 'Worn out. "Come back to".'],
    ['touch base', 'Worn out. "Talk".'],
    ['reach out', 'Worn out. "Write", "call", "ask".'],
    ['game changer', 'Worn out.'],
    ['game-changer', 'Worn out.'],
    ['paradigm shift', 'Worn out.'],
    ['best of breed', 'Worn out.'],
    ['best-in-class', 'Worn out.'],
    ['cutting edge', 'Worn out.'],
    ['state of the art', 'Worn out.'],
    ['bleeding edge', 'Worn out.'],
    ['the elephant in the room', 'Worn out. Name the thing.'],
    ['boil the ocean', 'Worn out.'],
    ['take it to the next level', 'Worn out. Say which level.'],
    ['hit the ground running', 'Worn out.'],
    ['when push comes to shove', 'Worn out.'],
    ['few and far between', 'Worn out. "Rare".'],
    ['leave no stone unturned', 'Worn out.'],
    ['tip of the iceberg', 'Worn out.'],
    ['last but not least', 'Worn out, and the reader can see it is last.'],
    ['only time will tell', 'Worn out.'],
    ['in this day and age', 'Worn out. "Now".'],
    ['avoid like the plague', 'Worn out.'],
    ['back to the drawing board', 'Worn out.'],
    ['ahead of the curve', 'Worn out.'],
    ['raise the bar', 'Worn out.'],
    ['win-win', 'Worn out.'],
    ['synergy', 'Worn out.'],
    ['synergies', 'Worn out.'],
    ['deep dive', 'Worn out. "Look closely at".'],
    ['double down', 'Worn out.'],
    ['moving forward', 'Worn out, and usually strikes out cleanly.'],
    ['going forward', 'Worn out, and usually strikes out cleanly.'],
    ['on the same page', 'Worn out. "Agree".'],
    ['the bottom line is', 'Worn out. Say it.'],
    ['par for the course', 'Worn out.'],
    ['a perfect storm', 'Worn out.'],
    ['the calm before the storm', 'Worn out.'],
    ['crystal clear', 'Worn out, and doubled: "clear".'],
    ['each and every', 'Worn out, and doubled: pick one.'],
    ['first and foremost', 'Worn out, and doubled: pick one.'],
    ['tried and tested', 'Worn out.'],
    ['tried and true', 'Worn out.'],
    ['at the coalface', 'Worn out.'],
    ['drink the kool-aid', 'Worn out.'],
    ['secret sauce', 'Worn out.'],
    ['no-brainer', 'Worn out.'],
    ['heavy lifting', 'Worn out.'],
    ['in a nutshell', 'Worn out.'],
    ['the fact of the matter', 'Worn out.'],
    ['needle in a haystack', 'Worn out.'],
    ['level playing field', 'Worn out.'],
    ['thinking caps', 'Worn out.'],
    ['step up to the plate', 'Worn out.'],
    ['ballpark figure', 'Worn out. "Estimate".'],
    ['at the speed of light', 'Worn out.'],
    ['every fibre of my being', 'Worn out.'],
    ['few would argue', 'Worn out, and probably untrue.'],
    ['it is what it is', 'Worn out.']
  ];

  /* ---------------------------------------------------------- redundancy
     Two words doing one word's work. Strike the first and nothing is lost. */
  var REDUNDANCY = [
    ['absolutely essential', '"Essential" already means this.'],
    ['advance planning', 'Planning is always in advance.'],
    ['plan ahead', 'Planning is always ahead.'],
    ['plan in advance', 'Planning is always in advance.'],
    ['advance warning', 'A warning comes in advance.'],
    ['warn in advance', 'A warning comes in advance.'],
    ['added bonus', 'A bonus is already added.'],
    ['atm machine', 'The M is "machine".'],
    ['pin number', 'The N is "number".'],
    ['basic fundamentals', 'Fundamentals are basic.'],
    ['brief summary', 'A summary is brief.'],
    ['close proximity', 'Proximity is closeness.'],
    ['collaborate together', 'Collaboration is together.'],
    ['join together', 'Joining is together.'],
    ['merge together', 'Merging is together.'],
    ['gather together', 'Gathering is together.'],
    ['mix together', 'Mixing is together.'],
    ['consensus of opinion', 'A consensus is of opinion.'],
    ['general consensus', 'A consensus is general.'],
    ['end result', 'A result is at the end.'],
    ['final outcome', 'An outcome is final.'],
    ['final conclusion', 'A conclusion is final.'],
    ['exact same', '"Same" is already exact.'],
    ['same identical', 'Pick one.'],
    ['free gift', 'A gift is free.'],
    ['future plans', 'Plans are for the future.'],
    ['new innovation', 'An innovation is new.'],
    ['past history', 'History is past.'],
    ['past experience', 'Experience is past.'],
    ['personal opinion', 'An opinion is personal.'],
    ['revert back', 'Reverting is going back.'],
    ['return back', 'Returning is going back.'],
    ['repeat again', 'Repeating is doing it again.'],
    ['over and over again', 'Pick one.'],
    ['rise up', 'Rising is upward.'],
    ['raise up', 'Raising is upward.'],
    ['lift up', 'Lifting is upward.'],
    ['climb up', 'Climbing is upward.'],
    ['descend down', 'Descending is downward.'],
    ['fall down', 'Falling is downward.'],
    ['kneel down', 'Kneeling is downward.'],
    ['reduce down', 'Reducing is downward.'],
    ['safe haven', 'A haven is safe.'],
    ['still remains', 'Remaining is still being there.'],
    ['still persists', 'Persisting is still being there.'],
    ['sum total', 'Pick one.'],
    ['true fact', 'A fact is true.'],
    ['actual fact', 'A fact is actual.'],
    ['unexpected surprise', 'A surprise is unexpected.'],
    ['usual custom', 'A custom is usual.'],
    ['old adage', 'An adage is old.'],
    ['each individual', 'Pick one.'],
    ['period of time', 'Just "period", or say how long.'],
    ['time period', 'Pick one, or say how long.'],
    ['empty space', 'Space is empty.'],
    ['enter in', 'Entering is going in.'],
    ['penetrate into', 'Penetrating is going into.'],
    ['few in number', 'Fewness is a number.'],
    ['large in size', 'Largeness is a size.'],
    ['small in size', 'Smallness is a size.'],
    ['shorter in length', 'Shortness is a length.'],
    ['filled to capacity', 'Filled is to capacity.'],
    ['invited guests', 'Guests are invited.'],
    ['manually by hand', 'Pick one.'],
    ['may possibly', 'Pick one.'],
    ['might possibly', 'Pick one.'],
    ['could possibly', 'Pick one.'],
    ['mutual cooperation', 'Cooperation is mutual.'],
    ['never before', '"Never" covers it.'],
    ['none at all', '"None" covers it.'],
    ['originally created', 'Creating is original.'],
    ['start out', 'Just "start".'],
    ['reason why', 'Just "reason", or just "why".'],
    ['the reason is because', 'Pick one: "the reason is that", or "because".'],
    ['regular routine', 'A routine is regular.'],
    ['temper tantrum', 'A tantrum is temper.'],
    ['tiny little', 'Pick one.'],
    ['twelve noon', 'Noon is twelve.'],
    ['two twins', 'Twins are two.'],
    ['unintentional mistake', 'A mistake is unintentional.'],
    ['written down', 'Writing is down.'],
    ['spell out in detail', 'Spelling out is in detail.'],
    ['completely destroyed', 'Destroying is complete.'],
    ['totally eliminated', 'Eliminating is total.'],
    ['whether or not', 'Usually just "whether".'],
    ['first began', 'Beginning is first.'],
    ['forever and ever', 'Pick one.'],
    ['each and every one', 'Pick one.']
  ];

  /* One regex per category rather than one per phrase: a document is scanned
     once per category instead of two hundred times, and the alternation is
     ordered longest-first so "in order to" is not reported as "in order" plus
     a stray "to" — the regex engine takes the first alternative that matches
     at a position, not the longest. */
  function compile(list) {
    var byPhrase = {};
    var phrases = list.map(function (e) { byPhrase[e[0]] = e[1]; return e[0]; });
    phrases.sort(function (a, b) { return b.length - a.length; });
    var alt = phrases.map(function (p) {
      return p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
    }).join('|');
    return { re: new RegExp('\\b(?:' + alt + ')\\b', 'gi'), why: byPhrase };
  }

  var GROUPS = [
    { kind: 'filler', label: 'filler', rules: compile(FILLER) },
    { kind: 'cliche', label: 'cliché', rules: compile(CLICHE) },
    { kind: 'redundancy', label: 'redundancy', rules: compile(REDUNDANCY) }
  ];

  /* Every hit in a run of text, as {at, len, kind, label, why}, in position
     order. Overlaps are resolved in favour of the longer match and then of
     the earlier category, so "past history" is one redundancy rather than a
     redundancy sitting on top of nothing.

     `why` is looked up by the matched text folded to lower case and with
     runs of whitespace squeezed, because the pattern allows a line break
     inside a phrase and the dictionary key does not. */
  function scan(text) {
    if (!text) return [];
    var hits = [];
    for (var g = 0; g < GROUPS.length; g++) {
      var grp = GROUPS[g], re = grp.rules.re, m;
      re.lastIndex = 0;
      while ((m = re.exec(text))) {
        if (!m[0].length) { re.lastIndex++; continue; }
        var key = m[0].toLowerCase().replace(/\s+/g, ' ');
        hits.push({
          at: m.index, len: m[0].length, text: m[0],
          kind: grp.kind, label: grp.label,
          why: grp.rules.why[key] || ''
        });
      }
    }
    hits.sort(function (a, b) { return a.at - b.at || b.len - a.len; });
    var out = [], end = -1;
    for (var i = 0; i < hits.length; i++) {
      if (hits[i].at < end) continue;             /* swallowed by a longer hit */
      out.push(hits[i]);
      end = hits[i].at + hits[i].len;
    }
    return out;
  }

  return {
    scan: scan,
    /* exposed so the tests can assert against the real lists rather than a
       copy of them, which is the failure mode names.js already has */
    counts: function () {
      return { filler: FILLER.length, cliche: CLICHE.length, redundancy: REDUNDANCY.length };
    }
  };
})();
