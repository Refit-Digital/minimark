# Roadmap — what stands between minimark and "finished"

Rewritten 23 September 2026, against `main`, and kept current as things close. Ordered by what it costs a person, not by
what it costs to fix. Everything here was checked against the source or the running app today; where
something is unverified it says so, because a guess in this list is worse than an omission — somebody
will act on it.

Ground truth first, because it changes how the list should be read. `./build.sh` produces a clean
universal binary and `codesign --verify` passes. Every suite in `tools/` is green — fourteen files,
163 coordination assertions among them. Nothing below is breakage. It is the gap between an app that
works and an app that nobody has to be forgiving about.

The September audit this replaces is archived in `roadmap.rtfd`, with the screenshots that went with
it. Almost every item in it is now closed — see *What has landed* at the end.

---

## Tier 1 — costs someone their work, or their trust

Empty, for the first time. The four entries the September audit had here are closed, and the last
thing that belonged in it — a README that promised a build it could not deliver — was corrected on
23 September.

Keep it empty by being strict about what earns a place in it: something that loses a writer's text,
or tells them a thing that is not true.

---

## Tier 2 — friction a writer meets, or a claim the app cannot keep

### 1. Whether to hand anyone a build — a decision, not a task

`build/minimark.app` is ad-hoc signed: `Signature=adhoc`, `TeamIdentifier=not set`, and
`spctl --assess --type execute` returns **rejected**. macOS refuses a copy that arrives from anywhere
else and calls the app damaged, which is a worse message than "unsigned" and sends people looking for
a fault that is not there. There are no releases, and the README now says all of this and points at
`./build.sh`, which works with nothing but the command line tools.

So nothing is untrue, and this is a choice about reach rather than a defect:

- **Stay source-only.** Costs nothing. Anyone who can clone can build.
- **Notarize.** A Developer ID certificate and a notarising step in `build.sh`, and then a download
  works for strangers. Costs the Apple Developer Program yearly.

Only the second one makes item 4 below matter.

### 2. The flush that can land after the other process has read

`savePresentedItemChanges` is how another process asks us to put unsaved text on disk before it
reads. It hops to main and asks the web layer for the text, which is asynchronous; a timer answers
the other process at `kCoordinationTimeout` so it can never be held up forever. The write can
therefore still be in flight when that process proceeds — it reads the old bytes, and our text lands
a moment later.

Nothing has gone wrong in practice and no reproduction exists. It is listed because it is the one
piece of the coordination work that was reasoned about and never measured. A probe would register a
presenter, hold a coordinated read, and check what the reader saw against what landed.

### 3. Writers that do not coordinate still have a window

A save checks that the file still matches the version the document descends from, and does it while
holding the claim, so it is atomic against everything that coordinates. `git`, `vim`, `sed` and `cp`
do not coordinate, so between that check and the swap there is a window no lock can close. It is
narrow and it is inherent; the kernel watch and the content digest mean the app notices afterwards
rather than never. Worth knowing, not worth chasing.

### 4. No way to find out there is a new version

The Help menu has two items: Markdown Reference and Acknowledgements. There is no Check for Updates,
which is the right call while the only distribution is `git pull && ./build.sh`. It becomes a real
gap the day item 1 is answered with "notarize".

---

## Tier 3 — features that are absent rather than broken

Verified absent, not merely unfinished: **multiple windows** (no `NSWindowController`; one window,
tabs inside it), **Mermaid diagrams**, and **table row and column editing** — tables render, but there
is no way to add or remove a row from the editor.

These are additions. They belong on a different axis from everything above, and none of them is what
stands between the app and being unembarrassing.

---

## How this list is meant to be kept

The method matters more than any single entry. A claim here earns its place by being reproduced, not
by being plausible — three separate times during the coordination work a premise that "everybody
knew" turned out to be false when somebody measured it, and twice the measurement overturned the
person who wrote the briefing.

- **A suspicion with no reproduction is a guess.** Write it as a suspicion or leave it out.
- **Check the instrument before trusting a zero.** A test that measures nothing reports success.
  Every probe in `tools/` that claims an absence also demonstrates it can detect a presence.
- **A failed grep is not evidence of absence.** Several entries in the old audit were "still open"
  only because the thing had been renamed.
- **Test against the real code, never a copy.** `tools/coordination-test.js` extracts the app's own
  functions out of `minimark.swift` by balancing braces, so it cannot pass against a stale copy.

---

## What has landed since the September audit

Its Tier 1 is closed. Untitled documents are written to a crash-insurance folder and offered back at
launch; autosave failures are counted and said once in the status bar; a rename can no longer hide a
file behind a leading dot; and file coordination went from absent to hardened.

That last one ran as seven rounds of build-and-criticise, each judged against iA Writer 8.0.6 on one
document in a folder other processes were writing, and each verified in the running app rather than
only in a harness. A contended save used to freeze the app for 2,098 ms and then destroy the other
writer's bytes; it now holds nobody up and lands after the other writer lets go. A read during
somebody else's rewrite used to return 60% of a document; it returns all of it or nothing. A save no
longer destroys extended attributes or the creation date. A document that is deleted, renamed,
trashed or restored from an archive is noticed and handled. And a save that would replace somebody
else's work is refused and put to the writer, with both versions kept whichever way they answer —
which is more than the app it was measured against does.

A shortcut the menu advertised was worse than missing: ⌃Tab reached the page instead of the Window
menu, so it indented the line and marked the document unsaved rather than switching tabs. A view
gets first refusal on a key equivalent and WKWebView takes Tab; `EditorWebView.performKeyEquivalent`
now hands those two back to the menu, and plain Tab still indents.

From the old Tier 2 and Tier 3: the welcome text points at the controls that exist, `⌘,` is
"Appearance…", markdown is `Owner` for its document type, the heading outline has a resting state,
images arrive with an alt-text placeholder, a wikilink to a file that does not exist is drawn
differently, the history store loads off the main thread, sudden termination is declared, the About
panel has a real copyright line, and right-click gives a curated menu with WebKit's own items and the
Services submenu removed — with the developer-tools flags behind `#if DEBUG`.
