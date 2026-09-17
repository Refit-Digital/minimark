# iA Writer, studied

*What to take, what to leave, and what minimark already does better.*

Written 13 September 2026, against `ff36cc6`. Companion to the polish audit in
`roadmap.rtfd`: that one is about finishing what exists, this one is about
deciding what comes next.

---

## 0. How this was made, and what that costs

Two passes.

**Pass 1 (cloud session).** No app, no Desktop, `ia.net` blocked. Built from
iA's published design writing reached through search, third-party reviews, and
a close read of minimark's source. Seven claims were tagged **[verify in app]**.

**Pass 2 (on the Mac, same day).** iA Writer **8.0.6 (build 80046)** at
`~/Desktop/iA Writer.app`. Permission to drive the app's UI was declined, so
nothing here comes from clicking around. Everything in pass 2 comes from the
bundle itself, which is first-hand and more complete than a UI tour:

- the bundled Help (`Base.lproj/Help/*.html`: Markdown, Wikilinks, Content
  Blocks, Metadata, Custom Patterns, Keyboard Shortcuts, Smart Folder Rules,
  URL Commands, Shortcuts, Publishing, Word export) and release notes
- every UI string table (`Localizable.strings`, `Kit.strings`,
  `Markdown.strings`, `AppIntents.strings`, `SmartFolderRules.strings`)
- the menu and settings nibs (`Menu.nib`, `EditorPreferences.nib`,
  `MarkdownPreferences.nib`, `TemplatePreferences.nib`, `Annotations.nib`…)
- the six shipped template bundles (`Resources/Templates/*.iatemplate`)
- the bundled `writer` command-line tool (`Contents/MacOS/writer`)

**Pass 3 (cloud session).** Building the first item on the list, §2.4, which
turned up a claim both earlier passes got wrong about minimark's own code. That
section now records what shipped rather than what was planned.

Six of the seven open questions are answered (§7). Where a later pass
contradicted an earlier one, the text below has been corrected and says so.
Claims about **minimark** cite file and line and are checked.

---

## 1. The thesis

Strip the feature list away and iA Writer is one idea held very hard:

> **The text is the interface. Everything else is a lens on it.**

Nothing in the app is a mode that changes the file. Focus mode dims; it does not
edit. Syntax Control colours; it does not rewrite. Preview renders; it does not
own. Every feature is reversible, non-destructive, and describable in one
sentence to somebody who has never used the app.

**One exception, confirmed in pass 2:** Authorship writes annotations into the
file (§2.3), and iA then has to ship a "Misplaced Authorship" warning for when
another app edits it. That is the cost of breaking the thesis, printed in their
own string table. It is the best evidence in this document that the thesis is
worth holding.

Minimark shares the instinct already. Live view (`app.js`) is exactly this:
one surface, the markdown revealed on demand, never a second document. The
question for the roadmap is not "which iA features do we clone", it is
**"which lenses are missing, and which of ours are not yet lenses"**.

---

## 2. The seven ideas worth taking

### 2.1 Syntax Control: parts of speech as a lens

**What it is.** Colour adjectives, nouns, adverbs, verbs, conjunctions.
**Verified:** each class is its own toggle (`selectSyntaxControlTarget:` per
class in `Menu.nib`; five checkboxes in `EditorPreferences.nib`), plus
*Enable All*, *Disable All* and *Enable Last Used*. The last one is the
detail worth stealing: switching a lens off and on again restores the set you
had, rather than making you rebuild it.

**Why it works.** It never says a word is wrong. It shows you the distribution
and lets you draw the conclusion. A critic gets switched off, a lens gets
switched on.

**What it costs.** A part-of-speech tagger. minimark deliberately refused this
in `style-check.js:16-21`, and the reasoning there is correct.

**Verdict: take the framing, not the parser.** Three lenses are decidable
without a tagger:

