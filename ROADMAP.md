# Roadmap — what stands between minimark and "finished"

Rewritten 23 September 2026, against `main`, and kept current as things close; last touched on
26 September. Ordered by what it costs a person, not by what it costs to fix. Everything here was
checked against the source or the running app today; where something is unverified it says so,
because a guess in this list is worse than an omission — somebody will act on it.

Ground truth first, because it changes how the list should be read. `./build.sh` produces a clean
universal binary and `codesign --verify` passes. Every suite in `tools/` is green — seventeen files,
163 coordination assertions and 68 window ones among them. Nothing below is breakage. It is the gap
between an app that works and an app that nobody has to be forgiving about.

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

### 1. ~~Whether to hand anyone a build~~ — answered: source-only

Answered on 27 September: **minimark stays source-only.** Notarising costs an Apple Developer
subscription every year, and the reach it buys is not worth it for this.

So there are no releases and there will not be any. `build/minimark.app` is ad-hoc signed —
`Signature=adhoc`, `TeamIdentifier=not set`, `spctl --assess --type execute` returns **rejected** —
and macOS calls a copy that arrives from anywhere else *damaged*, which sends people hunting a fault
that is not there. Nobody should ever be handed one.

What replaces it is being findable and being easy to build on, which is a writing job rather than a
signing one: the README says plainly why there is no download, what the two halves of the app are,
where the bridge between them is, and how the tests prove they are still testing something. That is
the whole of the distribution story, and it is done.

This also closes item 6 below, which only mattered if the answer here had been "notarize".

### 2. Version history is shared between windows, and the last write wins

Local version history is one store for the app, and each page holds the whole of it as it loaded
it. Two windows each load it and each write all of it back, so snapshots taken in one window since
it opened can be lost when the other writes, and clearing a document's history in one window can
take another window's document out of the store with it.

No document is at risk — this is the net under the documents, not the documents — and it costs
nothing until somebody actually opens a second window, which until today nobody could. The fix is
to merge on the native side, keyed on the per-document entries, which means the native side taking
on the store's shape. That is a real commitment and it is the next thing worth doing here.

### 3. Appearance set in one window reaches the other at the next launch

Theme, font, size, mode and the toggles are the app's, and every window writes them, but the only
message the web layer has for preferences is the one the shell sends at launch: it turns zen, focus,
typewriter and style-check *on* and never off, and it restores a scroll position. Sending it to
another window mid-session would force those on and jump that window's scroll, so it is not sent.
Change the theme in one window and the other stays as it was until it is next opened. It needs a
live-preferences message in the web layer, which is small and has not been written.

### 4. The flush that can land after the other process has read

`savePresentedItemChanges` is how another process asks us to put unsaved text on disk before it
reads. It hops to main and asks the web layer for the text, which is asynchronous; a timer answers
the other process at `kCoordinationTimeout` so it can never be held up forever. The write can
therefore still be in flight when that process proceeds — it reads the old bytes, and our text lands
a moment later.

Nothing has gone wrong in practice. Tried on 24 September: another process took a coordinated read
of an open document every 0.2s while text was typed into it, and every read returned the current
text — it never saw the older version. That is reassuring and it is not proof, because a fast
autosave and a working flush look identical from outside; the test cannot tell which one answered.
Settling it needs a document held dirty across a read, which nothing can arrange from outside the
app. Left open, and small: the autosave lands about a second after a keystroke either way.

### 5. Writers that do not coordinate still have a window

A save checks that the file still matches the version the document descends from, and does it while
holding the claim, so it is atomic against everything that coordinates. `git`, `vim`, `sed` and `cp`
do not coordinate, so between that check and the swap there is a window no lock can close. It is
narrow and it is inherent; the kernel watch and the content digest mean the app notices afterwards
rather than never. Worth knowing, not worth chasing.

### 6. ~~No way to find out there is a new version~~ — closed by item 1

There is no Check for Updates in the Help menu, and now there should not be: with no releases to
check for, the only update is `git pull && ./build.sh`, and anyone doing that already knows. Closed
on 27 September along with item 1.

---

## Tier 3 — features that are absent rather than broken

Verified absent, not merely unfinished: **Mermaid diagrams**.

Multiple windows was here and is now done — ⌘N opens a window, ⌘T a tab inside one, windows close
independently, and the session remembers every window and puts them all back. What is still absent
inside it is **dragging a tab from one window to another**: a tab belongs to the window it was made
in, and moving a document between windows means closing it in one and opening it in the other, which
the one-file-one-place rule then makes safe rather than a second copy.

Table row and column editing was here and is now done — rows and columns can be added and removed
from the caret, in both views, from the Format menu and the palette.

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

Multiple windows landed on 26 September, in two commits: the window's state moved out of the app
delegate into a type of its own, and then ⌘N was given something to make. Two faults only the
running app could show up were found and fixed in the same day, and both are worth recording
because both were invisible to a passing test. Quitting with two windows open came back with one:
AppKit closes every window on the way out, and each close was rewriting the session to describe the
windows that were *left*, so the last one out left a session naming only itself. And closing one
window of two killed the app outright — a segmentation fault in a CoreAnimation commit, because a
window that is owned by something else still releases itself when it closes unless it is told not
to, and it was being released twice. Neither is reachable with one window, which is why neither had
ever happened.

A third fault came out of taking screenshots for the README, which is its own
argument for taking them. Every page comes up with the welcome document already in it — the web
layer puts it there at load, so that a window is never briefly blank — and with one window that was
invisible, because the session replaced it or it was the thing to show. ⌘N made it a second page,
and a new window greeted somebody who had used the app for a month with a wall of text to delete
before they could write. The same launch path also handed it back on every launch that happened to
have no session behind it. A new window now comes up empty, and the welcome document is shown once
on a fresh install and remembered.

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
