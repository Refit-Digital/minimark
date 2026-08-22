# minimark development plan

Written 8 August 2026. Covers the next 4 to 6 weeks.

**Goal: a public open-source release on GitHub.** No monetisation, no licensing
code, no trial, no App Store, no sandbox refactor. Three things matter instead:
the repo has to be legally publishable, the app has to stop losing people's
work, and a stranger has to be able to clone it and build it in one command.

---

## Where minimark actually is

Better than expected on code quality. Worse than expected on everything that
makes a repo public-ready. All of the below was verified against the source, not
assumed.

**Strong.** No force-unwraps, no `try!`, no `as!`, no `fatalError` anywhere in
1,943 lines of Swift. No retain cycles. Zero debug logging in either layer. The
whole bridge contract from `NATIVE-SHELL-BRIEF.md` is implemented in both
directions, plus Open Recent, print, PDF export, native drag-and-drop and an
allowlist HTML sanitiser that were never in the spec. The version history test
suite extracts the shipped source rather than duplicating it, which is the right
way to do it and better than most projects this size manage.

**Blocking a public release.** There is no git repository at all, on 5,000 lines
of working code, with two dated backup folders doing that job badly. There is no
`LICENSE`, no `README`, no `NOTICES`. Third-party licence headers have been
stripped from three of the four vendor files. `test-images/node_modules/` is
committed. `test-history/mod.js` is a generated artefact sitting next to its
sources. Three of the four image tests hardcode a dead sandbox path from a
previous session and throw `ENOENT` on any machine, so that suite has been
silently non-functional. The build recipe is a two-line comment at the top of
`minimark.swift` and produces an arm64-only binary that will not launch on an
Intel Mac. `minimark-build/icon/` is empty and there is no icon source anywhere.

**Dangerous.** `readText` at `minimark.swift:919` falls back to
`String(decoding:as:)`, which silently substitutes replacement characters for
undecodable bytes. Open a Latin-1 or UTF-16-without-BOM file, type one
character, and the autosave a second later overwrites the original with the
mangled text. There is no undo for that on disk. Separately, a save failure
during autosave pops a modal sheet, and because the document stays dirty every
keystroke reschedules, so a file on an ejected volume produces an alert roughly
once a second.

---

## Decisions made

### Licence: GPL-3.0

Any fork that ships must also ship its source. Three consequences to plan
around:

- **The four dependencies are all compatible.** marked (MIT), KaTeX (MIT),
  Turndown (MIT) and highlight.js (BSD-3-Clause) are permissive and can be
  combined into a GPL-3.0 work. Their notices still have to be preserved
  alongside yours, which is what `NOTICES.md` in Phase 0 is for. GPL-3.0 on your
  code does not replace their attribution requirements, it sits on top of them.
- **The Mac App Store door is now closed.** Apple's terms conflict with GPL-3.0.
  Not a loss given the direction, but worth knowing it is a one-way choice
  unless you relicense.
- **Relicensing gets hard the moment someone else contributes.** Today you are
  the sole copyright holder and can change your mind freely. Once outside
  patches land, you cannot relicense without every contributor's agreement. If
  you want to keep that option open, you would need a contributor licence
  agreement, which most projects this size skip and which adds friction for
  contributors. Reasonable either way, but decide before the first pull request
  rather than after.

### Notarisation: skipped

No Apple Developer Program, no £79 a year. This is fine, but the friction is
worse than it used to be and the README has to be accurate about it.

**Keep the ad-hoc signature.** `codesign --sign -` must stay in the build
script. Since macOS 15.1, a genuinely *unsigned* app is blocked outright with
"The application does not have permission to open" and no override anywhere. An
ad-hoc signed app is still signed, just not with a Developer ID, so it keeps the
override path. Dropping the signing step to save a line would make the app
unopenable.

**The right-click Open trick is gone.** macOS Sequoia removed the Control-click
bypass. The current path is System Settings, Privacy & Security, scroll to
Security, Open Anyway, then confirm. That is what goes in the README, not the
old advice.

