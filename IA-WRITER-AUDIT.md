# iA Writer, studied

*What to take, what to leave, and what minimark already does better.*

Written 13 September 2026, against `ff36cc6`. Companion to the polish audit in
`roadmap.rtfd`: that one is about finishing what exists, this one is about
deciding what comes next.

---

## 0. How this was made, and what that costs

The app itself was not available to this session (cloud container, no Desktop;
`ia.net` is blocked by the egress policy, so their documentation could not be
fetched either). Everything below is built from three things:

1. iA's own published design writing and support documentation, reached through
   search rather than directly.
2. Third-party reviews and teardowns.
3. A close read of minimark's source, which is the half that is verified.

Claims about **minimark** cite file and line and are checked. Claims about
**iA Writer** are secondhand. Where a claim would change a decision and I could
not confirm it, it is tagged **[verify in app]**. There are seven of those. An
hour with the running app closes all seven.

---

## 1. The thesis

Strip the feature list away and iA Writer is one idea held very hard:

> **The text is the interface. Everything else is a lens on it.**

Nothing in the app is a mode that changes the file. Focus mode dims; it does not
edit. Syntax Control colours; it does not rewrite. Preview renders; it does not
own. Authorship annotates; it does not touch the prose. Every feature is
reversible, non-destructive, and describable in one sentence to somebody who has
never used the app.

That is why it reads as coherent while shipping a lot of features. The features
are not additions to the surface, they are readings of the same surface.

Minimark shares the instinct already. Live view (`app.js`) is exactly this:
one surface, the markdown revealed on demand, never a second document. The
question for the roadmap is not "which iA features do we clone", it is
**"which lenses are missing, and which of ours are not yet lenses"**.

---

## 2. The seven ideas worth taking

### 2.1 Syntax Control: parts of speech as a lens

**What it is.** Colour every adjective brown, noun red, adverb purple, verb
blue, conjunction green. Toggle each class independently. The writer turns one
on, sees the shape of the prose, turns it off.

**Why it works.** It never says a word is wrong. It shows you the distribution
and lets you draw the conclusion. Four adverbs in one paragraph is a fact about
your text, not an opinion about it. That framing is the whole trick: a critic
gets switched off, a lens gets switched on.

**What it costs.** A part-of-speech tagger. minimark deliberately refused this
in `style-check.js:16-21`, and the reasoning there is correct: done badly it
cries wolf until the feature is turned off for good.

**Verdict: take the framing, not the parser.** Three lenses are decidable
without a tagger and get most of the value:

| Lens | Rule | Precision |
|---|---|---|
| Adverbs | words ending `-ly` minus a ~40-word stoplist (`only`, `family`, `reply`, `apply`, `supply`, `rely`, `july`, `italy`…) | high |
| Long sentences | reuse `sentences()` (`app.js:1115`); tint anything over ~30 words | exact |
| Repeated words | any non-stopword appearing 3+ times within a 200-word window | exact |

All three run on the existing sentence splitter and the existing highlight
plumbing (`--syn-*` in `styles.css:101`). None of them need a dictionary anyone
can argue with, which was the objection in the first place.

**The important part is that these are lenses, not warnings.** Off by default,
toggled from `⌘K`, no badge counting your sins.

### 2.2 Content Blocks: transclusion

**What it is.** A line beginning `/` followed by a relative path embeds that
file inline: an image, a CSV as a table, a source file as a code block, a `.txt`
as prose. Optional caption in quotes after the path. Referenced files must live
in the same folder or below it.

**Why it works.** It is the feature that turns a markdown editor into something
you can write a book in, without introducing a project format. The chapters are
still files. The manuscript is still a file. Nothing is locked in a database.

**Verdict: take it, in minimark's own syntax.** Wikilinks already exist, so the
coherent form is not iA's `/path`, it is:

```
![[chapter-two]]
```

which reads as "embed" to anyone who has met `[[link]]`, matches the image
sigil, and costs one branch in the wikilink resolver. CSV-as-table is a
cheap add on top; the table renderer is already there.

