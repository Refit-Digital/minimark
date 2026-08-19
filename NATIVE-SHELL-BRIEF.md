# minimark — rebuild the native shell

Paste this whole file as the opening message of a new chat in this project.

---

## What I want

Rebuild the macOS Swift shell for minimark from scratch, as source I own, so the
window and menu bar stop being frozen inside a compiled binary. The web layer is
finished and must not be touched.

## What exists right now

`minimark.app` in this folder is a working app bundle with two halves:

| Path | What it is | Status |
|---|---|---|
| `Contents/Resources/` | `index.html`, `styles.css`, `app.js`, `ui.js`, `vendor/` | **Finished. Do not modify.** |
| `Contents/MacOS/minimark` | 231KB compiled Swift, arm64 | **No source exists. Replace this.** |
| `Contents/Info.plist` | bundle id `uk.co.refitmy.minimark`, min macOS 13.0, `.md`/`.txt` document types | Keep as is |

I searched my whole home folder: there are no `.swift` files anywhere. The
original source is gone. Everything below about the old shell was reconstructed
from its symbol table and from the JavaScript that talks to it, so treat it as
an accurate spec of the contract, not as a guess.

Deliverable: one or more `.swift` files plus the exact build command. I will
compile and iterate on errors myself, so keep it to a single file if you
reasonably can, and do not use Xcode project files.

## The bridge contract

The web layer expects a `WKScriptMessageHandler` registered under the name
**`mm`**, and calls it as `window.webkit.messageHandlers.mm.postMessage({type: ...})`.
Every message carries a `type` field.

### Web to native

| type | payload | expected behaviour |
|---|---|---|
| `ready` | — | sent once on load. Reply with `App.setPrefs(...)` then `App.loadDoc(...)` |
| `pref` | `{key, value}` both strings | persist to `UserDefaults`. Keys in use: `theme`, `themeAuto`, `themeLight`, `themeDark`, `font`, `size`, `zen`, `focus`, `typewriter`, `mode`, `scroll`, `history`, `fmtUse`. `history` can reach ~170KB, so do not assume small values |
| `dirty` | `{dirty: Bool}` | set `window.isDocumentEdited`, drive the close-confirmation sheet |
| `menu` | `{name}` | one of `new`, `open`, `save`, `saveAs`, `exportHTML`, `reveal`, `fullscreen`, `zoom`. Perform the same action the matching menu item performs |
| `rename` | `{name}` | rename the file on disk, then call `App.renamed(newName)` |
| `openURL` | `{url}` | open in the default browser |
| `copyRich` | `{html, text}` | write both flavours to the general pasteboard |
| `pasteImage` | `{data: base64, ext}` | save alongside the document, then call `App.insertImage(relativePath)` |
| `zen` | `{on: Bool}` | hide/show the title bar for zen mode |
| `zenReveal` | `{on: Bool}` | temporarily reveal the chrome bar during zen, when the pointer comes near it or the page is scrolled up |
| `barX` | `{x, w, h}` | `x` is where the window buttons go, in CSS px from the left; `w`/`h` are the bar's drawn size. Sent whenever any of the three changes: mode switch, resize, launch. Move and resize the buttons and the bar's drag strip to match |
| `dragWindow` | `{x, y}` screen coords | **new.** Begin a window drag. See "the window" below |

### Native to web

Call these with `evaluateJavaScript`. The two getters return values, so use the
completion handler.

| Call | Notes |
|---|---|
| `App.loadDoc(text, name, dir)` | `dir` is the containing folder path, used to resolve relative image paths |
| `App.getText()` | returns the current markdown. Use this for save and autosave |
| `App.getHTML()` | returns rendered HTML, for Export as HTML |
| `App.setSaved(name, dir)` | after a successful save |
| `App.autoSaved()` | after a successful autosave, updates the "saved 14:32" label |
| `App.externalChange(text)` | when the file changes on disk underneath us |
| `App.renamed(name)` | after a rename |
| `App.setFullscreen(on)` | on enter/exit full screen |
| `App.setPrefs({...})` | all persisted prefs at once, values as strings |
| `App.setSystemTheme('dark' or 'light')` | at launch and whenever the system appearance changes |
| `App.insertImage(relPath)` | after saving a pasted image |
| `App.command(name)` | how every menu item reaches the app. Full list below |