**Building from source has no friction at all.** No quarantine attribute is ever
set, so nothing to bypass. For a GPL project that is the natural primary path,
and the `build.sh` in Phase 2 is what makes it a one-command job. Lead the
README with it and treat the release binary as the secondary option.

If you ever revisit notarisation, `build.sh` only needs `--options runtime
--timestamp` and a `notarytool` step bolted on. Worth keeping the script shaped
so that stays a small change.

---

## Phase 0, week 1: make the repo publishable

Nothing else can happen until this is done, and none of it is hard.

- [ ] `git init`, first commit, push to GitHub. Do the first commit **before**
      deleting anything, so the current state is recoverable.
- [ ] `.gitignore` covering `node_modules/`, `backup-*/`, `.DS_Store`,
      `minimark.app/Contents/MacOS/minimark`, `test-history/mod.js`, `build/`.
      Note that the compiled binary should not be committed, which means the
      build script in Phase 2 is what makes the repo usable, not optional.
- [ ] `git rm -r --cached test-images/node_modules` and add a `package.json` so
      contributors run `npm install` instead. There is already a `.gitignore`
      listing `node_modules/` in that folder, with no git repo for it to apply
      to.
- [ ] **`LICENSE`** containing the full GPL-3.0 text, plus a real copyright line.
- [ ] **GPL header block** at the top of `minimark.swift`, `app.js`, `ui.js`,
      `styles.css` and `index.html`. GPL-3.0 expects a per-file notice naming
      the program, the copyright holder and the licence. Skipping it is common
      and weakens the licence, so do it once now while there are five files.
- [ ] **`NOTICES.md`** with full licence text for marked 12.0.2 (MIT), KaTeX
      (MIT), highlight.js (BSD-3-Clause) and Turndown (MIT). BSD-3-Clause
      requires the copyright notice and disclaimer be reproduced in accompanying
      materials, so this is a hard requirement rather than a courtesy. Record
      the exact version of each so upstream security advisories can be tracked.
      Only marked currently records its version anywhere.
- [ ] Restore the stripped licence headers in `vendor/katex.min.js`,
      `vendor/hljs.min.js` and `vendor/turndown.js`. Confirmed stripped: the
      hljs file begins straight into minified code with no header.
- [ ] Add an Acknowledgements item to the About panel pointing at `NOTICES.md`.
- [ ] **`README.md`.** Screenshot at the top, the version history feature
      described properly because it is the genuine differentiator, then
      **build-from-source as the primary install path** because it has no
      Gatekeeper friction at all. Below it, the release binary with the correct
      current instructions: System Settings, Privacy & Security, Security, Open
      Anyway. Do not write the old right-click Open advice, it stopped working
      in Sequoia. State plainly that minimark collects nothing and makes no
      network requests, and that it is GPL-3.0.
- [ ] Delete `test-history/mod.js` (generated). Fix or delete `cadence.js` and
      `vharness.js`, which `require` `./v-old.js` and `./v-new.js`, neither of
      which exists, and which `run.sh` does not invoke.
- [ ] Fix the dead absolute paths in `test-images/fiximages.js:4`, `insert.js:5`
      and `mdlink.js:2`. They point at `/sessions/epic-zen-hopper/...`. `run.sh`
      already does `cd "$(dirname "$0")"`, so these become
      `'../minimark.app/Contents/Resources/app.js'`. One line each.
- [ ] Turn off the dev tools before strangers get the binary.
      `developerExtrasEnabled` at `minimark.swift:601` and `isInspectable` at
      `:619` are both unconditionally true. Wrap in `#if DEBUG`.
- [ ] `Info.plist`: real `NSHumanReadableCopyright` (it is currently the literal
      string `minimark`), `LSHandlerRank` to `Owner` for markdown so minimark
      can actually become the default `.md` app, add
      `NSSupportsSuddenTermination`.

**Done when:** the repo can be made public without a licence problem, and
`test-history/run.sh` and `test-images/run.sh` both pass on a clean clone.

---

## Phase 1, week 2: stop it eating documents