This is the single highest-value item in this document. It is the difference
between an editor for notes and an editor for a manuscript.

### 2.3 Authorship: what did you actually write

**What it is.** Local, private tracking of which text was typed, pasted, or
came from an AI. Typed text plain, human co-authors in pastel, AI in a gradient,
reference material dimmed. Nothing is sent anywhere; detection is a paste
diff, not a classifier. **[verify in app]** whether the annotations live in a
sidecar or inline in the markdown; the third-party Obsidian port describes them
as "Markdown Annotations", which suggests in-file.

**Why it works.** It answers a question writers now actually have, and it
answers it by observation rather than by guessing. No "87% likely AI". Just: you
pasted this at 14:03.

**Verdict: take a narrow version.** Full authorship is a large feature and it
carries a file-format decision, which for a plain-text app is the expensive kind
of decision. But the cheap 80% is real:

- On paste, record the range and its source (`clipboard`, or a named author).
- Store it **in the history store, not the file**: minimark already keeps local
  version history (`ui.js:931`, up to ~170KB through the `history` pref), so the
  provenance is already half-recorded. Nothing new touches the `.md`.
- One lens in `⌘K`: "Show what was pasted". Ranges tint, hover says when.

That keeps the file plain, which is minimark's actual promise, and still answers
the question. The moment provenance goes into the file, minimark owns a format,
and every other editor renders the annotations as garbage.

### 2.4 One search field, not three

**What it is.** iA Writer 8 folded document outline into Quick Search. One
field, `⇧⌘O`, that reaches headings, filenames, and full text at once. The
command palette stayed separate at `⇧⌘P`.

**Why it matters here.** minimark currently has **three** finder surfaces built
on the same picker widget:

| Surface | Key | Code |
|---|---|---|
| Command palette | `⌘K` | `openPalette` (`ui.js:907`) |
| Jump to heading | `⌘R` | `openHeadings` (`ui.js:899`) |
| Find and replace | `⌘F` | `openFind` (`ui.js:1398`) |

They share `openPicker` (`ui.js:793`) and the same fuzzy `score` (`ui.js:759`).
Three keys, one mechanism, and the user has to know in advance which of three
things they are looking for before they can start typing. Recents are already
mixed into the palette (`recentItems`, `ui.js:828`) with the right instinct
behind it, quoted in the comment there.

**Verdict: merge, and go further than iA did.** One field, `⌘K`, everything in
it: commands, headings, recents, wikilink targets, and literal text matches in
the current document. Prefix sigils for people who want to narrow (`>` command,
`#` heading, `/` file), the way every good palette does it. `⌘R` and `⌘F` stay
as direct shortcuts into the same field with the prefix pre-filled, so no muscle
memory breaks.

This is the most coherent thing on the list and it removes code rather than
adding it.

### 2.5 Templates as bundles

**What it is.** A template is a directory bundle: `Info.plist`, `document.html`,
`title.html`, `header.html`, `footer.html`, `style.css`. Preview, print, and PDF
all render through it. Users who know CSS write their own; a public GitHub repo
holds the official set.

**Why it works.** Preview and export are the same code path, so what you see is
literally what prints. No second renderer to drift.