## The menu bar

This is half the point of the rebuild. Every item below should fire
`App.command('name')` unless marked as a native action.

**minimark**: About, Settings (opens `themes`), Hide, Quit

**File** *(native actions, also reachable as `menu` messages)*: New `⌘N`,
Open `⌘O`, Save `⌘S`, Save As `⇧⌘S`, Rename, Export as HTML, Reveal in Finder,
Close `⌘W`

**Edit**: Undo `⌘Z`, Redo `⇧⌘Z`, Cut/Copy/Paste, Copy as Rich Text `⌥⌘C`
(`copyRich`), Find `⌘F` (`find`), Find Next `⌘G` (`findNext`), Find Previous
`⇧⌘G` (`findPrev`), then a separated **Restore** submenu:

| Item | command |
|---|---|
| Version History… `⌘⇧H` | `history` |
| 1 minute ago | `restore1m` |
| 5 minutes ago | `restore5m` |
| 15 minutes ago | `restore15m` |
| 1 hour ago | `restore1h` |
| 5 hours ago | `restore5h` |
| 1 day ago | `restore1d` |
| 3 days ago | `restore3d` |
| 1 week ago | `restore1w` |
| Oldest snapshot | `restoreOldest` |
| Undo Restore | `restoreUndo` |

**Format**: Bold `⌘B` (`bold`), Italic `⌘I` (`italic`), Inline Code `⌘E`
(`code`), Link `⌘K` (`link`)

**View**: Split `⌘1` (`split`), Live `⌘2` (`live`), Toggle Mode `⇧⌘M`
(`toggleMode`), Zen `⌃⌥Z` (`zen`), Focus `⇧⌘D` (`focus`), Typewriter `⇧⌘T`
(`typewriter`), Bigger Text `⌘+` (`bigger`), Smaller Text `⌘-` (`smaller`),
Actual Size `⌘0` (`resetSize`), Appearance `⇧⌘L` (`themes`), Enter Full Screen

**Go**: Command Palette `⌘P` (`palette`), Jump to Heading `⌘R` (`headings`)

**Help**: Markdown Reference `⌘/` (`help`)

Note the JS already handles all of these shortcuts itself when the web view has
focus, so menu items are for discoverability and for when focus is elsewhere.
Do not worry about double-firing; the commands are idempotent.

## The window

- `titlebarAppearsTransparent = true`, `titleVisibility = .hidden`,
  `.fullSizeContentView` in the style mask. The web view fills the whole window
  including the title bar band.
- The chrome is one small bar, welded to the window edge rather than floating
  near it: 103×32, top edge flush with the top of the window. Live view puts
  it in the top-left corner; split view hangs it off the top edge, centred on
  the pane divider.
- **Colour.** One per theme, declared as `--bar-bg` / `--bar-dot` in each
  theme block. macOS draws window furniture a step apart from the content it
  frames, so on a light theme the bar goes darker than the page and on a dark
  theme lighter — each derived from that theme's own paper and calmed
  slightly, rather than a single grey for all three light themes and another
  for the dark. A neutral grey on Cork or Sepia reads as a foreign object.
  The bar takes none of the page texture, and carries no outline: the colour
  separates it well enough on its own.

  | theme | paper | bar | grip |
  |---|---|---|---|
  | Paper | `#fbfbfa` | `#ededea` | `#a5a599` |
  | Sepia | `#f6f1e6` | `#eae3d4` | `#ae9d76` |
  | Cork  | `#e8d4a3` | `#d6c397` | `#8d7847` |
  | Steel | `#23262a` | `#3e4247` | `#7d8287` |
  | Ink   | `#131315` | `#2e2e32` | `#6d6d72` |
  | Void  | `#000000` | `#1c1c1c` | `#5c5c5c` |
- **Corners.** In live view only the bottom-right is rounded, at 12px; the two
  corners sitting on window edges stay square, because the window's own corner
  already describes that shape. In split view both bottom corners are rounded
  the same way, and the two top corners curve the *other* way — concave,
  flaring outwards into the top edge of the window, so the bar swells out of
  the edge instead of being parked against it. border-radius cannot cut a
  concave corner, so those two are drawn with radial-gradient fillets hung
  just outside the bar.
