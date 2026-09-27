# minimark

A quiet place to write markdown, for macOS.

No toolbar, no sidebar, no sign-in, no subscription, no telemetry. One window with your words in it,
and everything else a keystroke away when you want it.

## What it is

Two ways to work:

- **Split** — raw markdown on the left, rendered preview on the right.
- **Live** — one surface. Click any paragraph to reveal its markdown, click away to render it again.

Everything else stays out of the way until you ask for it: a command palette (`⌘K`) instead of a
toolbar, zen mode, focus mode, typewriter scrolling, a style checker, local version history, tables
you can add and remove rows and columns from where the caret already is, and `[[wikilinks]]` between
your own files. Paste a web page and it arrives as clean markdown; paste an image and it's saved
beside your document.

`⌘N` opens a window, `⌘T` a tab. One file is only ever open in one place — ask for a document
another window already has and that window comes forward rather than handing you a second copy of it
to lose work in.

Documents autosave a second after you stop typing. If something else changes a file underneath you,
minimark notices; if that would mean overwriting somebody else's work, it refuses, says so, and
keeps both versions rather than picking for you.

Requires macOS 13 or later. Apple Silicon and Intel.

## There is no download, on purpose

Handing someone a build that opens without a warning means a paid Apple Developer certificate and a
notarising step. This project does not have one and is not going to buy one, so the honest options
were "ship something macOS calls damaged" or "ship source". It ships source.

So: no releases, no installer, no auto-update. Building it takes one command and nothing beyond the
Xcode command line tools, and the result is a real, signed-for-this-machine app you can keep in
`/Applications`.

## Building

```bash
xcode-select --install   # once, if you have never built anything on this Mac
./build.sh
```

That compiles `minimark.swift` for both architectures, lipos them into a universal binary, signs it
ad-hoc, and produces:

- `minimark.app` — the bundle in this repo, for working in. Its `Resources/` are the real source
  files, so editing `app.js`, `ui.js` or `styles.css` shows up on next launch without rebuilding.
- `build/minimark.app` — a self-contained copy, with the Resources folded in.

Neither is committed; a fresh clone builds both from scratch.

```bash
open minimark.app
```

## If you want to build on it

The whole app is two halves and one string-typed bridge between them, and knowing that is most of
finding your way around.

| Where | What |
| --- | --- |
| `minimark.swift` | The entire native shell in one file, ~7,500 lines: window, menus, file I/O, autosave, file coordination, the WebKit bridge. One file deliberately — everything that touches the filesystem is in one place you can read end to end. |
| `minimark.app/Contents/Resources/app.js` | The editor: document state, markdown parsing, the live view, tables, history. |
| `minimark.app/Contents/Resources/ui.js` | The chrome: command palette, tab strip, themes, find, preferences. |
| `minimark.app/Contents/Resources/styles.css` | Everything you see. Themes are CSS variables. |
| `tools/` | Seventeen test suites and the bridge-contract checker. |

**The bridge is the thing to be careful about.** Every message between the two halves is a string
matched at runtime, so a `send('tabNew')` with no `case "tabNew"` on the Swift side does nothing and
says nothing about it. `node tools/bridge-contract.js` greps both sides and diffs them. Run it
before you believe a rename worked.

**The tests run the real code, not a copy of it.** The Swift suites compile named functions straight
out of `minimark.swift` by balancing braces, so they cannot pass against a stale extract; the web
suites drive the actual page in Playwright. Every suite takes a source path as its argument, which
is how you point one at a deliberately broken copy and check it still fails — a test that has
quietly stopped testing anything reports success.

```bash
cd tools
npm install --include=dev
npm test
```

Individual suites run on their own — `npm run coordination`, `npm run windows`, `npm run palette`
and the rest; see `tools/package.json`.

**Read `ROADMAP.md` before proposing anything.** It says what is missing and, more usefully, what
was tried and rejected and why. The code has the same habit: where a decision looks strange there is
usually a comment saying what the obvious alternative did when it was measured.

Issues and pull requests are welcome. So is a fork that goes somewhere else with it.

## Acknowledgements

minimark is built on [marked](https://github.com/markedjs/marked),
[Turndown](https://github.com/mixmark-io/turndown),
[highlight.js](https://github.com/highlightjs/highlight.js), and
[KaTeX](https://github.com/KaTeX/KaTeX) — see Help ▸ Acknowledgements in the app, or
[NOTICES](NOTICES) for full license text.

## License

MIT — see [LICENSE](LICENSE).