These are the bugs that turn a curious first-time user into a GitHub issue
titled "lost my file". All are small, contained fixes.

- [x] **Lossy decode into destructive autosave.** Done, 22 August, and the
      shape it took differs from the plan above in one way worth recording.

      The decode chain is as planned: UTF-8 strictly, then a byte-order mark,
      then whatever the system can identify, then Latin-1. But Latin-1 never
      fails — every byte is a valid Latin-1 character — so "refuse rather than
      mangle" has nothing left to catch, and read-only would punish a large
      number of perfectly ordinary 8-bit files.

      The corruption was never really in the read. It was in reading Latin-1
      and writing UTF-8. So the encoding is now remembered per tab and the
      file is written back in it, which round-trips every byte. Type something
      the old encoding cannot hold and the file is promoted to UTF-8 and says
      so, which is the only direction that loses nothing. The status bar names
      the encoding whenever it is not UTF-8.

      What *is* now refused is a file that is not text at all: a NUL byte
      outside a UTF-16 or UTF-32 file. Opening a PNG and letting autosave have
      it was the same data loss by another road, and nothing had stopped it.

      `tools/encoding-test.js` compiles the real decoder out of `minimark.swift`
      and runs actual files through it, down to asserting that the 0xE9 in a
      Latin-1 file is still 0xE9 after an edit and a save.
- [~] **Autosave alert storm.** Half done: `write` now takes `silent:` and
      autosave passes it, so the sheet storm is gone. The counting and the one
      warning after the third failure are still to do — as it stands an
      unwritable file fails quietly, which is better than an alert a second but
      still not good enough.
- [~] **`confirmDiscard` can silently no-op.** Mostly gone, and mostly by
      deletion. New, Open, Open Recent and drag-open no longer discard anything
      — they open into a tab — so they no longer call it at all. What is left
      of it is the close and quit paths, and the sheet inside `confirmClose`
      now guards on `window.isVisible` the way `finishTerminate` always did.
      Still to check: `menuExportHTML`, `menuPageSetup` and `menuExportPDF`,
      which present their own panels with no such guard.
- [ ] **No crash recovery for never-saved documents.** Autosave is skipped when
      there is no path, and the only backstop snapshots at most once per 20
      seconds and flushes after 20 seconds idle. Write untitled documents to
      `~/Library/Application Support/minimark/unsaved/` on the same debounce and
      offer to restore on next launch. **Now more pressing than it was:** tabs
      make it easy to have several untitled documents open at once, and session
      restore deliberately drops them because there is nowhere to put their
      text. This is the thing that would fix that properly.
- [ ] **Rename sanitisation.** `renameDocument` at `:1034` strips `/` and `:`
      but not a leading dot, so renaming to `.notes` makes the file vanish from
      Finder with no warning.
- [ ] **History load blocks launch.** `history.load()` runs synchronously on the
      main thread via `pushHistory` at `:760`, and the store can reach 2 MB.
      Move it off the main thread and send `setHistory` when it arrives.
- [ ] **Silent history failure.** `HistoryStore.drain` at `:310` swallows every
      error, so a full disk or a permissions problem means version history
      quietly stops persisting forever. Surface it once.
- [ ] **Quit watchdog can drop history.** `applicationShouldTerminate` gives the
      web layer 2 seconds at `:521`. If `histCommit` is merely slow rather than
      dead, `JSON.stringify` on a 2 MB store plus a cross-process round trip,
      it quits having written nothing. Raise the budget or make the commit
      incremental.

**Done when:** you can open a Latin-1 file, save to a read-only location, and
eject a volume mid-edit without losing data or being shouted at once per second.

---

## Phase 2, week 3: make it buildable by someone else

For an open-source project this is the single highest-value phase. Right now the
build instructions are a comment and the binary is not committed, so a fresh
clone produces nothing runnable.