**Verdict: mostly already done, finish it.** minimark has a templates folder and
a user stylesheet (`fd1f671`, "Templates: a user stylesheet and a shell for HTML
export"), plus HTML, PDF and print in the palette. The gap is:

- **Live preview does not use the template.** Verify, but if Preview and Export
  render differently, that is the exact drift iA avoided. Same CSS, same path.
- **No header/footer split**, so PDFs have no running head or page number.
- **No shipped set.** One good template and one plain one, in the repo, does
  more for perceived polish than a settings pane.

### 2.6 Typography as a decision, not a preference

**What it is.** iA shipped **one** font for seven years, then added exactly one
more: Duospace, a modified IBM Plex Mono that gives `m`, `M`, `w`, `W` 50% extra
width. Their argument, worth quoting in spirit: a proportional font says "this
is nearly done"; a monospace font says "this is work in progress", and for a
draft that is the more honest signal.

**Where minimark stands.** Five fonts: System, New York, Iowan, Avenir, Mono
(`ui.js:25-36`), eight text sizes (`ui.js:40`), six themes (`ui.js:16-23`),
a measure of `42rem` (`styles.css:57`) with a comment saying the number is not
round on purpose. Split view drops to `38rem` (`styles.css:746`).

**Verdict: this one is a genuine disagreement, and iA is probably right.** Five
fonts is a preference pane wearing a palette entry's clothes. Nobody's writing
improves at Avenir. Every one of those five is a decision the app declined to
make, handed to the user, who will spend four minutes on it and never think
about it again.

Two defensible positions, and either beats five:

- **iA's:** one prose font, one mono, chosen well, no picker. Loses the theme-
  and-font pairing that makes Cork and Sepia feel like anything.
- **The softer one:** keep the picker, cut to three (a serif, a sans, a mono),
  and make the default a duospace-class face rather than System. `iA Writer
  Duospace` is Apache-licensed and on GitHub, or Plex Mono directly.

The mono default is the substantive suggestion. The current default (`system`,
`ui.js:43`) makes a draft look finished, which is the wrong signal at the exact
moment the writer most needs to feel free to cut.

### 2.7 The Library, and why to say no

**What it is.** A left-hand Organizer: Locations, Favorites, Smart Folders
(dynamic, rule-based on parent or ancestor paths), and Hashtags harvested from
`#tag` in the text. Tree view, drag and drop, inline rename, Finder context
menus, all in-app since 7.2.

**Why it works for them.** iA Writer is where their users keep everything.

**Verdict: decline, except the tags.** A file browser is a second app inside the
app, and it fights minimark's whole posture: `⌘K` reaching recents (`ui.js:828`)
is the deliberate anti-Library, and the comment there argues the case well.
Building an Organizer means owning sidebar state, sync, drag and drop, and
Finder parity forever.

**But hashtags are nearly free.** `#tag` in the text, harvested on render into
the same picker, no sidebar, no state, no storage. It is a lens on the text,
which is the test everything in this document should pass.

---

## 3. Where minimark is already ahead

Worth stating plainly, because a study of a mature app tends to read as a list
of deficits.

| | minimark | iA Writer |
|---|---|---|
| **Live view** | click a paragraph, its markdown appears; click away, it renders | Editor and Preview are separate panes |
| **Themes** | six, including textured Cork and Steel (`ui.js:16-23`) | light / dark / night inversion |
| **Version history** | local, time-stepped, 1m to 1w (`ui.js:931`), with word deltas per revision | relies on the OS |
| **Style check** | every entry carries a `why` (`style-check.js:25`) | colours, no explanation |
| **Command palette** | present since early, everything in it | added in 8, alongside a menu bar |
| **Paste a web page** | arrives as clean markdown (Turndown) | **[verify in app]** |
| **Price** | free, MIT | $49.99 |

The `why` on every style-check entry is the best single decision in minimark's
codebase and iA does not have an equivalent. A highlight that will not say what
is wrong with the sentence is just a colour, as the file says. Do not lose that
when adding the lenses in 2.1: **the adverb lens must not gain a `why`**, because
there is nothing wrong with an adverb. That is precisely the line between a lens
and a critic, and it is worth writing into `style-check.js` as a comment before
someone helpfully adds tooltips.

---

## 4. Where minimark is actually behind

Ranked by what it costs a writer, in the house style.

**Tier 1, structural**

1. **No transclusion.** You cannot write anything longer than one file. (2.2)
2. **Three search surfaces where one belongs.** (2.4)

**Tier 2, daily friction**

3. **No tags.** No way to gather notes across files without wikilinking each. (2.7)
4. **Preview and export may not share a renderer.** **[verify in app]** (2.5)
5. **No running heads or page numbers in PDF.** (2.5)
6. **No lenses beyond the word lists.** (2.1)

**Tier 3, judgement calls**

7. **Five fonts, defaulting to a proportional one.** (2.6)
8. **No provenance for pasted text.** (2.3)

---

## 5. What I would actually do, in order

1. **Merge the three pickers into one `⌘K`.** Removes code, is the largest
   coherence win, breaks no muscle memory if `⌘R` and `⌘F` pre-fill prefixes.
2. **`![[file]]` transclusion.** One branch in the wikilink resolver. Unlocks
   long-form writing, which is the only category minimark currently cannot serve.
3. **Three lenses: adverbs, long sentences, repeated words.** Off by default,
   no `why`, no counter, no badge. Existing sentence splitter, existing colours.
4. **Hashtags into the merged picker.** Free organisation, zero sidebar.
5. **Ship two templates and make Preview render through them.**
6. **Change the default font to a duospace face, cut the list to three.**
7. **Paste provenance in the history store**, one lens, nothing in the file.

1 through 4 are each small. Together they change what the app is for.

---

## 6. What to deliberately not copy

- **A Library sidebar.** It is a second app. `⌘K` is the better answer and
  minimark already made that argument in a code comment.
- **Parts-of-speech colouring.** The refusal in `style-check.js:16` is right.
  Take the framing, leave the parser.
- **Authorship in the file.** The moment provenance is written into the `.md`,
  minimark owns a format, and every other editor renders it as noise.
- **Smart Folders.** Rules, persistence, and an empty state, in exchange for
  something a saved search in the picker does at a tenth the cost.
- **Six platforms.** iA's feature set is shaped by having to land everything on
  iPhone, iPad, Mac, Windows and Android. minimark is one platform and should
  spend that advantage rather than imitating the compromises it buys.

---

## 7. The seven things to verify with the app open

1. Does Preview render through the same template as Print and PDF export?
2. Where do Authorship annotations live: in the `.md`, or a sidecar?
3. What is the actual measure in characters, and does it change with window size?
4. Does pasting a web page produce markdown, or plain text?
5. Is Syntax Control per-class toggleable, or one switch?
6. What does the app do with a wikilink to a file that does not exist?
   (minimark's known gap, item 10 in the polish audit.)
7. How is Focus Mode's sentence detection handled at abbreviations and
   decimals? minimark's `sentences()` (`app.js:1115`) will have the same
   problem, and iA has had years to solve it.

---

## Sources

Secondhand, since `ia.net` was unreachable from this session.

- [Features, iA Writer support](https://ia.net/writer/support/basics/features)
- [Syntax Highlight, iA Writer support](https://ia.net/writer/support/editor/syntax-highlight)
- [Content Blocks, iA Writer support](https://ia.net/writer/support/library/content-blocks)
- [Markdown Content Blocks syntax spec](https://github.com/iainc/Markdown-Content-Blocks)
- [Authorship, iA Writer support](https://ia.net/writer/support/editor/authorship)
- [Authorship in Times of Artificial Intelligence](https://ia.net/topics/ia-writer-7)
- [Organize, iA Writer support](https://ia.net/writer/support/library/organize)
- [Custom Templates, iA Writer support](https://ia.net/writer/support/preview/custom-templates)
- [iA Writer Templates repository](https://github.com/iainc/iA-Writer-Templates)
- [From Monospace to Duospace](https://ia.net/topics/in-search-of-the-perfect-writing-font)
- [iA Fonts](https://github.com/iaolo/iA-Fonts)
- [Search to Navigate](https://ia.net/topics/search-to-navigate)
- [iA Writer 8 is Available for Mac, iPad, and iPhone, Thurrott](https://www.thurrott.com/mobile/mac-and-macos/337565/ia-writer-8-is-available-for-mac-ipad-and-iphone)
- [iA Writer 8: Growing Up With Care](http://bicycleforyourmind.com/ia-writer-8-growing-up-with-care)
- [iA Writer 4 Adds Markdown Content Blocks, MacStories](https://www.macstories.net/ios/ia-writer-4-adds-markdown-content-blocks/)