- **Padding is equal on all four sides**, 10px, and that is what sets the size.
  The traffic lights therefore hang 10px below the top of the window, not
  centred in the 28px band.
- The bar is 103×32 in both modes: `10 + (52 of buttons + 14 gap + 17 of
  grip) + 10` across, `10 + 12 + 10` down. Stacking the grip under the buttons
  in split view was tried and abandoned — it made a 72×50 tab that hung into
  the page like a dangling label. `barX` still carries `w` and `h` alongside
  `x` so the native drag strip sizes itself from what the web layer drew
  rather than from a constant, which is worth keeping either way.
- The grip is three centre-aligned rows of 3, 4 and 3 dots.
- The geometry is declared twice, as `--bar-*` in `styles.css` and as `kBar*`
  in `minimark.swift`; the two must agree. `barX` keeps them in step at runtime.
- The document runs underneath the bar at full opacity. No mask, no gradient,
  no blur at the boundary — the bar is opaque and its edge is a clean cut.
- **The thing that prompted this rebuild:** the top 28px band currently belongs
  to the web view, so text there is selectable and the window cannot be dragged
  from it. CSS cannot fix this. WebKit does not implement `-webkit-app-region`
  (that is Chromium's). The fix is a real drag strip above the web view:

  ```swift
  final class DragStrip: NSView {
      override var mouseDownCanMoveWindow: Bool { true }
      override func hitTest(_ p: NSPoint) -> NSView? { self }
  }
  ```

  There are two of them, added `.above` the web view. One is pinned to the
  bar's rectangle and slides with it, so only the chrome takes the mouse.
  The other is full width but only 8px tall, along the very top edge, so the
  window is still easy to pick up. Everything between them belongs to the
  document. Zen hides the bar's strip along with the bar, or it would leave an
  invisible dead patch on the paper.
- Alternatively honour the `dragWindow` message with
  `window.performWindowDragWithEvent(_:)`. The native strip is cleaner; the
  message is already being sent either way.

## Behaviours to preserve

- **Autosave.** The old build debounced it with a `DispatchWorkItem`. Pull text
  with `App.getText()`, write, then call `App.autoSaved()`. Only once the
  document has a path; a never-saved Untitled has nowhere to go.
- **File watching.** An `NSTimer` polled the file's modification date and called
  `App.externalChange(text)` when it changed underneath. Keep this.
- **Restore on launch.** Read prefs, send `App.setPrefs`, reopen the last
  document. The `scroll` pref is a 0-1000 integer the web layer uses to restore
  scroll position.
- **Document types.** `.md`, `.markdown`, `.mdown`, `.mkd`, `.mdtext`, `.txt`,
  `.text` already declared in Info.plist. Handle open-with and drag-onto-icon.

## Build and verify

Target: macOS 13.0, arm64, no external dependencies, AppKit + WebKit only.

```
swiftc -O -target arm64-apple-macos13.0 minimark.swift \
  -o minimark.app/Contents/MacOS/minimark
codesign --force --deep --sign - minimark.app
```

Load the web layer with `loadFileURL(_:allowingReadAccessTo:)` pointed at
`Contents/Resources/index.html`, granting read access to the whole `Resources`
folder so `vendor/` loads.

Before writing code, please confirm you have understood the bridge contract by
listing the message types in both directions back to me. Then write the file.

## Acceptance

- [ ] Opens, shows the welcome document, no console errors in Web Inspector
- [ ] Every menu item above fires and does something visible
- [ ] Dragging the chrome bar, or the top 8px of the window, moves the window
- [ ] Text beside the bar is live document: selectable, clickable, no fade
- [ ] The bar sits in the window's top-left corner in live view, on the divider in split
- [ ] Zen hides the bar; pointer near it or a scroll up brings it back
- [ ] Save, Save As, Open, Rename, Reveal, Export as HTML all work
- [ ] Autosave fires and the status bar timestamp updates
- [ ] Editing the file in another editor triggers a reload prompt
- [ ] Theme, typeface, text size, zen, focus, typewriter and mode all survive a relaunch
- [ ] Version history survives a relaunch (it rides in the `history` pref)
- [ ] Pasting an image saves it next to the document and inserts a relative link