**Settled, 22 August:** the branch compiles. `swiftc -O` against both targets
and `swiftc -typecheck` all come back clean, no errors and no warnings, which
closes the "not compiled, tree-sitter catches syntax but not types" risk that
had been open since the tabs work landed. `build.sh` and the universal binary
below followed from that in an afternoon rather than the week this phase
budgeted, because there was nothing wrong to find.

- [x] **`build.sh`.** Done, 22 August. Both slices, `lipo`, resources, ad-hoc
      sign, `build/minimark.app`. One command, no arguments. It also drops the
      binary into the repo's own `minimark.app`, because that bundle reads the
      real `Resources/` and is what you want to run while working on the web
      layer. `--deep` is gone; there is no nested code, so one `codesign` call
      per bundle already is inside-out. Two things learned doing it: `xattr -cr`
      has to run first or codesign refuses the bundle over Finder metadata, and
      the binary is `mv`d rather than `cp`d into place so a rebuild does not
      overwrite the file a running instance is executing from.
- [x] **Universal binary.** Done, same script. `file` reports
      `Mach-O universal binary with 2 architectures`, `codesign --verify
      --strict` passes.
- [ ] **App icon.** `minimark-build/icon/` is still empty and there is no
      `.iconset` in the tree, but note the roadmap was wrong to say no icon
      exists at all: `minimark.app/Contents/Resources/AppIcon.icns` is there and
      ships. What is missing is the *source* it was generated from, which is
      what stops anyone else regenerating it.
- [ ] **GitHub Actions CI.** A macOS runner that runs `build.sh` plus both test
      suites on every push. Cheap to set up, and it is what stops the
      dead-sandbox-path class of bug from ever recurring silently.
- [ ] **First GitHub Release.** Tag `v1.0.0`, attach a zipped `.app`, write the
      changelog, and repeat the Open Anyway instructions in the release notes
      themselves. People arriving at a release page rarely read the README, and
      an app that appears simply not to open is the fastest way to lose them.
- [ ] **Test the ad-hoc path on a clean machine** before tagging. Download your
      own release over the network so the quarantine attribute is actually set,
      and walk the Open Anyway flow yourself. Verifying this by copying a file
      locally proves nothing, because no quarantine flag gets attached.
- [ ] `CHANGELOG.md` and a short `CONTRIBUTING.md` covering how to build, how to
      run the tests, and the fact that the web layer and the Swift shell talk
      over a documented bridge, pointing at `NATIVE-SHELL-BRIEF.md`.
- [ ] Consider splitting `minimark.swift`. 1,943 lines in one file was a
      deliberate choice in the original brief and it is fine for a solo project,
      but it is a real barrier to outside contributions. The existing `MARK`
      section banners already show the seams: `HistoryStore`, `EditorWebView`,
      `DragStrip`/`RootView`/`MainWindow`, `AppDelegate`. Optional, and a
      judgement call.

**Done when:** someone clones the repo on an Intel Mac, runs `./build.sh`, and
gets a working app.

---

## Phase 3, weeks 4 to 6: harden and extend

With the repo public and safe, this is where the remaining time goes. Ordered by
value.

### Tests, because they are now contributor infrastructure

- [x] **Bridge contract test.** Done: `tools/bridge-contract.js`. Diffs `send()`
      types against the Swift `case`s, `js("App.x(...)")` against the keys of
      `window.App`, persisted pref keys against `kPrefKeys`, and menu command
      names against the command map. Exits non-zero on a mismatch, so it drops
      straight into the CI job in Phase 2.
- [ ] **Sanitiser tests.** The allowlist walk at `app.js:310-400` is
      security-critical, carries a comment block enumerating three specific ways
      the previous regex version was bypassed, and has no tests at all. For a
      public repo this is the thing a security-minded reader will look at first.
- [ ] **Markdown pipeline tests.** `md()`, `splitBlocks`, `tint`,
      `collectLinkDefs` are all untested.
- [ ] Fix the `names.js` divergence problem. It re-implements
      `sanitiseFileBase` and `uniqueImageName` in JS, "transcribed line for
      line" from the Swift, and its own header concedes the test is worthless if
      they drift. Nothing checks that they still match.

### Robustness

