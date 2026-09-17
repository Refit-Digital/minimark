# minimark

A quiet place to write markdown, for macOS.

## What it is

minimark is a native markdown editor with two ways to work:

- **Split** — raw markdown on the left, rendered preview on the right.
- **Live** — one surface. Click any paragraph to reveal its markdown, click away to render it again.

Everything else stays out of the way until you ask for it: one search field (`⌘K`) instead of a toolbar, reaching commands, the document's headings and your recent files at once; zen mode, focus mode, typewriter scrolling, a style checker, and local version history. Paste a web page and it arrives as clean markdown; paste an image and it's saved beside your document.

`[[wikilinks]]` link your files to each other, and `![[a file]]` on a line of its own pulls that file in where it stands: another markdown file, a text file, a CSV as a table, or an image. Names may descend into a subfolder, so a book can embed its `chapters/`.

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

The web layer (`Contents/Resources/*.js`) is tested with Playwright; a few suites compile pieces of `minimark.swift` itself into throwaway binaries to test file I/O and filename handling directly, since that logic can't run in a browser.

```bash
cd tools
npm install --include=dev
npm test
```

Individual suites are also runnable on their own — see `tools/package.json` for the full list.

## Project layout

| Path | What it is |
| --- | --- |
| `minimark.swift` | The entire native shell: window, menus, file I/O, autosave, the WebKit bridge. One file, deliberately. |
| `minimark.app/Contents/Resources/` | The web layer: `index.html`, `app.js` (editor/document logic), `ui.js` (chrome, menus, themes), `styles.css`, and vendored libraries. |
| `build.sh` | Compiles, lipos, and signs. The only supported build path. |
| `tools/` | Test suites and the bridge-contract checker that keeps the Swift and JS sides honest about the messages they pass each other. |

## Acknowledgements

minimark is built on [marked](https://github.com/markedjs/marked), [Turndown](https://github.com/mixmark-io/turndown), [highlight.js](https://github.com/highlightjs/highlight.js), and [KaTeX](https://github.com/KaTeX/KaTeX) — see Help ▸ Acknowledgements in the app, or [NOTICES](NOTICES) for full license text.

## License

MIT — see [LICENSE](LICENSE).
