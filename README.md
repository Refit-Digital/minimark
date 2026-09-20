# minimark

A quiet place to write markdown, for macOS.

## What it is

minimark is a native markdown editor with two ways to work:

- **Split** — raw markdown on the left, rendered preview on the right.
- **Live** — one surface. Click any paragraph to reveal its markdown, click away to render it again.

Everything else stays out of the way until you ask for it: one search field (`⌘K`) instead of a toolbar, reaching commands, the document's headings, its `#tags`, what is left to do in it, the files that link to it and your recent files at once; zen mode, focus mode, typewriter scrolling, a style checker, three lenses, and local version history. Paste a web page and it arrives as clean markdown; paste an image and it's saved beside your document.

The style checker names what to cut and says why. The **lenses** say nothing at all: `⌃⌥L` colours adverbs, sentences over thirty words, or words you have used three times close together, and leaves you to draw the conclusion. There is nothing wrong with an adverb, so nothing counts them.

`[[wikilinks]]` link your files to each other, and `![[a file]]` on a line of its own pulls that file in where it stands: another markdown file, a text file, a CSV as a table, or an image. Names may descend into a subfolder, so a book can embed its `chapters/`. `⌘K` then `<` turns the links around: which files point at this one, and which mention it without pointing. `#tags` you write in the text are rows in the same field, both where you wrote them and in whichever other files carry them, and `- [ ] tasks` you have not ticked are under `[`.

Documents autosave a second after you stop typing, and reload if something else changes the file underneath you.

## Building

Requires the Xcode command line tools (`xcode-select --install`) — no Xcode project, no dependencies beyond `swiftc`.

```bash
./build.sh
```

This compiles `minimark.swift` for both Apple Silicon and Intel, lipos them into a universal binary, and produces:

- `minimark.app` — the bundle in this repo. Its `Resources/` are the real source files, so editing `app.js`, `ui.js`, or `styles.css` shows up on next launch without rebuilding.
- `build/minimark.app` — a self-contained copy, ready to zip and ship.

Neither is committed; a fresh clone is meant to build both from scratch.

## Running

```bash
open minimark.app
```

## Testing

```bash
cd tools
npm install --include=dev
npm test
```

Nineteen suites. Fourteen drive the web layer (`Contents/Resources/*.js`) through Playwright and run anywhere Node does. Five compile real functions out of `minimark.swift` into throwaway binaries, because file I/O, filename handling and path resolution cannot be tested in a browser. Individual suites run on their own; `tools/package.json` lists them all.

### The five that need a Mac

`encoding`, `unsaved`, `embed-path`, `backlink-scan` and `coordination` need `swiftc`, which comes with the same command line tools the build does. They extract the functions they test rather than copying them, so they cannot quietly pass against a stale duplicate.

They also cannot run anywhere but macOS, and not for want of a toolchain: `coordination` tests `NSFileCoordinator` and `NSFilePresenter`, which exist only in Apple's Foundation, and the others lean on macOS text encoding detection and `NSString` bridging.

That matters because much of the work on minimark happens in a cloud session, where there is no Swift toolchain and no way to install one. Such a session can prove the web layer and nothing else. So after any change that touched `minimark.swift`, run both of these on a Mac before trusting it:

```bash
cd tools && npm test      # all nineteen, including the five above
cd .. && ./build.sh       # the only thing that proves the app still compiles
```

`embed-path` is the one to watch. `wikiURL` is the only function in the app that turns a string a *document* wrote into a path the app will open, and the suite's 24 assertions are mostly about what it has to refuse: `..` in any position, a leading `/` or `~`, a dotfile at any depth, and anything that leaves the document's own folder by following a symlink.

## Project layout

| Path | What it is |
| --- | --- |
| `minimark.swift` | The entire native shell: window, menus, file I/O, autosave, the WebKit bridge. One file, deliberately. |
| `minimark.app/Contents/Resources/` | The web layer: `index.html`, `app.js` (editor/document logic), `ui.js` (chrome, menus, themes), `styles.css`, and vendored libraries. `style-check.js` and `lenses.js` hold the word lists, kept apart so disagreeing with one does not mean reading the editor. |
| `build.sh` | Compiles, lipos, and signs. The only supported build path. |
| `tools/` | Test suites and the bridge-contract checker that keeps the Swift and JS sides honest about the messages they pass each other. |

## Acknowledgements

minimark is built on [marked](https://github.com/markedjs/marked), [Turndown](https://github.com/mixmark-io/turndown), [highlight.js](https://github.com/highlightjs/highlight.js), and [KaTeX](https://github.com/KaTeX/KaTeX) — see Help ▸ Acknowledgements in the app, or [NOTICES](NOTICES) for full license text.

## License

MIT — see [LICENSE](LICENSE).