- [ ] **File coordination.** Nothing uses `NSFileCoordinator` or
      `NSFilePresenter`. A 2-second mtime poll (`kWatchInterval` `:53`) races a
      1-second autosave (`kAutosaveDelay` `:52`), which will produce conflicts
      and lost edits in iCloud Drive, Dropbox or a git worktree. Given the
      likely audience of an open-source markdown editor, a lot of people will
      keep their notes in exactly those places.
- [ ] `write` uses `atomically: true` at `:930`, which replaces the inode. That
      drops Finder tags and extended attributes, breaks hard links, and replaces
      a symlinked path with a regular file.
- [ ] **Document size ceiling.** On every keystroke the JS does a full-document
      syntax tint into `innerHTML` (`app.js:784`) and a full-document regex word
      count (`app.js:845`), then on a debounce tears down and rebuilds every
      block (`app.js:796`). No virtualisation, no incremental parse. Find the
      practical ceiling, document it, and guard the open path against files far
      past it.
- [ ] **VoiceOver.** The two `DragStrip` views at `:325-351` implement no
      `NSAccessibility` protocol and are invisible to assistive tech.
- [ ] `dragWindow` reads `NSApp.currentEvent` at `:866`, but `WKScriptMessage`
      delivery is asynchronous relative to the mouse event, so it may already be
      a different event or nil. Low impact since it is only reachable when the
      native strip is hidden, but it is the brief's documented fallback and it
      does not really work.

### Features, ranked by value per hour

1. **Alt-text prompt on image insert.** Images currently go in as bare
   `![](name)` at `ui.js:1517`. Small change, immediately noticeable.
2. ~~**User CSS hook.**~~ **Done, 22 August**, and widened into templates —
   see the block below.
3. **Table editing.** There is an insert-table snippet at `ui.js:598` and a
   Tab-key tidy pass, but no add or delete row and column, no alignment
   controls.
4. **Mermaid diagrams.** KaTeX is already wired in at `app.js:287`, so the
   pattern for a block-level renderer exists.

5. ~~**Multiple windows and tabs.**~~ **Tabs: done, August 2026.** One window,
   several documents, in a strip that stays off screen until the pointer
   reaches the top edge of the window. The shape it took is written up in
   `NATIVE-SHELL-BRIEF.md`: the shell owns the tabs because it owns the files,
   the web layer owns a session per tab, and the two meet at an id. Document
   state moved off the app delegate into a `DocTab` list, which is the refactor
   this entry was really asking for.

   Two tools came with it and are the check that it stays working:
   `tools/bridge-contract.js` diffs every message and call across the bridge in
   both directions, and `tools/tabs-test.js` drives the real web layer in a
   headless browser against a stand-in shell.

   Multiple *windows* is still open, and is now the smaller job of the two:
   `AppDelegate` still holds a single `var window: MainWindow!` and still sets
   `tabbingMode = .disallowed`. It would want a per-window controller holding
   the tab list, which is now a contained thing to move.

Items 1, 3 and 4 are also the natural "good first issue" set if anyone turns up
wanting to contribute.

### Done, 22 August: the three gaps worth closing against iA Writer

Compared feature by feature against iA Writer 8. Most of the gap is out of
scope on purpose — a Library, iCloud and Dropbox sync, publishing to Ghost and
WordPress, mobile, ten localisations, Authorship. Each is months. Three were
cheap enough to be worth it, and all three are in.

- **Style check.** Fillers, clichés and redundancies, underlined in the
  rendered document, with the reason on hover and a count in the status bar
  that steps through them. `style-check.js` is the dictionary and the matcher,
  kept as its own file because it is the part people will want to argue with;
  `ui.js` does the marking. Deliberately not attempted: parts of speech, which
  is what iA's Syntax Highlight does and which needs a tagger to do at all
  well. A style checker that cries wolf gets switched off, and then the good
  half goes with it.