| Lens | Rule | Precision |
|---|---|---|
| Adverbs | words ending `-ly` minus a ~40-word stoplist (`only`, `family`, `reply`, `apply`, `supply`, `rely`, `july`, `italy`…) | high |
| Long sentences | reuse `sentences()` (`app.js:1115`); tint anything over ~30 words | exact |
| Repeated words | any non-stopword appearing 3+ times within a 200-word window | exact |

**The important part is that these are lenses, not warnings.** Off by default,
toggled from `⌘K`, no badge counting your sins, and "last used" remembered.

### 2.2 Content Blocks: transclusion

**What it is.** A line that is just a filename embeds that file: image, CSV as
a table, source as a code block, `.txt`/`.md` as prose. Optional caption in
quotes after it.

**Corrected in pass 2:**

- **iA already supports `![[file]]`.** `Kit.strings` has *"Wikilink embeds
  must be Markdown files or images."* So the syntax recommended below is not
  minimark diverging from iA; it is the form iA added later, beside the
  original.
- **The leading `/` is deprecated.** Content blocks now take the bare filename
  (shortest unique path) or `./relative`. An old `/` block raises a specific
  upgrade warning.
- **The failure cases each have their own message**: file does not exist,
  unsupported extension, recursive reference (*"Recursive references are
  ignored"*), CSV with fewer than two rows, file outside the Library. That list
  is a ready-made spec for minimark's error states.
- **Blocks take metadata.** Lines after an image block set `Title`, `Alt`,
  `Width`, `Height`; after a text block they set variables for that inclusion
  only (§8, metadata variables).

**Done**, as `![[chapter-two]]`. Shipped on this branch:

- **Block level, on a line of its own.** A line with an embed and prose on it
  is prose, and keeps rendering as it does today.
- **Markdown, text, CSV and images.** A CSV becomes a table, parsed properly
  (quoted commas, doubled quotes, newlines inside cells), and iA's
  fewer-than-two-rows error is taken as written. An image needs no round trip:
  it is a `src`, resolved against the document's folder the way `![](…)`
  already is.
- **`![[name|A caption]]`** draws the caption under it.
- **Descent allowed, as argued below.** `wikiURL` now takes `chapters/one`.
  It still refuses `..` in any position, a leading `/` or `~`, a dotfile at any
  depth, a colon or backslash, more than sixteen components, and anything that
  leaves the tree **by following a symlink** — that last one is new, and is
  what widening the rule makes worth planting. The containment check resolves
  symlinks on both sides before comparing, which `standardizedFileURL` alone
  does not.
- **One round trip a render**, batched and cached per folder, the same shape as
  the wikilink existence check it sits beside. What is cached is the rendered
  node, not the file's text, so a long chapter is not re-parsed every keystroke.
- **Every failure names the file and the reason** (missing, unreadable,
  too-big, outside the folder, wrong kind, thin CSV), rather than leaving a
  placeholder that could also mean "still loading".

**One deliberate limit: embeds go one level deep.** An embed inside an embedded
file is replaced with a note saying so. That makes a cycle impossible by
construction rather than by a guard someone has to keep correct, and a
manuscript embedding its chapters is one level, which is the case this is for.
iA instead nests and ignores recursion; if minimark ever wants that, the note
is where to start.

**Known gap:** an embedded file edited in another window does not refresh until
the folder changes or a wikilink creates a file. minimark watches the document's
own file, not its embeds. Worth a pass when the file-coordination work in the
polish audit happens, since that is the same machinery.

37 assertions in `tools/embed-test.js` for the web layer, 24 in
`tools/embed-path-test.js` for the Swift resolver.

### 2.3 Authorship: what did you actually write

**What it is.** Tracking of which text was typed, pasted, or came from AI or a
reference. Human authors in pastel tones, AI in a gradient, reference dimmed.
Menus: *Mark As*, *Paste As*, *Paste Edits From* (diffs pasted text against
the selection and attributes only the changes).

**Verified (was [verify in app]):** *"Authorship annotations will be saved at
the end of the file. Hidden when editing in iA Writer, and visible in other
apps."* (`Kit.strings`, `Annotations.nib`). And the consequence: *"This file
was edited by another app that did not correctly update authorship
annotations. Some or all authorship may be misplaced."* Also: iA detects a
pasted ChatGPT conversation and offers to attribute it automatically, and
8.0.5 shipped a `writer` CLI so agents can edit files *"while preserving
authorship"*. That is a whole toolchain built to protect data that lives
somewhere fragile.

**Verdict: take the narrow version, keep it out of the file.** Unchanged, and
now proven:

- On paste, record the range and its source.
- Store it **in the history store, not the file** (`ui.js:931`).
- One lens in `⌘K`: "Show what was pasted". Ranges tint, hover says when.

The *Paste Edits From* idea is worth a note on its own: paste a revised
version over a selection and only the differences change. Useful without any
authorship at all (§8).

### 2.4 One search field, not three

**What it is.** iA Writer 8 folded document outline into Quick Search:
**`⇧⌘O`**, reaching headings, filenames and full text. **8.0.5 added result
filters** (*Show results from: Headings / Text*, separately for *This File* and
*Other Files*). ⌘-clicking a `#hashtag` opens Quick Search on it.

**Corrected in pass 2:** pass 1 said the command palette sits at `⇧⌘P`. The
bundled shortcut list has `⇧⌘P` as *Page Setup*. The palette exists
(`Commands.strings`: *"Command Palette"*, *"Search Commands"*); its shortcut is
not in the bundled help.

**Why it mattered here.** minimark had three finder surfaces. Two of them were
the same widget twice, and the third was not:

| Surface | Key | Was |
|---|---|---|
| Command palette | `⌘K` | `openPalette`, via `openPicker` |
| Jump to heading | `⌘R` | `openHeadings`, via `openPicker` |
| Find and replace | `⌘F` | `openFind`, its own bar |

**Corrected in pass 3:** passes 1 and 2 both said all three shared the picker.
They did not, and the difference decides the design. Find paints every match in
both views at once, steps through them, replaces, and tears its highlight layers
down on a view switch. Absorbing it into a results list would have cost all of
that. It is a different interaction that happens to start with typing.

**Done.** Shipped on this branch:

- One field on `⌘K` holding commands, the document's headings and the recent
  files, competing on one score.
- Sigils narrow: `>` commands, `#` headings, `/` files. One character, and
  nothing lost by never learning them. iA's 8.0.5 result filters are the
  evidence that people want to narrow; sigils do it without a settings row.
- `⌘R` opens the same field with `#` already typed, so the shortcut people
  have in their fingers still lands on the outline. A document with no headings
  says so in the list instead of refusing with a toast.
- Find keeps its bar. Two or more characters typed offers `Find "…" in this
  document` as the **last** result, handing the query over. The one field
  reaches it without pretending to be it.
- An empty field opens on the document's headings rather than the head of the
  command list: where you are is more useful than what you could do.

No group headers in the list. A heading already carries its level, a recent file
already carries the word Recent, a command already carries its shortcut; labels
on top of that would be chrome describing chrome.

100 lines added, 24 removed, one concept removed. 38 assertions in
`tools/picker-test.js`. Wikilink targets and text matches from other files still
want the shell, and are the natural next additions to the same field.

### 2.5 Templates as bundles

**What it is, verified from the shipped bundles.** A template is a `.iatemplate`
directory: `Info.plist` naming its pages (`IATemplateDocumentFile`,
`IATemplateTitleFile`, `IATemplateHeaderFile`, `IATemplateFooterFile`, plus
`IATemplateHeaderHeight`/`FooterHeight`, both `90`), and HTML pages with data
hooks the app fills: `data-document`, `data-title`, `data-author`, `data-date`,
`data-page-number`. Six ship: Duo, GitHub, Mono, Quattro, Sans, Serif.

**Corrected in pass 2 (was [verify in app]):** Preview and export do **not**
share one renderer by construction. Settings has **separate template choices
for *Web Preview* and for *Printing & PDF Export*** (`TemplatePreferences.nib`).
What iA did instead is give Preview **two display modes, *Web* and *PDF***
(`Display_Mode_Web`, `Display_Mode_PDF`), with *Fit Width*, *Fit Page* and zoom
in PDF mode. You check the print output by looking at the print output.

Template settings, all toggles, no CSS required: **title page, headers,
footers, center headings, number headings, indent paragraphs, invert colours
at night.**

**Verdict: finish what minimark started, the iA way.** minimark has a
templates folder, a user stylesheet (`fd1f671`) and HTML/PDF/print. The gaps:

- **A PDF mode in Preview**, rendering the print path, rather than trying to
  force the live preview and the PDF to be the same thing. Cheaper and more
  honest.
- **Header/footer/title page** from front matter (`title`, `author`, `date`),
  so PDFs get a running head and page numbers.
- **Number headings** and **indent paragraphs** as the two typographic
  toggles worth having; they are the ones that change what a document is for.
- **Ship two templates.**

### 2.6 Typography as a decision, not a preference

**Corrected in pass 2:** iA no longer ships one font. The editor offers three
faces of one family: **Mono, Duo, Quattro** (`TypographyKit.strings`), and
templates add IBM Plex Sans and Serif for output. There is no System font and
no unrelated faces in the editor. Other settings: *Line length limit* (in
characters), *Emphasis* (italic or CJK emphasis mark), *Tradition*
(Japanese, Korean, Simplified/Traditional Chinese typesetting), highlight
colour.

**Where minimark stands.** Five unrelated fonts: System, New York, Iowan,
Avenir, Mono (`ui.js:25-36`), default `system` (`ui.js:43`); eight sizes; six
themes; measure `42rem` (`styles.css:57`).

**Verdict: iA's current position is the softer option pass 1 proposed**, so
the recommendation firms up: **three faces from one family, mono-leaning
default.** `iA Writer Mono/Duo/Quattro` are open-licensed on GitHub
(`iaolo/iA-Fonts`), or IBM Plex Mono/Sans/Serif. The point stands that the
default should make a draft look like a draft.

### 2.7 The Library, and why to say no

**What it is.** A left-hand Organizer: Locations, Favorites, Smart Folders,
Hashtags, and **Links** (*Backlinks*, *Potential Backlinks*, *Links*,
*Potential Links*). Smart Folders are rules on parent path, ancestor path,
kind, extension, dates, and a full search language (`#tag`, `[ ]` open tasks,
`NEAR(time space)`, `name:`, `AND/OR/NOT`).

**Verdict: decline the sidebar, take three things out of it.** Hashtags into
the picker (unchanged). **Backlinks** and **open-task search** are the two new
ones, both in §8, both delivered through the picker rather than a pane.

---

## 3. Where minimark is already ahead

| | minimark | iA Writer |
|---|---|---|
| **Live view** | click a paragraph, its markdown appears; click away, it renders | Editor and Preview are separate panes |
| **Themes** | six, including textured Cork and Steel (`ui.js:16-23`) | light / dark, invert in Preview |
| **Version history** | local, time-stepped, word deltas per revision (`ui.js:931`) | none found in the bundle; relies on the OS |
| **Style check** | every entry carries a `why` (`style-check.js:25`) | Fillers, Clichés, Redundancies, Custom; four languages; colours, no explanation |
| **Paste a web page** | arrives as clean markdown (Turndown, `app.js:1696`) | no HTML-to-Markdown paste found in the bundle; iA ships a Shortcut, *Open Clipboard*, that does the conversion instead. Still worth one runtime check |
| **Paste an image** | saved beside the document | content blocks, Library only |
| **Wikilink safety** | a name can never become a path (`minimark.swift:5170`) | Library Paths, auth tokens for URL commands |
| **Price** | free, MIT | $49.99 + subscription account system (`AccountKit.strings`) |

The `why` on every style-check entry is still the best single decision in
minimark's codebase. **The adverb lens must not gain a `why`**, because there
is nothing wrong with an adverb. Write that into `style-check.js` as a comment.

---

## 4. Where minimark is actually behind

**Tier 1, structural**

1. ~~No transclusion.~~ **Done.** (2.2)
2. ~~Three search surfaces where one belongs.~~ **Done.** (2.4)

**Tier 2, daily friction**

3. **No backlinks.** Wikilinks go one way. (8.1)
4. **No tags.** (2.7)
5. **No way to see the PDF before exporting it.** (2.5)
6. **No running heads or page numbers in PDF.** (2.5)
7. **No lenses beyond the word lists.** (2.1)

**Tier 3, judgement calls**

8. **Five unrelated fonts, defaulting to a proportional one.** (2.6)
9. **No provenance for pasted text.** (2.3)

---

## 5. What I would actually do, in order

1. ~~**Merge the three pickers into one `⌘K`.**~~ **Done.** See §2.4 for what
   changed from the plan and why.
2. ~~**`![[file]]` transclusion**, allowing subfolders.~~ **Done.** See §2.2,
   including the one-level limit and the refresh gap.
3. **Backlinks in the picker** (8.1). Cheap once 1 exists.
4. **Three lenses: adverbs, long sentences, repeated words.**
5. **Hashtags and open tasks into the merged picker.**
6. **Smart punctuation on output only** (8.3). One pass, zero risk to the file.
7. **Header/footer/title page, and a PDF mode in Preview.**
8. **Three faces of one family, mono-leaning default.**
9. **Paste provenance in the history store.**

1 through 5 are each small. Together they change what the app is for.

---

## 6. What to deliberately not copy

- **A Library sidebar.** `⌘K` is the better answer, and minimark already made
  that argument in a code comment (`ui.js:834`).
- **Parts-of-speech colouring.** The refusal in `style-check.js:16` is right.
- **Authorship in the file.** Now confirmed as iA's design, and confirmed as
  costly: a misplaced-authorship detector, a CLI to preserve it, an in-app
  prompt before enabling it per file.
- **Smart Folders.** A saved search in the picker does it at a tenth the cost.
- **Publishing to WordPress, Ghost, Medium, Micro.blog, Micropub.** Accounts,
  OAuth, and five APIs to track forever. *Copy as HTML* (8.2) covers the need.
- **An account and subscription system.** `AccountKit` handles trials,
  device limits and release channels. Not a feature; noted because it is a
  lot of the bundle.
- **`single return starts a new paragraph`.** iA keeps it only for
  compatibility and says so in the setting. Do not add a setting to be
  incompatible with Markdown.
- **Six platforms.** minimark is one platform and should spend that advantage.

---

## 7. The seven questions, answered

| # | Question | Answer | Source |
|---|---|---|---|
| 1 | Does Preview render through the same template as Print and PDF? | **No.** Separate template settings for *Web Preview* and *Printing & PDF Export*. Preview has a *PDF* display mode to show the print output. | `TemplatePreferences.nib`, `Kit.strings` |
| 2 | Where do Authorship annotations live? | **At the end of the `.md` file**, hidden in iA, visible elsewhere. Edits by other apps trigger *Misplaced Authorship*. | `Kit.strings`, `Annotations.nib` |
| 3 | What is the measure? | **A user setting, *Line length limit*, in characters.** The available values are not readable from the nib. | `EditorPreferences.nib` |
| 4 | Does pasting a web page produce Markdown? | **Probably not by default.** No HTML-to-Markdown paste path in the strings; conversion is offered as a Shortcut instead. Needs one runtime check. | `Shortcuts.html` |
| 5 | Is Syntax Control per class? | **Yes**, five independent toggles plus All / None / Last Used. | `Menu.nib`, `EditorPreferences.nib` |
| 6 | Wikilink to a file that does not exist? | **Opens a new document with that name, ready to type**, no prompt. minimark offers the same but asks first (*Create “name.md”?*, `minimark.swift:5246-5256`), deliberately. Keep the prompt; a click should not write a file silently. | `Keyboard Shortcuts.html` |
| 7 | Focus sentence detection at abbreviations and decimals? | **Still open.** Needs the running app. Test: `Dr. Smith paid $3.50 on 1.2.2026. Then left.` | — |

---

## 8. Further features worth cloning

Found in pass 2 and not covered above. Each was checked against minimark's
source; "absent" means a search of `app.js`, `ui.js` and `minimark.swift` found
nothing. Grouped by fit with the thesis, then by cost.

### 8.1 Linking

- **Backlinks and potential backlinks.** iA lists files that link to this one,
  and files that *mention its name without linking*. The second is the clever
  half: it finds connections you forgot to make. For minimark it is a `⌘K`
  section, "Links here", built by the shell scanning the folder (it already
  owns the folder and batches existence checks, `minimark.swift:5209`).
  Absent. **Cost: small. Fit: a lens on the folder.**
- **Wikilink autocomplete on `[[`.** A list of matching files; `⏎` inserts and
  moves past `]]`, `⇥` inserts and stays. Absent. **Cost: small** (the picker
  already exists).
- **Select text, press `[` twice to wrap it in `[[ ]]`.** minimark already
  auto-pairs `[` (`app.js:2128`); this is one more case. **Cost: trivial.**
- **Suffixes after the link:** `[[link]]s` renders as *links*. minimark's
  tokenizer (`app.js:323`) would need to absorb trailing letters into the
  label. **Cost: trivial.**
- **Back and forward between documents, `⌃⌘←` / `⌃⌘→`.** Following wikilinks
  without a way back is a one-way street. Absent. **Cost: small**, in the
  shell.

### 8.2 Editing

- **Move line up/down, `⌥⌘↑` / `⌥⌘↓`.** Absent. **Cost: trivial.**
- **Move caret by sentence, `⌥⌘←` / `⌥⌘→`**, with `⇧` to select. minimark
  already knows where sentences are (`sentenceAt`, `app.js:1266`), so select
  the sentence and delete it is two keys. Absent. **Cost: small.**
- **Mark task complete, `⌥⌘X`**, and **completed tasks fade or strike
  through** (a setting with two values). A lens on a task list. Absent.
  **Cost: trivial.**
- **Paste Edits From.** Paste a revised version of a passage over the
  selection; only the changed words change, so undo is granular and history
  shows a real diff. minimark already has a line differ for history
  (`ui.js:1001`). **Cost: medium. Fit: very good** for anyone who edits
  elsewhere and pastes back.
- **Copy as HTML** beside *Copy as rich text* and *Copy as markdown*
  (`ui.js:868-869`). This is iA's real answer to publishing. Absent.
  **Cost: trivial.**
- **Make Title Case.** One command. **Cost: trivial.**
- **Read aloud** (*Start Speaking*). Hearing a draft catches what reading does
  not. `NSSpeechSynthesizer` from the shell, speaking the selection or the
  focused paragraph. Absent. **Cost: small. Fit: a lens for the ear.**

### 8.3 Output

- **Smart punctuation on output only.** *"Convert straight quotes and plain
  dashes into smart counterparts for all formatted output."* The source keeps
  `"` and `--`; Preview, PDF and HTML get `“ ”` and `—`. This is the thesis in
  one setting: the file stays plain, the page is typeset. Absent. **Cost:
  small** (a `marked` post-pass that skips code). **Do this one.**
- **Metadata variables.** Front matter `Author: Jane` plus `[%Author]` in the
  text, substituted in Preview and export. Global defaults in settings,
  document values override, content-block values override both. minimark
  already parses front matter into a card. Absent. **Cost: small.** Useful for
  letters and templates, and it feeds headers/footers (2.5).
- **Page break `+++`** for PDF and print. Absent. **Cost: trivial** (a
  `break-after: page` div).
- **Table of contents block.** iA has *Add Table of Contents*; minimark
  already builds the heading list for `⌘R`. Absent. **Cost: small.**
- **Highlight `==text==`**, **superscript `^`**, **subscript `~`**. Absent
  (minimark has footnotes `app.js:658` and definition lists `app.js:616`).
  **Cost: trivial each.** Highlight is the one people use.
- **Citations** `[p. 23][#Doe:2006]`, rendered as endnotes. **Cost: medium.**
  Only if minimark targets academic writing.
- **Output rules for private syntax.** Wikilinks export as plain text
  (*"connections hidden from everyone else"*), hashtags as span, text, or
  removed. A note's scaffolding should not leak into the published page.
  **Cost: trivial. Fit: exact.**
- **Project archive export**: a zip with every transcluded file. Only matters
  after 2.2. **Cost: small.**

### 8.4 Stats

- iA offers: characters, characters without spaces, words, **sentences**,
  **reading time**, **speaking time**, **tasks (done / total)**, and a
  *Stats Only* status bar. minimark cycles words, characters and reading time
  (`app.js:988-1000`). Worth adding: **tasks 3/7** (turns a checklist into
  progress) and **speaking time** (for talks). **Cost: trivial.**
- **Stats for the selection.** Not confirmed in the bundle; common enough to
  be worth doing regardless. **Cost: trivial.**

### 8.5 Style check

- **Custom patterns.** A user list of words to dim and strike, with context
  (`custom ~~filler~~` only flags *filler* after *custom*), exceptions
  (`-pattern` switches a built-in off), and a safe regex subset. minimark's
  version keeps its principle: **a custom pattern's `why` is whatever the user
  writes beside it**, so every highlight can still explain itself.
  **Cost: medium.**
- **Clichés** as a category, beside fillers and redundancies. Worth checking
  against minimark's current lists. **Cost: small** (content, not code).

### 8.6 Automation

- **A URL scheme**: `minimark://open?path=`, `new?text=`, and
  `add?path=&text=` (append a line, a sentence or a paragraph). Gives
  Shortcuts, Raycast and Alfred a way in: *add to diary with today's date* is
  one shortcut. iA's `add` padding modes (`sentence`, `line`, `paragraph`) are
  the part worth copying exactly. **Cost: small** in Swift. Auth is needed only
  for commands that read data back; minimark could simply not have those.
- **A `minimark` CLI.** iA added one in 8.0.5 for coding agents. For minimark,
  `minimark open file.md` via the URL scheme is enough. **Cost: trivial after
  the URL scheme.**

### 8.7 Windows and tabs (relevant to the `tabs` branch)

- iA uses **native macOS tabs**: *New Tab*, *Show Tab Bar*, *Show All Tabs*
  (tab overview). minimark currently sets `tabbingMode = .disallowed`
  (`minimark.swift:2283`). Worth checking whether the tabs work can lean on
  `NSWindow` tabbing for the tab bar and overview for free.
- **External change while editing**: iA offers *Keep iA Writer Version*,
  *Revert*, *Save As*. minimark already reloads and has careful conflict
  handling (`minimark.swift:956-1116`); the three-button choice is a UI worth
  comparing against when both sides changed.

### 8.8 Seen and declined

Emphasis marks and CJK typesetting traditions (right for iA's market, not
minimark's yet), Word `.docx` export (expensive; HTML covers most of it),
Library Locations and `[[Location: link]]` (needs the Library), Smart Folder
query language (needs the Library), dock icon appearance, three-finger swipe
to show panes, auth-token-protected URL reads.

---

## Sources

**Pass 2, first-hand** (iA Writer 8.0.6, build 80046, `pro.writer.mac`):
`Contents/Resources/Base.lproj/Help/*.html`, `Base.lproj/News/*.html`,
`en.lproj/*.strings`, `Base.lproj/*.nib`,
`Frameworks/{Kit,Markdown,TypographyKit,Commands}.framework/Resources/*.strings`,
`Resources/Templates/*.iatemplate`, `MacOS/writer --help`.

**Pass 1, secondhand:**

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