- **Templates.** Two optional files in Application Support, and a File menu
  item that creates and reveals them. `user.css` goes into the editor after
  everything else, so it can restyle any theme without `!important`, and it
  reaches print and PDF for free because both paginate the live web view.
  `export.html` is the shell for Export as HTML, with `{{body}}`, `{{title}}`,
  `{{style}}`, `{{usercss}}` and `{{date}}`. Both starters ship inert. The
  edit loop is: change the file, switch back to the app, see it —
  `applicationDidBecomeActive` re-reads and only pushes on a real change.

- **Wikilinks.** `[[Another note]]` and `[[Another note|labelled]]`, resolved
  by the shell against the document's own folder. Written as a marked
  extension rather than a regex pass, which is what makes `[[this]]` inside
  backticks stay literal without anyone having to think about it. A target is
  a bare filename: no separators, no `..`, and the resolved path is checked to
  land in the document's folder afterwards as well as before. Clicking one
  that does not exist offers to create it, in a sheet — **worth a second
  opinion, since it is the one path here that writes a file from a click.**

Left rather than guessed at: a missing wikilink target looks the same as one
that exists, because telling them apart means the shell answering a round trip
for every link on screen. And style check is English only.

The suite is 153 assertions across six tools now, all of it runnable with one
`npm test` in `tools/`.

---

## Deliberately not in this plan

**Monetisation, licensing, trials, App Store, sandboxing.** Not wanted, and
GPL-3.0 rules the App Store out regardless. The sandbox refactor alone
(security-scoped bookmarks to replace the raw path string at `:908`, scoping the
web view's read access down from `/` at `:692`, a privacy manifest) would eat a
week for no benefit here.

**iCloud sync, iOS companion, plugin API, publishing integrations,
localisation.** Each is a multi-month project. None can be started responsibly
inside six weeks.

**Sparkle auto-updates.** For an open-source app, GitHub Releases plus a
"Check for Updates" menu item that opens the releases page covers it. Revisit if
the project gets enough users that manual updating becomes a real complaint.

---

## Risks

| Risk | Mitigation |
|---|---|
| Publishing before the attribution is fixed | Phase 0 is ordered first for exactly this reason. Do not make the repo public until `NOTICES.md` exists and the vendor headers are restored. GPL-3.0 on your own code does not discharge the MIT and BSD obligations |
| Gatekeeper friction drives away the first wave of users | Lead the README with build-from-source, which has no friction. Put the correct Open Anyway steps, not the dead right-click advice, in both the README and the release notes |
| The ad-hoc signature gets dropped from `build.sh` as tidy-up | It is load-bearing. Unsigned apps do not open at all on macOS 15.1+. Leave a comment in the script saying so |
| A contributor lands a patch and the licence is now frozen | Decide on a CLA, or consciously accept that GPL-3.0 is permanent, before merging the first pull request |
| The repo goes public with a broken build | CI in Phase 2 is what prevents this. Until it exists, test a clean clone by hand before tagging |
| ~~Tabs refactor gets started and swallows everything~~ | Done, and contained: it did not touch the markdown pipeline, the sanitiser or the history store. The risk it was guarding against was document state living on the app delegate, and that is now a `DocTab` list |
| Nobody turns up | That is a fine outcome. The app is for you first, and a finished, documented, tested native Mac app is worth having regardless of stars |

---

## Sources

- [Sequoia removed the Control-click Gatekeeper override](https://mjtsai.com/blog/2024/07/05/sequoia-removes-gatekeeper-contextual-menu-override/)
- [macOS 15.1 blocks genuinely unsigned apps outright](https://www.osnews.com/story/141055/bug-or-intentional-macos-15-1-completely-removes-ability-to-launch-unsigned-applications/), which is why the ad-hoc signature has to stay
- [Opening unsigned apps on Sequoia and newer](https://wiki.hacks.guide/wiki/Open_unsigned_applications_on_macOS_Sequoia_and_newer), for the exact README wording
- [Apple Developer Program enrolment](https://developer.apple.com/help/account/membership/program-enrollment/), if notarisation is ever revisited
- [Sparkle project](https://sparkle-project.org/), if auto-updates come back on the table
