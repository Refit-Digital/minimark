//
//  minimark — native macOS shell
//
//  Single-file AppKit + WebKit host for the finished web layer in
//  Contents/Resources. Nothing in this file writes to the web layer's files;
//  it only talks to it over the `mm` bridge.
//
//  Build:
//      ./build.sh
//
//  That is the whole recipe. It compiles both architectures, lipos them, and
//  ad-hoc signs the result — none of which is optional. An arm64-only binary
//  will not launch on an Intel Mac at all, and an unsigned one will not launch
//  anywhere on macOS 15.1 or later.
//

import AppKit
import WebKit
import UniformTypeIdentifiers

// ============================================================================
// Constants
// ============================================================================

let kBridge = "mm"
let kTitlebarHeight: CGFloat = 28      // must match --titlebar-h in styles.css

// The chrome bar. These must match --bar-* in styles.css: the web layer draws
// the bar, the shell puts the real window buttons inside it, and neither can
// see the other's copy of the numbers.
//
// The bar is welded to the top of the window, so there is no top inset to
// declare. Its size is whatever its contents come to plus equal padding on
// all four sides: 10 + (52 of buttons + 14 gap + 17 of grip) + 10 across, and
// 10 + 12 + 10 down.
//
// The bar is 103×32 in both modes; only its x changes, from the window's
// corner in live view to the pane divider in split. Stacking the grip under
// the buttons for a 72×50 split-view bar was tried and abandoned. `barX`
// still carries w and h alongside x so the drag strip sizes itself from what
// the web layer actually drew rather than from these constants.
let kBarWidth: CGFloat = 103
let kBarHeight: CGFloat = 32
let kBarPad: CGFloat = 10              // every edge, buttons included

// Where the buttons sit before the web layer has said otherwise: live view
// puts the bar in the window's corner, so the padding is the whole offset.
let kTrafficInset: CGFloat = kBarPad

// A slim grabbable margin along the very top of the window. The bar is the
// visible handle, but it is only ~103px wide, and a window you can only pick
// up by one small patch is a window you fumble. This strip is invisible and
// costs the document almost nothing.
let kEdgeGrip: CGFloat = 8

// The tab strip lives off the top of the window and comes down when the
// pointer reaches the edge. Noticing that has to happen here rather than in
// the page: the top kEdgeGrip pixels belong to a real drag strip that takes
// the mouse before the web view ever sees it, so a mousemove listener in the
// page would be watching a band it is largely blind to.
//
// Two heights, because the band has to be small enough not to fire on the way
// past and large enough, once the strip is out, to still contain a pointer
// that has moved down onto a tab.
let kPeekBand: CGFloat = 16
let kPeekBandOpen: CGFloat = kBarHeight + 14

// How many documents a session will reopen. A cap rather than a limit: it is
// there so a stored session that has somehow grown absurd cannot turn a launch
// into a minute of file reads, not because more tabs are refused.
let kMaxRestoredTabs = 24

let kAutosaveDelay: TimeInterval = 1.0
let kWatchInterval: TimeInterval = 2.0
// How long quit waits on the web layer before giving up and going anyway.
let kQuitTimeout: TimeInterval = 2.0

let kDocExtensions = ["md", "markdown", "mdown", "mkd", "mdtext", "txt", "text"]

/// What counts as an image to drop, pick, or embed. Everything here renders in
/// a WKWebView, which is what the preview is.
let kImageExtensions = ["png", "jpg", "jpeg", "gif", "webp", "heic", "heif",
                        "tiff", "tif", "bmp", "svg", "avif"]

/// Every pref the web layer sends, and the only ones we hand back.
///
/// Version history used to live here under a `history` key. It does not any
/// more: it is a document store, it reached six figures of bytes, and
/// UserDefaults rewrites its whole plist per set. It now goes to a sidecar
/// file — see HistoryStore. The key is left in kLegacyHistoryKey only so an
/// existing install can be migrated off it once, on first launch.
let kPrefKeys = ["theme", "themeAuto", "themeLight", "themeDark", "font", "size",
                 "zen", "focus", "typewriter", "styleCheck", "mode", "scroll",
                 "fmtUse", "tabsPin"]

// ============================================================================
// Templates
//
// Two optional files in ~/Library/Application Support/minimark/. Neither has
// to exist; both change what the app does the moment they do.
//
//   user.css     goes into the editor after styles.css, so it can restyle any
//                of the six themes, the style-check underlines, the measure,
//                the typography — anything the app draws. Print and PDF get it
//                for free, because both paginate that same live web view.
//
//   export.html  the shell for Export as HTML. Without it the built-in
//                document is used. With it, these are substituted:
//
//                  {{body}}      the rendered document
//                  {{title}}     the file's name, without its extension
//                  {{style}}     the built-in export CSS, then user.css
//                  {{usercss}}   user.css alone, for a template with its own
//                  {{date}}      today, as the writer's locale writes it
//
// Read on demand rather than cached, because the whole point is that editing
// them and coming back to the app shows the change. It is two small files on
// a warm page cache; the read is not worth a watcher.
// ============================================================================
enum Templates {
    static var dir: URL? {
        let fm = FileManager.default
        guard let base = fm.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
        else { return nil }
        let dir = base.appendingPathComponent("minimark", isDirectory: true)
        if !fm.fileExists(atPath: dir.path) {
            try? fm.createDirectory(at: dir, withIntermediateDirectories: true)
        }
        return dir
    }

    /// A template file is a person's own writing, and the encodings a text
    /// editor might have left it in are the same ones a document could arrive
    /// in. Trying UTF-8 and then Latin-1 costs nothing and means a stylesheet
    /// with a curly quote in a comment does not silently come back empty.
    private static func read(_ name: String) -> String? {
        guard let url = dir?.appendingPathComponent(name),
              let data = try? Data(contentsOf: url), !data.isEmpty else { return nil }
        if let s = String(data: data, encoding: .utf8) { return s }
        return String(data: data, encoding: .isoLatin1)
    }

    static func userCSS() -> String { return read("user.css") ?? "" }
    static func exportTemplate() -> String? { return read("export.html") }

    /// Written once, only if nothing is there. Never overwrites: somebody who
    /// has emptied a file meant to empty it, and finding your stylesheet
    /// replaced by a sample because you deleted its contents would be its own
    /// kind of data loss.
    static func writeStartersIfMissing() {
        guard let dir = dir else { return }
        let fm = FileManager.default
        let css = dir.appendingPathComponent("user.css")
        if !fm.fileExists(atPath: css.path) {
            try? kStarterUserCSS.write(to: css, atomically: true, encoding: .utf8)
        }
        let tpl = dir.appendingPathComponent("export.html")
        if !fm.fileExists(atPath: tpl.path) {
            try? kStarterExportTemplate.write(to: tpl, atomically: true, encoding: .utf8)
        }
    }
}

/// Commented out in full, so the file does nothing until somebody means it to.
let kStarterUserCSS = """
/* minimark — your own stylesheet.

   Anything here is applied after the app's own CSS and after the theme, so
   you can change any of it without !important. It reaches the editor, print
   and PDF export. Delete the comment markers around a rule to turn it on.

   The app's variables are the easiest way in. These are the ones worth
   knowing; there are more in styles.css inside the app bundle.

     --measure     how wide a line of prose is allowed to get
     --ink         the text colour        --paper   the background
     --accent      links, the caret, find highlights
     --rule        hairlines and borders  --muted   secondary text
     --prose       the body typeface      --mono    the source pane's

   Style check has three of its own:

     --sc-filler   --sc-cliche   --sc-redundancy
*/

/*
:root {
  --measure: 44rem;
}

#doc {
  line-height: 1.8;
}

:root {
  --sc-filler:     #7d8f7a;
  --sc-cliche:     #a08a5c;
  --sc-redundancy: #a86a6a;
}
*/
"""

let kStarterExportTemplate = """
<!-- minimark — the shell for Export as HTML.

     Delete this file to go back to the built-in one. What gets substituted:

       {{body}}      the rendered document
       {{title}}     the file's name, without its extension
       {{style}}     the built-in export CSS, then your user.css
       {{usercss}}   your user.css on its own, for a page with its own styles
       {{date}}      today, in your locale

     This starter is the built-in document with the placeholders left in, so
     it is a working page you can cut down rather than a blank one you have to
     build up. -->
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{{title}}</title>
<style>
{{style}}
</style>
</head>
<body>
<main>
{{body}}
</main>
</body>
</html>
"""

let kLegacyHistoryKey = "history"
let kLastDocKey = "lastDocumentPath"

/// The open documents, as paths, and which of them was in front. Untitled
/// documents are deliberately not in here: there is nowhere to put their text,
/// and reopening an empty tab where a page of writing used to be is worse than
/// not reopening it at all. kLastDocKey is still written alongside so a
/// downgrade to a single-document build finds something it understands.
let kOpenDocsKey = "openDocumentPaths"
let kActiveDocKey = "activeDocumentIndex"

let kFrameName = "minimarkMainWindow"

// ============================================================================
// Small helpers
// ============================================================================

/// A Swift string as a quoted JavaScript string literal, safe for
/// evaluateJavaScript. Built with JSONSerialization so quotes, newlines,
/// backslashes and non-BMP characters all survive a 170KB history blob.
func jsLiteral(_ s: String) -> String {
    guard let data = try? JSONSerialization.data(withJSONObject: [s], options: []),
          var out = String(data: data, encoding: .utf8), out.count >= 2 else { return "\"\"" }
    out.removeFirst()               // drop the array's [
    out.removeLast()                // drop the array's ]
    // Legal in JSON, historically illegal inside a JS string literal.
    return out
        .replacingOccurrences(of: "\u{2028}", with: "\\u2028")
        .replacingOccurrences(of: "\u{2029}", with: "\\u2029")
}

func modificationDate(_ url: URL) -> Date? {
    (try? FileManager.default.attributesOfItem(atPath: url.path))?[.modificationDate] as? Date
}

/// Filenames safe to drop into a markdown image link without escaping.
func sanitiseFileBase(_ s: String) -> String {
    let ok = CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_")
    let cleaned = String(s.unicodeScalars.map { ok.contains($0) ? Character($0) : "-" })
    let trimmed = cleaned.trimmingCharacters(in: CharacterSet(charactersIn: "-"))
    return trimmed.isEmpty ? "image" : trimmed
}

// ============================================================================
// The editor web view
//
// A plain WKWebView treats a dropped file as somewhere to navigate: drag a PNG
// onto it and the editor is replaced by that PNG. There is no setting for this,
// so the drag has to be caught before WebKit sees it.
//
// Image files are handled here and never forwarded. Everything else — dragging
// selected text within the document, which the editor should keep — falls
// through to super untouched.
// ============================================================================

final class EditorWebView: WKWebView {

    /// Images to embed, and where they landed in CSS pixels from the top left.
    var onImageFiles: (([URL], NSPoint) -> Void)?
    /// A document to open instead.
    var onDocumentFile: ((URL) -> Void)?

    private struct Drop {
        var images: [URL] = []
        var docs: [URL] = []
        var isEmpty: Bool { images.isEmpty && docs.isEmpty }
    }

    // Reading the pasteboard means an IPC round trip to pasteboardd, and
    // draggingUpdated fires on every mouse move. The contents cannot change
    // within one drag, so read once per sequence and remember the answer.
    private var cachedSequence: Int = -1
    private var cachedDrop = Drop()

    private func classify(_ sender: NSDraggingInfo) -> Drop {
        let seq = sender.draggingSequenceNumber
        if seq == cachedSequence { return cachedDrop }

        var drop = Drop()
        let opts: [NSPasteboard.ReadingOptionKey: Any] = [.urlReadingFileURLsOnly: true]
        if let urls = sender.draggingPasteboard.readObjects(forClasses: [NSURL.self],
                                                           options: opts) as? [URL] {
            for url in urls {
                let ext = url.pathExtension.lowercased()
                if kImageExtensions.contains(ext) { drop.images.append(url) }
                else if kDocExtensions.contains(ext) { drop.docs.append(url) }
            }
        }
        cachedSequence = seq
        cachedDrop = drop
        return drop
    }

    override func draggingEntered(_ sender: NSDraggingInfo) -> NSDragOperation {
        if classify(sender).isEmpty { return super.draggingEntered(sender) }
        return .copy
    }

    override func draggingUpdated(_ sender: NSDraggingInfo) -> NSDragOperation {
        if classify(sender).isEmpty { return super.draggingUpdated(sender) }
        return .copy
    }

    override func draggingExited(_ sender: NSDraggingInfo?) {
        // Only tell WebKit a drag left if it was ever told one entered.
        if let sender = sender, !classify(sender).isEmpty { return }
        super.draggingExited(sender)
    }

    override func prepareForDragOperation(_ sender: NSDraggingInfo) -> Bool {
        if classify(sender).isEmpty { return super.prepareForDragOperation(sender) }
        return true
    }

    override func performDragOperation(_ sender: NSDraggingInfo) -> Bool {
        let drop = classify(sender)
        if drop.isEmpty { return super.performDragOperation(sender) }

        // Window coordinates into this view's CSS pixels. convert(_:from: nil)
        // already accounts for flippedness, so only an unflipped view needs the
        // y axis inverting — checked rather than assumed, because it is
        // WebKit's choice to make, not ours.
        let p = convert(sender.draggingLocation, from: nil)
        let css = NSPoint(x: p.x, y: isFlipped ? p.y : bounds.height - p.y)

        // Images win a mixed drop: they go into the document being written,
        // where opening a different document instead would discard it.
        if !drop.images.isEmpty {
            guard let handler = onImageFiles else { return false }
            handler(drop.images, css)
            return true
        }
        guard let first = drop.docs.first, let handler = onDocumentFile else { return false }
        handler(first)
        return true
    }
}

// ============================================================================
// The version history sidecar
//
// History is a document store, not a preference. It was living in UserDefaults
// because the web layer is loaded with loadFileURL and a file:// origin gets an
// opaque security origin, where localStorage does not survive a relaunch. That
// is a limit on the *page*, not on the app — nothing stopped the native side
// writing a file, so this does.
//
// What that buys: the ceiling stops being 170KB of plist and becomes a few MB
// of disk, writes leave the main thread, and a write costs one file rather than
// a rewrite of every default the app owns.
//
// Writes are coalesced and atomic. The web layer decides *when* to write; this
// only guarantees that whatever it last handed over is what ends up on disk,
// whole, even if the app is quit mid-write.
// ============================================================================

final class HistoryStore {

    private let queue = DispatchQueue(label: "uk.co.refitmy.minimark.history", qos: .utility)
    private var pending: String?          // newest JSON not yet on disk

    /// ~/Library/Application Support/minimark/history.json
    private var fileURL: URL? {
        let fm = FileManager.default
        guard let base = fm.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
        else { return nil }
        let dir = base.appendingPathComponent("minimark", isDirectory: true)
        if !fm.fileExists(atPath: dir.path) {
            try? fm.createDirectory(at: dir, withIntermediateDirectories: true)
        }
        return dir.appendingPathComponent("history.json")
    }

    /// The stored history, or the legacy UserDefaults blob the first time we
    /// run after the move. Migration is one-way, but the default is only
    /// cleared once the file it moved to is definitely on disk — dropping it on
    /// an unchecked fire-and-forget write would lose the history outright if
    /// the write failed.
    func load() -> String? {
        guard let url = fileURL else { return nil }
        let fm = FileManager.default

        // Migration is gated on the file's absence, not on a failed read. A
        // transient read or decode failure on a populated sidecar must not fall
        // through to the legacy branch and overwrite it with an older copy —
        // and that is reachable, because a previously failed migration is
        // exactly the state that leaves the legacy key sitting there.
        if fm.fileExists(atPath: url.path) {
            guard let data = try? Data(contentsOf: url),
                  let json = String(data: data, encoding: .utf8),
                  !json.isEmpty else { return nil }
            // A migration that half-succeeded once would otherwise leave its
            // ~170KB behind in the plist forever — the exact cost this whole
            // change exists to remove.
            UserDefaults.standard.removeObject(forKey: kLegacyHistoryKey)
            return json
        }

        guard let legacy = UserDefaults.standard.string(forKey: kLegacyHistoryKey),
              !legacy.isEmpty else { return nil }
        // Through the queue like every other write, so the queue keeps sole
        // ownership of the file.
        queue.sync {
            do {
                try Data(legacy.utf8).write(to: url, options: .atomic)
                UserDefaults.standard.removeObject(forKey: kLegacyHistoryKey)
            } catch {
                // Keep the default where it is and try again next launch.
            }
        }
        return legacy
    }

    /// Queue a write. Successive calls collapse: only the newest JSON is ever
    /// written, so a burst costs one disk write rather than one per call.
    func write(_ json: String) {
        queue.async { [weak self] in
            guard let self = self else { return }
            self.pending = json
            self.drain()
        }
    }

    /// Block until the queue is empty. For quit, where the process is about to
    /// go away and an async write would be lost.
    func flush() {
        queue.sync { self.drain() }
    }

    /// Must run on `queue`. That queue is serial, so nothing can modify
    /// `pending` while this is running and there is no re-entrancy to guard
    /// against — a write that arrives mid-drain simply runs next.
    private func drain() {
        guard let json = pending, let url = fileURL else { return }
        // .atomic writes to a temporary and renames, so a crash or a quit
        // mid-write leaves the previous history intact rather than a truncated
        // file that fails to parse and reads as no history at all.
        //
        // `pending` is cleared only on success. Because writes coalesce, the
        // queued JSON is the only copy there is — dropping it on a full disk or
        // a permissions failure would lose the newest history outright, where
        // keeping it costs nothing and lets the next write or flush retry.
        do {
            try Data(json.utf8).write(to: url, options: .atomic)
            pending = nil
        } catch {
            // Left pending deliberately.
        }
    }
}

// ============================================================================
// The drag strip
//
// The top 28px band belongs to the window, not to the document. Without this
// the web view owns those pixels: text under them is selectable and the window
// cannot be dragged from them. WebKit does not implement -webkit-app-region,
// so the fix has to be a real native view sitting above the web view.
// ============================================================================

final class DragStrip: NSView {

    override var mouseDownCanMoveWindow: Bool { true }
    override var isOpaque: Bool { false }

    /// NOTE: `point` arrives in the SUPERVIEW's coordinate system, and the
    /// container's own hit test simply returns the first non-nil answer from
    /// its subviews. Returning `self` unconditionally would therefore claim
    /// every point in the window and the web view would never see the mouse
    /// again. Test the frame first.
    override func hitTest(_ point: NSPoint) -> NSView? {
        guard !isHidden, frame.contains(point) else { return nil }
        return self
    }

    /// Normally unreachable: with mouseDownCanMoveWindow true, AppKit consumes
    /// the click for its own window-move loop before the view sees it. Kept as
    /// a fallback so the strip still works if that ever changes.
    override func mouseDown(with event: NSEvent) {
        if event.clickCount == 2 { window?.performZoom(nil); return }
        window?.performDrag(with: event)
    }

    override func resetCursorRects() {
        addCursorRect(bounds, cursor: .arrow)
    }
}

// ============================================================================
// The peek probe
//
// A view that never takes a click and never draws anything. All it does is
// notice the pointer arriving in the band along the top of the window, so the
// web layer can bring the tab strip down.
//
// It has to exist because the two DragStrips above the web view swallow the
// mouse over exactly the pixels the gesture starts in, and because a tracking
// area is geometry, not hit testing: it reports the pointer whether or not the
// view under it would ever accept a click. That is the whole trick — this sits
// on top of everything and changes nothing about who gets the clicks.
// ============================================================================

final class PeekProbe: NSView {

    var onChange: ((Bool) -> Void)?

    override var isOpaque: Bool { false }
    override var acceptsFirstResponder: Bool { false }

    /// Unconditionally transparent to the mouse. The drag strips and the
    /// document underneath keep every event they had before this existed.
    override func hitTest(_ point: NSPoint) -> NSView? { nil }

    private var area: NSTrackingArea?

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let old = area { removeTrackingArea(old) }
        // .inVisibleRect keeps it correct through every resize and through the
        // band growing when the strip opens, without recomputing a rectangle
        // here that AppKit already knows.
        let fresh = NSTrackingArea(rect: bounds,
                                   options: [.mouseEnteredAndExited, .activeInKeyWindow, .inVisibleRect],
                                   owner: self, userInfo: nil)
        addTrackingArea(fresh)
        area = fresh
    }

    override func mouseEntered(with event: NSEvent) { onChange?(true) }
    override func mouseExited(with event: NSEvent)  { onChange?(false) }
}

// ============================================================================
// An open document
//
// The shell owns the tabs because it owns the files: the path, the dirty flag,
// the modification date the watcher compares against, and the autosave that
// runs whether or not the document is the one on screen.
//
// What it deliberately does not own is the text. That lives in the web layer,
// one session per tab, along with the undo stacks and the scroll positions —
// the things that make coming back to a tab feel like not having left it, and
// the things that would cost megabytes to ship across the bridge on every
// switch. The two halves meet at `id` and nothing else.
// ============================================================================

final class DocTab {
    let id: Int
    var url: URL?
    var dirty = false
    var mtime: Date?
    /// Only used while the document has no path of its own.
    var placeholder: String

    init(id: Int, url: URL?, placeholder: String = "Untitled.md") {
        self.id = id
        self.url = url
        self.placeholder = placeholder
        self.mtime = url.flatMap(modificationDate)
    }

    var name: String { url?.lastPathComponent ?? placeholder }
    var dir: String { url?.deletingLastPathComponent().path ?? "" }
}

// ============================================================================
// Root container — reports system appearance changes
// ============================================================================

final class RootView: NSView {
    var onAppearanceChange: (() -> Void)?
    override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        onAppearanceChange?()
    }
}

// ============================================================================
// The window
// ============================================================================

final class MainWindow: NSWindow {

    override func layoutIfNeeded() {
        super.layoutIfNeeded()
        positionTrafficLights()
    }

    /// Where the leftmost button goes. Follows the bar: the web layer posts
    /// `barX` whenever the bar moves, which happens on a mode switch, on a
    /// resize, and at launch.
    var trafficX: CGFloat = kTrafficInset

    /// Inside the bar, kBarPad in from every edge of it. Not centred in the
    /// 28px band: the bar is 32px tall and welded to the top of the window,
    /// so the buttons hang kBarPad below the window's top edge, which is the
    /// same gap they leave on the left. That is the whole point — the padding
    /// has to read as equal on all four sides.
    func positionTrafficLights() {
        let types: [NSWindow.ButtonType] = [.closeButton, .miniaturizeButton, .zoomButton]
        let buttons = types.compactMap { standardWindowButton($0) }
        guard buttons.count == types.count, let band = buttons[0].superview else { return }

        // Keep whatever spacing the system chose; only the origin moves.
        let measured = buttons[1].frame.minX - buttons[0].frame.minX
        let spacing = measured > 1 ? measured : 20
        let bandHeight = band.bounds.height > 1 ? band.bounds.height : kTitlebarHeight

        // The band's coordinates run from its bottom edge, so pushing the
        // buttons kBarPad below the top of the window means measuring the
        // rest of the band's height back down again.
        var x = trafficX
        for b in buttons {
            let y = (bandHeight - kBarPad - b.frame.height).rounded()
            b.setFrameOrigin(NSPoint(x: x, y: y))
            x += spacing
        }
    }
}

// ============================================================================
// The app
// ============================================================================

final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate,
                         WKScriptMessageHandler, WKNavigationDelegate, NSMenuItemValidation,
                         NSMenuDelegate {

    var window: MainWindow!
    var web: WKWebView!

    /// The user stylesheet as the page last saw it. Kept so that re-reading
    /// the file on every activation is free when nothing has changed, which
    /// is nearly always: without it, every switch back to the app would push
    /// a <style> replacement and make the document flash.
    var lastUserCSS: String? = nil
    var strip: DragStrip!            // the bar: takes the mouse where the chrome is
    var edge: DragStrip!             // slim grabbable margin along the top
    var stripX: NSLayoutConstraint!  // slides that strip to follow the bar
    var stripW: NSLayoutConstraint!  // and resizes it, since the two modes differ
    var stripH: NSLayoutConstraint!

    var probe: PeekProbe!            // notices the pointer at the top edge
    var probeH: NSLayoutConstraint!  // …over a band that grows once tabs show
    var rest: DragStrip!             // the empty run past the last tab
    var restX: NSLayoutConstraint!
    var restW: NSLayoutConstraint!
    var restH: NSLayoutConstraint!

    // ------------------------------------------------------------------
    // The open documents
    //
    // One window, several documents. `tabs` is the order they appear in the
    // strip, `activeID` is the one on screen, and the three computed
    // properties below are what everything written before tabs existed still
    // talks to — the active tab is simply where "the document" now lives.
    // ------------------------------------------------------------------

    var tabs: [DocTab] = []
    var activeID = 0
    private var nextTabID = 1

    var activeTab: DocTab? { tabs.first { $0.id == activeID } }
    func tab(_ id: Int) -> DocTab? { tabs.first { $0.id == id } }

    var docURL: URL? {
        get { activeTab?.url }
        set { activeTab?.url = newValue }
    }
    var docDirty: Bool {
        get { activeTab?.dirty ?? false }
        set { activeTab?.dirty = newValue }
    }
    var lastMTime: Date? {
        get { activeTab?.mtime }
        set { activeTab?.mtime = newValue }
    }

    var recentMenu: NSMenu!
    var webReady = false
    var pendingOpen: URL?
    var pendingExtra: [URL] = []

    var watchTimer: Timer?
    var autosaveWork: DispatchWorkItem?
    var reloadPromptUp = false
    var terminating = false
    var terminateReplied = false

    let history = HistoryStore()

    var zenOn = false
    var zenRevealed = false
    var tabsShowing = false

    // ------------------------------------------------------------------
    // Launch
    // ------------------------------------------------------------------

    /// Coming back to the app re-reads the user stylesheet. That is the whole
    /// edit loop for it: change user.css in whatever you edit CSS in, switch
    /// back, see it. pushUserCSS compares against what the page already has,
    /// so an activation that changed nothing costs one small file read and
    /// sends no message at all.
    func applicationDidBecomeActive(_ note: Notification) {
        guard webReady else { return }
        pushUserCSS()
    }

    func applicationDidFinishLaunching(_ note: Notification) {
        NSApp.setActivationPolicy(.regular)
        buildMenu()
        buildWindow()
        loadWebLayer()
        startWatching()
        NSApp.activate(ignoringOtherApps: true)
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }

    /// Open-with and drag-onto-icon. May arrive before the web layer is ready.
    func application(_ sender: NSApplication, openFiles filenames: [String]) {
        // All of them now, each into its own tab. Selecting six files in Finder
        // and pressing Return used to open one and silently drop five.
        let urls = filenames.map { URL(fileURLWithPath: $0) }
        if webReady {
            for url in urls { openDocument(at: url) }
            if !urls.isEmpty { command("showTabs") }
        } else if let first = urls.first {
            pendingOpen = first
            // Anything past the first has to wait for the web layer, which is
            // moments away. handleReady takes pendingOpen and this takes the
            // rest, in order, once there is somewhere to put them.
            pendingExtra.append(contentsOf: urls.dropFirst())
        }
        sender.reply(toOpenOrPrint: .success)
    }

    func applicationDidResignActive(_ note: Notification) {
        if tabs.contains(where: { $0.dirty && $0.url != nil }) { runAutosave() }
        // Switching away is the cheapest moment there is to bank history:
        // nobody is typing, and the write is off the main thread anyway.
        commitHistory()
    }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        // A second ⌘Q while the first is still waiting would run the whole path
        // again and reply twice, which is undefined and in practice fatal. The
        // first attempt owns the reply.
        //
        // .terminateCancel rather than .terminateLater: the discard sheet below
        // is window-modal, so the menu bar stays live and a second ⌘Q really can
        // arrive. Answering it with .terminateLater would leave two waits
        // outstanding against the one reply this attempt will make, and a
        // Cancel would then wedge the app. Cancel unwinds the second attempt
        // immediately — which is also the honest answer, since it is being
        // ignored.
        guard !terminating else { return .terminateCancel }
        terminating = true
        autosaveWork?.cancel()

        // No web layer to ask: nothing can be pending, so take the fast path
        // rather than waiting on a callback that will never arrive. The hop
        // through the run loop is so .terminateLater is returned before
        // finishTerminate can reply to it.
        guard webReady else {
            history.flush()
            if !tabs.contains(where: { $0.dirty }) { terminating = false; return .terminateNow }
            DispatchQueue.main.async { self.finishTerminate() }
            return .terminateLater
        }

        // History is settled first and unconditionally. It can hold unpersisted
        // snapshots even when the document is clean — autosave clears docDirty
        // within a second, while the history write deliberately waits for a
        // longer lull — so the old `guard docDirty` would have quietly dropped
        // the last few minutes of it on every tidy quit. App.histCommit pins the
        // present and answers null when there is genuinely nothing new, so a
        // clean quit still costs only the round trip.
        //
        // The watchdog is because that round trip goes through the WebContent
        // process. If it is killed mid-quit the completion never fires, and
        // without this the app would sit in .terminateLater forever with no
        // window and no way out but Force Quit.
        var answered = false
        let proceed: (String?) -> Void = { json in
            if answered { return }
            answered = true
            if let json = json, !json.isEmpty { self.history.write(json) }
            self.history.flush()
            self.finishTerminate()
        }
        fetchHistory(proceed)
        DispatchQueue.main.asyncAfter(deadline: .now() + kQuitTimeout) { proceed(nil) }
        return .terminateLater
    }

    /// Exactly one reply per terminate attempt. A cancelled attempt clears both
    /// flags so a later ⌘Q can try again; an accepted one leaves them set,
    /// because the process is on its way out.
    private func replyToTerminate(_ ok: Bool) {
        guard terminating, !terminateReplied else { return }
        terminateReplied = true
        if !ok { terminating = false; terminateReplied = false }
        NSApp.reply(toApplicationShouldTerminate: ok)
    }

    private func finishTerminate() {
        let dirty = tabs.filter { $0.dirty }
        guard !dirty.isEmpty else {
            replyToTerminate(true)
            return
        }

        // Anything with a path is simply written, the same as the autosave a
        // second later would have. Only a document that has never been saved
        // has anything left to decide, so only those get asked about.
        let onDisk = dirty.filter { $0.url != nil }
        let untitled = dirty.filter { $0.url == nil }

        let group = DispatchGroup()
        var failed: [String] = []

        for tab in onDisk {
            guard let url = tab.url else { continue }
            group.enter()
            var settled = false
            let finish: (Bool) -> Void = { wrote in
                if settled { return }
                settled = true
                if !wrote { failed.append(url.lastPathComponent) }
                group.leave()
            }
            // If the web layer cannot produce the text, leave the file as it
            // is rather than replacing it with nothing — and say so, rather
            // than quitting quietly over the top of the loss.
            fetchText(tab.id) { text in
                guard let text = text else { finish(false); return }
                finish(self.write(text, to: url, silent: true))
            }
            // Same watchdog reasoning as the history fetch: this round trip
            // goes through the WebContent process, and if that is killed
            // mid-quit nothing else would ever reply.
            DispatchQueue.main.asyncAfter(deadline: .now() + kQuitTimeout) { finish(false) }
        }

        group.notify(queue: .main) {
            // Silent writes above, one honest alert here. Quitting over the top
            // of a file that could not be written is the one outcome worth
            // interrupting a quit for.
            if !failed.isEmpty {
                let alert = NSAlert()
                alert.messageText = failed.count == 1
                    ? "Could not save “\(failed[0])”"
                    : "Could not save \(failed.count) documents"
                alert.informativeText = "minimark has stopped quitting so the changes are not lost. "
                    + "Check the folder is still available, then try again."
                alert.addButton(withTitle: "OK")
                alert.runModal()
                self.replyToTerminate(false)
                return
            }

            guard !untitled.isEmpty else { self.replyToTerminate(true); return }

            // Never saved and there is something in them: ask, one at a time.
            // A sheet needs a window that is actually on screen — without one
            // beginSheetModal never presents and its completion never runs,
            // which would leave the quit hanging on a reply that can no longer
            // come. No watchdog on this one: it is waiting on a person, and
            // quitting out from under them is the data loss it exists to stop.
            guard self.window?.isVisible == true else { self.replyToTerminate(true); return }

            var queue = untitled
            func step() {
                guard !queue.isEmpty else { self.replyToTerminate(true); return }
                let next = queue.removeFirst()
                self.confirmClose(next) { ok in
                    guard ok else { self.replyToTerminate(false); return }
                    step()
                }
            }
            step()
        }
    }

    /// Ask the web layer for its history now, rather than waiting for its idle
    /// timer. Used at the points where there may not be a later.
    func commitHistory() {
        // Not during a quit. The quit path has already committed and flushed;
        // a commit landing after that would pin a snapshot in the web layer and
        // queue a write that nothing is left to flush. Reachable by ⌘-Tabbing
        // away while the discard sheet is up.
        guard webReady, !terminating else { return }
        fetchHistory { json in
            if let json = json, !json.isEmpty { self.history.write(json) }
        }
    }

    // ------------------------------------------------------------------
    // Window + web view
    // ------------------------------------------------------------------

    func buildWindow() {
        let w = MainWindow(contentRect: NSRect(x: 0, y: 0, width: 1080, height: 720),
                           styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
                           backing: .buffered, defer: false)
        w.title = "minimark"
        w.titlebarAppearsTransparent = true
        w.titleVisibility = .hidden
        w.isMovableByWindowBackground = false
        w.minSize = NSSize(width: 660, height: 420)
        w.backgroundColor = .textBackgroundColor
        w.collectionBehavior.insert(.fullScreenPrimary)
        w.tabbingMode = .disallowed
        w.delegate = self

        let cfg = WKWebViewConfiguration()
        cfg.userContentController.add(self, name: kBridge)
        if cfg.preferences.responds(to: NSSelectorFromString("setDeveloperExtrasEnabled:")) {
            cfg.preferences.setValue(true, forKey: "developerExtrasEnabled")
        }

        let v = EditorWebView(frame: .zero, configuration: cfg)
        v.onImageFiles = { [weak self] urls, at in self?.importImages(urls, at: at) }
        // Dropped documents join the session rather than replacing what is
        // open, so there is nothing to ask about before taking one.
        v.onDocumentFile = { [weak self] url in self?.openDocument(at: url) }
        // Deliberately no registerForDraggedTypes: it *replaces* the type list
        // rather than adding to it, and WKWebView registers a large one at init
        // (text, RTF, web archives, promised files). Narrowing it to .fileURL
        // would stop the view being a drop target for dragged text at all, which
        // is exactly what the overrides above are written to preserve. File
        // drops already reach us — that acceptance is the bug being fixed.
        v.navigationDelegate = self
        v.allowsBackForwardNavigationGestures = false
        v.allowsMagnification = false
        if #available(macOS 13.3, *) { v.isInspectable = true }
        // No white flash before the page paints its own (possibly dark) theme.
        if v.responds(to: NSSelectorFromString("_setDrawsBackground:")) {
            v.setValue(false, forKey: "drawsBackground")
        }

        let root = RootView(frame: NSRect(x: 0, y: 0, width: 1080, height: 720))
        root.onAppearanceChange = { [weak self] in self?.pushSystemTheme() }
        w.contentView = root

        // Two drag regions, not one band. The old full-width strip made the
        // whole top of the window inert: text up there looked normal but could
        // not be selected or clicked. Now the chrome is one small bar, and the
        // document is meant to run underneath it uninterrupted, so the strip
        // shrinks to the bar and the rest of that row goes back to being the
        // document. The thin edge strip is the concession: a window you can
        // only pick up by one 103px patch is a window you fumble.
        let s = DragStrip()
        let e = DragStrip()
        // A third, for the empty run past the last tab once the strip is out.
        // Dragging a window by the blank part of its tab bar is muscle memory
        // everywhere else, and the web layer cannot move its own window.
        let r = DragStrip()
        r.isHidden = true
        let p = PeekProbe()
        v.translatesAutoresizingMaskIntoConstraints = false
        s.translatesAutoresizingMaskIntoConstraints = false
        e.translatesAutoresizingMaskIntoConstraints = false
        r.translatesAutoresizingMaskIntoConstraints = false
        p.translatesAutoresizingMaskIntoConstraints = false
        root.addSubview(v)
        root.addSubview(s, positioned: .above, relativeTo: v)
        root.addSubview(e, positioned: .above, relativeTo: v)
        root.addSubview(r, positioned: .above, relativeTo: e)
        // Topmost, so nothing can shadow its tracking area. It takes no clicks
        // either way — hitTest returns nil — so being on top costs nothing.
        root.addSubview(p, positioned: .above, relativeTo: r)

        let sx = s.leadingAnchor.constraint(equalTo: root.leadingAnchor,
                                            constant: kTrafficInset - kBarPad)
        let sw = s.widthAnchor.constraint(equalToConstant: kBarWidth)
        let sh = s.heightAnchor.constraint(equalToConstant: kBarHeight)

        let rx = r.leadingAnchor.constraint(equalTo: root.leadingAnchor, constant: 0)
        let rw = r.widthAnchor.constraint(equalToConstant: 0)
        let rh = r.heightAnchor.constraint(equalToConstant: kBarHeight)
        let ph = p.heightAnchor.constraint(equalToConstant: kPeekBand)

        NSLayoutConstraint.activate([
            v.leadingAnchor.constraint(equalTo: root.leadingAnchor),
            v.trailingAnchor.constraint(equalTo: root.trailingAnchor),
            v.topAnchor.constraint(equalTo: root.topAnchor),
            v.bottomAnchor.constraint(equalTo: root.bottomAnchor),

            sx, sw, sh,
            s.topAnchor.constraint(equalTo: root.topAnchor),

            e.leadingAnchor.constraint(equalTo: root.leadingAnchor),
            e.trailingAnchor.constraint(equalTo: root.trailingAnchor),
            e.topAnchor.constraint(equalTo: root.topAnchor),
            e.heightAnchor.constraint(equalToConstant: kEdgeGrip),

            rx, rw, rh,
            r.topAnchor.constraint(equalTo: root.topAnchor),

            p.leadingAnchor.constraint(equalTo: root.leadingAnchor),
            p.trailingAnchor.constraint(equalTo: root.trailingAnchor),
            p.topAnchor.constraint(equalTo: root.topAnchor),
            ph
        ])

        p.onChange = { [weak self] inside in self?.reportPeek(inside) }

        self.window = w
        self.web = v
        self.strip = s
        self.edge = e
        self.rest = r
        self.probe = p
        self.stripX = sx
        self.stripW = sw
        self.stripH = sh
        self.restX = rx
        self.restW = rw
        self.restH = rh
        self.probeH = ph

        let hadSavedFrame = UserDefaults.standard.string(forKey: "NSWindow Frame \(kFrameName)") != nil
        _ = w.setFrameAutosaveName(kFrameName)
        if !hadSavedFrame { w.center() }
        w.makeKeyAndOrderFront(nil)
        w.positionTrafficLights()
    }

    func loadWebLayer() {
        guard let resources = Bundle.main.resourceURL else { return }
        let index = resources.appendingPathComponent("index.html")
        guard FileManager.default.fileExists(atPath: index.path) else {
            presentError("minimark could not start",
                         "index.html is missing from the app bundle's Resources folder.")
            return
        }
        // Read access is granted at the filesystem root so a document's own
        // images (file:///Users/…/pic.png, resolved by the renderer against the
        // document folder) can load. The renderer strips <script>, <iframe>,
        // on* handlers and javascript: URLs before anything reaches the DOM.
        web.loadFileURL(index, allowingReadAccessTo: URL(fileURLWithPath: "/"))
    }

    // ------------------------------------------------------------------
    // Native to web
    // ------------------------------------------------------------------

    func js(_ code: String) {
        web?.evaluateJavaScript(code, completionHandler: nil)
    }

    func command(_ name: String) {
        js("if(window.App&&App.command)App.command(\(jsLiteral(name)))")
    }

    func toast(_ message: String) {
        js("if(window.App&&App.toast)App.toast(\(jsLiteral(message)))")
    }

    /// The document as the web layer currently holds it, or nil if it could
    /// not answer.
    ///
    /// The distinction matters more than it looks. Every caller writes what
    /// it gets straight to disk, and the old `?? ""` turned a JavaScript
    /// error — a throw anywhere inside getText, or the bridge not being up
    /// yet — into an empty document, which then overwrote the file. An empty
    /// string is a legitimate answer for an empty document; a failure is not
    /// an answer at all, and the only safe response is to leave the file
    /// alone.
    /// With an id, the text of any open tab — autosave runs against every
    /// dirty document, not only the one on screen. The web layer answers null
    /// for a tab it does not have, which lands here as the same "could not
    /// read it" that a thrown getText does, and is treated the same way.
    func fetchText(_ id: Int? = nil, _ done: @escaping (String?) -> Void) {
        let arg = id.map(String.init) ?? ""
        web.evaluateJavaScript("window.App?App.getText(\(arg)):null") { result, error in
            if error != nil { done(nil); return }
            done(result as? String)
        }
    }

    func fetchHTML(_ done: @escaping (String?) -> Void) {
        web.evaluateJavaScript("window.App?App.getHTML():null") { result, error in
            if error != nil { done(nil); return }
            done(result as? String)
        }
    }

    /// The history store as JSON, or nil if there is nothing new to write.
    /// The web layer pins the present before answering, and returns null rather
    /// than an empty string when nothing has changed — so a failed round trip
    /// and "no changes" are indistinguishable here, and both correctly write
    /// nothing.
    func fetchHistory(_ done: @escaping (String?) -> Void) {
        web.evaluateJavaScript("window.App&&App.histCommit?App.histCommit():null") { result, error in
            if error != nil { done(nil); return }
            done(result as? String)
        }
    }

    func pushPrefs() {
        var out: [String: String] = [:]
        for key in kPrefKeys {
            if let value = UserDefaults.standard.string(forKey: key) { out[key] = value }
        }
        guard let data = try? JSONSerialization.data(withJSONObject: out, options: []),
              let json = String(data: data, encoding: .utf8) else { return }
        js("if(window.App)App.setPrefs(\(json))")
    }

    /// Handed over separately from the prefs so a large blob never sits in the
    /// same evaluateJavaScript call as the settings that decide how the first
    /// frame is drawn.
    func pushHistory() {
        guard let json = history.load(), !json.isEmpty else { return }
        js("if(window.App&&App.setHistory)App.setHistory(\(jsLiteral(json)))")
    }

    func pushSystemTheme() {
        let dark = NSApp.effectiveAppearance.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua
        js("if(window.App)App.setSystemTheme(\(jsLiteral(dark ? "dark" : "light")))")
    }

    /// The writer's own stylesheet, into the editor. It goes in after
    /// styles.css and after the theme, so it wins on specificity ties without
    /// anybody having to write !important, and it reaches print and PDF for
    /// free because both of those paginate this same live web view.
    func pushUserCSS() {
        let css = Templates.userCSS()
        if css == lastUserCSS { return }
        lastUserCSS = css
        js("if(window.App&&App.setUserCSS)App.setUserCSS(\(jsLiteral(css)))")
    }

    func pushSaved(_ url: URL, tab: DocTab? = nil) {
        let id = (tab ?? activeTab)?.id ?? activeID
        js("if(window.App)App.setSaved(\(jsLiteral(url.lastPathComponent))," +
           "\(jsLiteral(url.deletingLastPathComponent().path)),\(id))")
    }

    /// The whole tab list. Sent on every change rather than diffed: it is a
    /// handful of short strings, and one reconciliation path on the far side
    /// is worth more than the bytes a patch would save.
    func pushTabs() {
        guard webReady else { return }
        let rows: [[String: Any]] = tabs.map { t in
            ["id": t.id, "name": t.name, "dir": t.dir,
             "dirty": t.dirty, "active": t.id == activeID]
        }
        guard let data = try? JSONSerialization.data(withJSONObject: rows, options: []),
              let json = String(data: data, encoding: .utf8) else { return }
        js("if(window.App&&App.setTabs)App.setTabs(\(json))")
    }

    /// The pointer has arrived at, or left, the top edge of the window.
    func reportPeek(_ inside: Bool) {
        guard webReady else { return }
        js("if(window.App&&App.setPeek)App.setPeek(\(inside ? "true" : "false"))")
    }

    // ------------------------------------------------------------------
    // Web to native
    // ------------------------------------------------------------------

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any],
              let type = body["type"] as? String else { return }

        switch type {

        case "ready":
            handleReady()

        case "pref":
            guard let key = body["key"] as? String, kPrefKeys.contains(key) else { return }
            UserDefaults.standard.set(body["value"] as? String ?? "", forKey: key)

        case "histWrite":
            // An empty payload would truncate the sidecar to nothing, and load()
            // treats an empty file as no history at all. The web layer sends
            // "{\"docs\":{}}" when it means empty; it never means it with "".
            if let json = body["json"] as? String, !json.isEmpty {
                history.write(json)
            }

        case "dirty":
            let dirty = (body["dirty"] as? Bool) ?? false
            // Filed against the tab it came from, not against whichever is in
            // front. Only the document on screen can be edited, so in practice
            // they are the same, but a message in flight while a tab switch
            // lands would otherwise mark the wrong document.
            let target = (body["id"] as? Int).flatMap { tab($0) } ?? activeTab
            target?.dirty = dirty
            window?.isDocumentEdited = tabs.contains { $0.dirty }
            if dirty { scheduleAutosave() }
            // No pushTabs here. The strip flips its own dot as the key is
            // pressed; sending the whole list back would rebuild every tab
            // node twice a second for a change the far side has already made.

        case "tabNew":
            newTab()

        case "tabSelect":
            if let id = body["id"] as? Int { activate(id) }

        case "tabClose":
            if let id = body["id"] as? Int { closeTab(id) }

        case "tabMove":
            if let id = body["id"] as? Int, let to = body["to"] as? Int { moveTab(id, to: to) }

        case "tabsOpen":
            tabsShowing = (body["on"] as? Bool) ?? false
            // The band the probe watches grows with the strip, so a pointer
            // that has moved down onto a tab is still "at the top edge" and
            // the strip does not shut under it.
            probeH?.constant = tabsShowing ? kPeekBandOpen : kPeekBand
            // Applied now rather than next run loop turn: the pointer is
            // already inside the old band and the new one has to contain it
            // before the strip finishes sliding, or the exit fires under it.
            window?.contentView?.layoutSubtreeIfNeeded()
            applyChrome()

        case "tabDrag":
            // Where the empty run past the last tab is, so the drag region can
            // be parked exactly over it. Zero width means there is none.
            let x = (body["x"] as? Double) ?? 0
            let w = (body["w"] as? Double) ?? 0
            let h = (body["h"] as? Double) ?? Double(kBarHeight)
            restX?.constant = CGFloat(x).rounded()
            restW?.constant = max(0, CGFloat(w).rounded())
            restH?.constant = max(0, CGFloat(h).rounded())
            applyChrome()

        case "menu":
            if let name = body["name"] as? String { runMenuAction(name) }

        case "openRecent":
            if let path = body["path"] as? String, !path.isEmpty {
                openRecentDocument(URL(fileURLWithPath: path))
            }

        case "rename":
            if let name = body["name"] as? String { renameDocument(to: name) }

        case "openURL":
            if let string = body["url"] as? String, let url = URL(string: string),
               let scheme = url.scheme?.lowercased(),
               ["http", "https", "mailto"].contains(scheme) {
                NSWorkspace.shared.open(url)
            }

        case "copyRich":
            writeRichText(html: body["html"] as? String ?? "",
                          text: body["text"] as? String ?? "")

        case "pasteImage":
            savePastedImage(base64: body["data"] as? String ?? "",
                            ext: body["ext"] as? String ?? "png")

        case "barX":
            // The bar moved: the window's corner in live view, centred on
            // the pane divider in split. It is the same size in both. `x` is
            // where the buttons go, so the bar's own left edge is that less
            // its padding; `w` and `h` are what the web layer actually drew.
            //
            // Unpacked longhand on purpose. `(body["w"] as? Double).map(CGFloat.init)`
            // reads better but CGFloat.init has enough overloads that passing
            // it as a function reference defeats the type checker outright.
            guard let x = body["x"] as? Double else { break }
            var barW: CGFloat? = nil
            var barH: CGFloat? = nil
            if let v = body["w"] as? Double { barW = CGFloat(v) }
            if let v = body["h"] as? Double { barH = CGFloat(v) }
            moveChrome(to: CGFloat(x), width: barW, height: barH)

        case "zen":
            zenOn = (body["on"] as? Bool) ?? false
            // Cleared on every change, not only on the way out. Clearing it
            // only when zen ended meant a reveal latched before zen started
            // was still standing when zen began, so the bar and the traffic
            // lights sat on the paper for the whole session and nothing but
            // toggling zen off and on again would shift them.
            zenRevealed = false
            applyChrome()

        case "zenReveal":
            zenRevealed = (body["on"] as? Bool) ?? false
            applyChrome()

        case "dragWindow":
            // Belt and braces. With the native strip in place the web layer
            // never sees this mousedown, so this path only runs if the strip
            // is hidden (full screen) or disabled.
            if let event = NSApp.currentEvent,
               event.type == .leftMouseDown || event.type == .leftMouseDragged {
                window?.performDrag(with: event)
            }

        default:
            break
        }
    }

    func handleReady() {
        webReady = true
        pushPrefs()
        pushHistory()
        pushRecents()
        pushSystemTheme()
        pushUserCSS()
        applyChrome()

        if let url = pendingOpen {
            pendingOpen = nil
            // A document arriving with the launch replaces the session rather
            // than joining it: double-clicking a file in Finder means "show me
            // this", not "show me this and the nine things I had open".
            tabs = [makeTab(url: nil)]
            activeID = tabs[0].id
            openDocument(at: url)
            let extra = pendingExtra
            pendingExtra = []
            for other in extra { openDocument(at: other) }
            if !extra.isEmpty { activate(tabs[0].id) }
            return
        }

        if restoreSession() { return }

        // Nothing to restore. Leave the welcome document the web layer has
        // already put on screen — loadDoc with empty text would wipe it — and
        // give it a tab to sit in. The web layer adopts what is on screen into
        // that tab rather than blanking it.
        tabs = [makeTab(url: nil)]
        activeID = tabs[0].id
        pushTabs()
        syncWindowToTab()
    }

    // ------------------------------------------------------------------
    // Tabs
    // ------------------------------------------------------------------

    func makeTab(url: URL?) -> DocTab {
        let tab = DocTab(id: nextTabID, url: url, placeholder: freeUntitledName())
        nextTabID += 1
        return tab
    }

    /// Untitled.md, then Untitled 2.md, and so on. Three tabs all called
    /// Untitled.md is a strip you cannot read.
    func freeUntitledName() -> String {
        let taken = Set(tabs.filter { $0.url == nil }.map { $0.placeholder })
        if !taken.contains("Untitled.md") { return "Untitled.md" }
        var n = 2
        while taken.contains("Untitled \(n).md") { n += 1 }
        return "Untitled \(n).md"
    }

    /// Bring a tab to the front. Safe to call for the tab already in front:
    /// the web layer reconciles rather than reloading, so nothing is disturbed.
    func activate(_ id: Int) {
        guard tab(id) != nil else { return }
        activeID = id
        syncWindowToTab()
        pushTabs()
        saveSession()
    }

    /// The window furniture that follows whichever document is in front.
    func syncWindowToTab() {
        let url = activeTab?.url
        window?.representedURL = url
        window?.title = url?.lastPathComponent ?? "minimark"
        window?.isDocumentEdited = tabs.contains { $0.dirty }
        if let url = url {
            // NSDocumentController keeps the list for us — deduped, capped,
            // persisted, and shared with the Dock menu and the Apple menu's
            // Recent Items. No second copy of it in UserDefaults.
            NSDocumentController.shared.noteNewRecentDocumentURL(url)
            pushRecents()
        }
    }

    func newTab() {
        let tab = makeTab(url: nil)
        // Next to the one in front rather than at the end, so a tab opened
        // while reading something lands beside it.
        let at = (tabs.firstIndex { $0.id == activeID }).map { $0 + 1 } ?? tabs.count
        tabs.insert(tab, at: at)
        activeID = tab.id
        // No loadDoc: setTabs names a tab the page has no session for, and a
        // tab with no session is a blank document. Saying so twice would only
        // give it two chances to disagree with itself.
        pushTabs()
        syncWindowToTab()
        saveSession()
    }

    func closeTab(_ id: Int) {
        guard let doomed = tab(id) else { return }

        // The last tab is the window. Closing it goes through the window's own
        // path so the quit and the discard prompt stay in one place.
        guard tabs.count > 1 else {
            window?.performClose(nil)
            return
        }

        confirmClose(doomed) { ok in
            guard ok, let at = (self.tabs.firstIndex { $0.id == id }) else { return }
            self.tabs.remove(at: at)
            if self.activeID == id {
                // The one to its right, or its left if it was last. Moving to
                // the neighbour is what everything else with tabs does, and it
                // keeps a run of closes walking in one direction.
                let next = self.tabs[min(at, self.tabs.count - 1)]
                self.activeID = next.id
            }
            self.pushTabs()
            self.syncWindowToTab()
            self.saveSession()
        }
    }

    func moveTab(_ id: Int, to: Int) {
        guard let from = (tabs.firstIndex { $0.id == id }) else { return }
        let dest = max(0, min(to, tabs.count - 1))
        guard dest != from else { return }
        tabs.insert(tabs.remove(at: from), at: dest)
        pushTabs()
        saveSession()
    }

    /// Everything that has to happen before a tab can go away. A document with
    /// a path is simply written, the same as the autosave a second later would
    /// have: asking about a file the app saves by itself is theatre. One that
    /// has never been saved has nowhere to go, so that one gets the question.
    func confirmClose(_ tab: DocTab, _ done: @escaping (Bool) -> Void) {
        guard tab.dirty else { done(true); return }

        if let url = tab.url {
            fetchText(tab.id) { text in
                if let text = text { self.write(text, to: url) }
                done(true)
            }
            return
        }

        // A sheet needs a window that is actually on screen. Without one
        // beginSheetModal never presents and its completion never runs, which
        // would leave the close hanging on an answer that can no longer come.
        guard let window = window, window.isVisible else { done(false); return }

        let alert = NSAlert()
        alert.messageText = "Save changes to “\(tab.name)”?"
        alert.informativeText = "Your changes will be lost if you don't save them."
        alert.addButton(withTitle: "Save")
        alert.addButton(withTitle: "Don't Save")
        alert.addButton(withTitle: "Cancel")
        alert.beginSheetModal(for: window) { response in
            switch response {
            case .alertFirstButtonReturn:  self.saveAs(tab: tab, done)
            case .alertSecondButtonReturn: done(true)
            default:                       done(false)
            }
        }
    }

    // ------------------------------------------------------------------
    // Session
    // ------------------------------------------------------------------

    func saveSession() {
        let defaults = UserDefaults.standard
        let saved = tabs.filter { $0.url != nil }
        defaults.set(saved.map { $0.url!.path }, forKey: kOpenDocsKey)
        defaults.set(saved.firstIndex { $0.id == activeID } ?? 0, forKey: kActiveDocKey)
        // Written alongside so a build without tabs, or an older one, still
        // finds the document that was in front.
        if let url = activeTab?.url { defaults.set(url.path, forKey: kLastDocKey) }
        else { defaults.removeObject(forKey: kLastDocKey) }
    }

    /// Reopen what was open. Returns false when there was nothing to reopen,
    /// which is the caller's signal to leave the welcome document alone.
    @discardableResult
    func restoreSession() -> Bool {
        let defaults = UserDefaults.standard
        var paths = defaults.stringArray(forKey: kOpenDocsKey) ?? []
        if paths.isEmpty, let legacy = defaults.string(forKey: kLastDocKey) { paths = [legacy] }

        let fm = FileManager.default
        var seen = Set<String>()
        let urls = paths
            .filter { !$0.isEmpty && fm.isReadableFile(atPath: $0) }
            .map { URL(fileURLWithPath: $0).standardizedFileURL }
            .filter { seen.insert($0.path).inserted }
            .prefix(kMaxRestoredTabs)
        guard !urls.isEmpty else { return false }

        var restored: [DocTab] = []
        var texts: [(DocTab, String)] = []
        for url in urls {
            // A file that has become unreadable since it was noted is skipped
            // rather than reported: a launch is the wrong moment for a stack of
            // alerts about documents nobody has asked for yet.
            guard let text = readText(url) else { continue }
            let tab = DocTab(id: nextTabID, url: url)
            nextTabID += 1
            restored.append(tab)
            texts.append((tab, text))
        }
        guard !restored.isEmpty else { return false }

        tabs = restored
        let want = defaults.integer(forKey: kActiveDocKey)
        activeID = restored[max(0, min(want, restored.count - 1))].id

        // Every session is handed over before the list is, so the strip has
        // somewhere to switch *to*. setTabs then activates whichever was in
        // front and the web layer finds its text already waiting.
        for (tab, text) in texts {
            js("if(window.App)App.loadDoc(\(jsLiteral(text))," +
               "\(jsLiteral(tab.name)),\(jsLiteral(tab.dir)),\(tab.id))")
        }
        pushTabs()
        syncWindowToTab()
        return true
    }

    // ------------------------------------------------------------------
    // Documents
    // ------------------------------------------------------------------

    /// Give a tab a path, and follow it with everything that hangs off one.
    /// Defaults to the tab in front, which is what every caller written before
    /// tabs existed means.
    func setDocument(_ url: URL?, tab: DocTab? = nil) {
        guard let target = tab ?? activeTab else { return }
        target.url = url
        target.mtime = url.flatMap(modificationDate)
        if let url = url {
            NSDocumentController.shared.noteNewRecentDocumentURL(url)
            pushRecents()
        }
        if target.id == activeID { syncWindowToTab() }
        pushTabs()
        saveSession()
    }

    func readText(_ url: URL) -> String? {
        if let s = try? String(contentsOf: url, encoding: .utf8) { return s }
        var used = String.Encoding.utf8
        if let s = try? String(contentsOf: url, usedEncoding: &used) { return s }
        if let d = try? Data(contentsOf: url) { return String(decoding: d, as: UTF8.self) }
        return nil
    }

    /// `silent` is for the autosave path, which runs unprompted: a modal sheet
    /// there interrupts typing, and because the document stays dirty every
    /// keystroke reschedules the write, so one unwritable file produces an
    /// alert roughly once a second.
    @discardableResult
    func write(_ text: String, to url: URL, silent: Bool = false) -> Bool {
        do {
            try text.write(to: url, atomically: true, encoding: .utf8)
            stampMTime(url)                        // don't watch our own write back in
            return true
        } catch {
            if !silent {
                presentError("Could not save “\(url.lastPathComponent)”", error.localizedDescription)
            }
            return false
        }
    }

    /// Every tab holding this path, so the watcher does not report our own
    /// write back to us as an outside change.
    func stampMTime(_ url: URL) {
        let now = modificationDate(url)
        let target = url.standardizedFileURL
        for tab in tabs where tab.url?.standardizedFileURL == target { tab.mtime = now }
    }

    /// Open a file into a tab. Which tab depends on what is in front: an
    /// untitled document nobody has typed in is a placeholder, so it is used
    /// rather than left behind, and anything else gets a tab of its own.
    func openDocument(at url: URL) {
        // Already open. Two tabs on one file would give it two undo stacks and
        // two autosaves racing for the same path, so this brings the one that
        // exists forward instead.
        if let open = tabs.first(where: { $0.url?.standardizedFileURL == url.standardizedFileURL }) {
            activate(open.id)
            command("showTabs")
            return
        }

        guard let text = readText(url) else {
            presentError("Could not open “\(url.lastPathComponent)”",
                         "The file could not be read as text.")
            return
        }

        let target: DocTab
        if let current = activeTab, current.url == nil, !current.dirty {
            target = current
        } else {
            let fresh = makeTab(url: nil)
            let at = (tabs.firstIndex { $0.id == activeID }).map { $0 + 1 } ?? tabs.count
            tabs.insert(fresh, at: at)
            target = fresh
        }

        target.dirty = false
        // The text first, then the list. loadDoc parks a document named
        // against a tab that is not yet in front, so by the time setTabs
        // switches to it the page already has it — the other order shows an
        // empty document for however long the two messages take to cross.
        js("if(window.App)App.loadDoc(\(jsLiteral(text))," +
           "\(jsLiteral(url.lastPathComponent))," +
           "\(jsLiteral(url.deletingLastPathComponent().path)),\(target.id))")
        activeID = target.id
        setDocument(url, tab: target)
        syncWindowToTab()
    }

    func docContentTypes() -> [UTType] {
        var types: [UTType] = []
        for ext in kDocExtensions {
            if let t = UTType(filenameExtension: ext), !types.contains(t) { types.append(t) }
        }
        return types.isEmpty ? [.plainText] : types
    }

    /// Matches docContentTypes: the panel filters by UTType, not by extension.
    /// Falls back to the umbrella .image so an odd system with no mapping for
    /// one of these still offers every image rather than nothing at all.
    func imageContentTypes() -> [UTType] {
        var types: [UTType] = []
        for ext in kImageExtensions {
            if let t = UTType(filenameExtension: ext), !types.contains(t) { types.append(t) }
        }
        return types.isEmpty ? [.image] : types
    }

    /// Save when there is a path, Save As when there is not. Defaults to the
    /// tab in front; the close and quit paths name one, because by then the
    /// document being written may not be the one on screen.
    func saveDocument(tab: DocTab? = nil, _ done: @escaping (Bool) -> Void) {
        guard let target = tab ?? activeTab else { done(false); return }
        guard let url = target.url else { saveAs(tab: target, done); return }
        fetchText(target.id) { text in
            guard let text = text else {
                self.presentError("Could not save “\(url.lastPathComponent)”",
                                  "minimark could not read the document back from the editor. "
                                  + "The file on disk has been left as it was.")
                done(false)
                return
            }
            let ok = self.write(text, to: url)
            if ok {
                target.dirty = false
                self.window?.isDocumentEdited = self.tabs.contains { $0.dirty }
                self.pushSaved(url, tab: target)
            }
            done(ok)
        }
    }

    func saveAs(tab: DocTab? = nil, _ done: @escaping (Bool) -> Void) {
        guard let target = tab ?? activeTab, let window = window else { done(false); return }
        let panel = NSSavePanel()
        panel.allowedContentTypes = docContentTypes()
        panel.nameFieldStringValue = target.name
        panel.canCreateDirectories = true
        panel.isExtensionHidden = false
        panel.beginSheetModal(for: window) { response in
            guard response == .OK, let url = panel.url else { done(false); return }
            self.fetchText(target.id) { text in
                guard let text = text else {
                    self.presentError("Could not save “\(url.lastPathComponent)”",
                                      "minimark could not read the document back from the editor.")
                    done(false)
                    return
                }
                guard self.write(text, to: url) else { done(false); return }
                target.dirty = false
                self.setDocument(url, tab: target)
                self.window?.isDocumentEdited = self.tabs.contains { $0.dirty }
                self.pushSaved(url, tab: target)
                done(true)
            }
        }
    }

    /// Everything that has to be settled before the window can go. Each dirty
    /// tab in turn, on the same terms as closing one: a document with a path
    /// is written, one that has never been saved is asked about, and a Cancel
    /// anywhere stops the whole thing.
    func confirmDiscard(_ done: @escaping (Bool) -> Void) {
        var queue = tabs.filter { $0.dirty }
        guard !queue.isEmpty else { done(true); return }

        func step() {
            guard !queue.isEmpty else { done(true); return }
            let next = queue.removeFirst()
            confirmClose(next) { ok in
                guard ok else { done(false); return }
                step()
            }
        }
        step()
    }

    func renameDocument(to raw: String) {
        guard let target = activeTab, let url = target.url else { menuSaveAs(nil); return }

        var name = raw
            .replacingOccurrences(of: "/", with: "-")
            .replacingOccurrences(of: ":", with: "-")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty else { return }

        if (name as NSString).pathExtension.isEmpty && !url.pathExtension.isEmpty {
            name += "." + url.pathExtension
        }
        guard name != url.lastPathComponent else { return }

        let dest = url.deletingLastPathComponent().appendingPathComponent(name)
        if FileManager.default.fileExists(atPath: dest.path) {
            presentError("Could not rename", "“\(name)” already exists in that folder.")
            js("if(window.App)App.renamed(\(jsLiteral(url.lastPathComponent)),\(target.id))")
            return
        }
        do {
            try FileManager.default.moveItem(at: url, to: dest)
            setDocument(dest, tab: target)
            js("if(window.App)App.renamed(\(jsLiteral(name)),\(target.id))")
        } catch {
            presentError("Could not rename", error.localizedDescription)
            js("if(window.App)App.renamed(\(jsLiteral(url.lastPathComponent)),\(target.id))")
        }
    }

    // ------------------------------------------------------------------
    // Autosave + file watching
    // ------------------------------------------------------------------

    func scheduleAutosave() {
        autosaveWork?.cancel()
        // A never-saved Untitled has nowhere to go, but another tab may.
        guard tabs.contains(where: { $0.url != nil }) else { return }
        let work = DispatchWorkItem { [weak self] in self?.runAutosave() }
        autosaveWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + kAutosaveDelay, execute: work)
    }

    /// Every dirty document with a path, not only the one on screen. Editing a
    /// tab and switching away from it used to leave the edit unwritten until
    /// you came back — which, with several tabs open, could be never.
    func runAutosave() {
        for tab in tabs where tab.dirty && tab.url != nil {
            guard let url = tab.url else { continue }
            fetchText(tab.id) { text in
                // Silent on failure: autosave runs unprompted, so an alert here
                // would interrupt typing. The file keeps its last good contents
                // and the next save tries again.
                guard let text = text else { return }
                guard tab.url == url else { return }        // renamed mid-flight
                guard self.write(text, to: url, silent: true) else { return }
                tab.dirty = false
                self.window?.isDocumentEdited = self.tabs.contains { $0.dirty }
                self.js("if(window.App)App.autoSaved(\(tab.id))")
            }
        }
    }

    func startWatching() {
        let timer = Timer(timeInterval: kWatchInterval, repeats: true) { [weak self] _ in
            self?.checkFileOnDisk()
        }
        RunLoop.main.add(timer, forMode: .common)
        watchTimer = timer
    }

    /// Every open document, not only the one on screen — a tab you are not
    /// looking at is exactly the one something else is most likely to change
    /// underneath you.
    ///
    /// Only the one in front ever asks a question. A background document that
    /// has been edited elsewhere and has nothing unsaved of its own is simply
    /// brought up to date; one with unsaved changes is left alone until you go
    /// back to it, which is when there is a person to ask.
    func checkFileOnDisk() {
        guard !reloadPromptUp else { return }
        for tab in tabs {
            guard let url = tab.url, let now = modificationDate(url) else { continue }
            guard let known = tab.mtime else { tab.mtime = now; continue }
            guard now != known else { continue }

            // Nothing unsaved here, so there is nothing to decide: take the
            // new text, whether or not this is the document on screen.
            guard tab.dirty else {
                guard let text = readText(url) else { continue }
                tab.mtime = now
                js("if(window.App)App.externalChange(\(jsLiteral(text)),\(tab.id))")
                continue
            }

            // Unsaved changes on both sides. Only the document in front gets
            // asked about, and the others keep their old modification date on
            // purpose — dropping it here would mark the change as handled and
            // the question would never be asked when you came back to the tab.
            guard tab.id == activeID, let window = window, window.isVisible else { continue }
            guard let text = readText(url) else { continue }
            tab.mtime = now

            reloadPromptUp = true
            let alert = NSAlert()
            alert.messageText = "“\(url.lastPathComponent)” changed on disk"
            alert.informativeText = "You have unsaved changes here. Reload the file and discard them, or keep what is on screen?"
            alert.addButton(withTitle: "Reload")
            alert.addButton(withTitle: "Keep Mine")
            alert.beginSheetModal(for: window) { response in
                self.reloadPromptUp = false
                guard response == .alertFirstButtonReturn else { return }
                tab.dirty = false
                self.window?.isDocumentEdited = self.tabs.contains { $0.dirty }
                self.js("if(window.App)App.externalChange(\(jsLiteral(text)),\(tab.id))")
            }
            return                              // one question at a time
        }
    }

    // ------------------------------------------------------------------
    // Pasteboard + pasted images
    // ------------------------------------------------------------------

    func writeRichText(html: String, text: String) {
        let pb = NSPasteboard.general
        pb.clearContents()
        var types: [NSPasteboard.PasteboardType] = []
        if !html.isEmpty { types.append(.html) }
        types.append(.string)
        pb.declareTypes(types, owner: nil)
        if !html.isEmpty { pb.setString(html, forType: .html) }
        pb.setString(text, forType: .string)
    }

    // ------------------------------------------------------------------
    // Images
    //
    // Images live beside the document. That is the one rule: the renderer
    // resolves a relative src against the document's folder, so a document and
    // its images move together and keep working. Pasting, dropping and picking
    // all end up here so they cannot drift apart.
    // ------------------------------------------------------------------

    /// A name not already taken in `dir`. Collisions get -2, -3, … rather than
    /// overwriting: dropping the same diagram twice should leave two files, not
    /// silently replace the first.
    func uniqueImageName(_ base: String, ext: String, in dir: URL) -> String {
        var name = "\(base).\(ext)"
        var n = 2
        while FileManager.default.fileExists(atPath: dir.appendingPathComponent(name).path) {
            name = "\(base)-\(n).\(ext)"
            n += 1
        }
        return name
    }

    /// The folder images belong in, or nil if the document has never been
    /// saved — in which case Save As is offered and `retry` runs if it succeeds.
    func imageFolder(orSaveThen retry: @escaping () -> Void) -> URL? {
        guard let url = docURL else {
            saveAs { ok in
                if ok { retry() }
                else { self.toast("Save the document first to add images") }
            }
            return nil
        }
        return url.deletingLastPathComponent()
    }

    func insertImageLinks(_ names: [String], at point: NSPoint?) {
        guard !names.isEmpty else { return }
        guard let data = try? JSONSerialization.data(withJSONObject: names, options: []),
              let list = String(data: data, encoding: .utf8) else { return }
        // A non-finite coordinate would interpolate as bare `nan` or `inf`,
        // which is a ReferenceError that takes the whole evaluation down and
        // loses the insert entirely. Nil means "no pointer", which the web
        // layer already handles.
        var target = "null"
        if let p = point, p.x.isFinite, p.y.isFinite {
            target = "{x:\(Double(p.x)),y:\(Double(p.y))}"
        }
        js("if(window.App&&App.insertImages)App.insertImages(\(list),\(target))")
    }

    /// Copy image files in beside the document. `point` is where a drop landed,
    /// in CSS pixels, or nil when there is no pointer involved.
    func importImages(_ urls: [URL], at point: NSPoint?) {
        guard !urls.isEmpty else { return }
        guard let dir = imageFolder(orSaveThen: { self.importImages(urls, at: point) })
        else { return }

        var names: [String] = []
        var failed: [String] = []
        for src in urls {
            // Already beside the document: link it where it lies rather than
            // making a second copy of a file that is already in the right place.
            if src.deletingLastPathComponent().standardizedFileURL == dir.standardizedFileURL {
                names.append(src.lastPathComponent)
                continue
            }
            var ext = src.pathExtension.lowercased().filter { $0.isLetter || $0.isNumber }
            if ext.isEmpty { ext = "png" }
            let base = sanitiseFileBase(src.deletingPathExtension().lastPathComponent)
            let name = uniqueImageName(base, ext: ext, in: dir)
            do {
                try FileManager.default.copyItem(at: src, to: dir.appendingPathComponent(name))
                names.append(name)
            } catch {
                failed.append(src.lastPathComponent)
            }
        }
        insertImageLinks(names, at: point)
        if !failed.isEmpty {
            presentError(failed.count == 1 ? "Could not add \(failed[0])"
                                           : "Could not add \(failed.count) images",
                         failed.joined(separator: "\n"))
        }
    }

    /// The clipboard has pixels rather than a file, so this one has to invent a
    /// name. Everything after that is the shared path.
    func savePastedImage(base64: String, ext rawExt: String) {
        guard let data = Data(base64Encoded: base64), !data.isEmpty else { return }
        guard let dir = imageFolder(orSaveThen: {
            self.savePastedImage(base64: base64, ext: rawExt)
        }) else { return }

        var ext = rawExt.lowercased().filter { $0.isLetter || $0.isNumber }
        if ext.isEmpty { ext = "png" }

        let docBase = sanitiseFileBase(
            (docURL?.deletingPathExtension().lastPathComponent) ?? "image")
        let stamp = DateFormatter()
        // Fixed format needs a fixed locale, or a non-Gregorian system
        // calendar writes its own era into the filename.
        stamp.locale = Locale(identifier: "en_US_POSIX")
        stamp.calendar = Calendar(identifier: .gregorian)
        stamp.dateFormat = "yyyyMMdd-HHmmss"
        let name = uniqueImageName("\(docBase)-\(stamp.string(from: Date()))",
                                   ext: ext, in: dir)
        do {
            try data.write(to: dir.appendingPathComponent(name))
            insertImageLinks([name], at: nil)
        } catch {
            presentError("Could not save the image", error.localizedDescription)
        }
    }

    /// File ▸ Insert Image…
    func menuInsertImage() {
        // Asked before the panel opens, so an unsaved document is dealt with
        // first rather than after the user has chosen a file.
        guard imageFolder(orSaveThen: { self.menuInsertImage() }) != nil else { return }

        // Opening the panel resigns first responder, which blurs the open block,
        // which commits and re-renders it. Remember the caret while it still
        // exists, or the image lands at the end of the document instead of where
        // the user was typing.
        js("if(window.App&&App.pinInsertPoint)App.pinInsertPoint()")

        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = true
        panel.canChooseDirectories = false
        panel.canChooseFiles = true
        panel.allowedContentTypes = imageContentTypes()
        panel.prompt = "Insert"
        panel.message = "Choose images to add to the document"

        let finish: (NSApplication.ModalResponse) -> Void = { response in
            guard response == .OK else { return }
            self.importImages(panel.urls, at: nil)
        }
        if let w = window, w.isVisible { panel.beginSheetModal(for: w, completionHandler: finish) }
        else { finish(panel.runModal()) }
    }

    // ------------------------------------------------------------------
    // Chrome: zen, zen reveal, full screen
    // ------------------------------------------------------------------

    /// Move and resize the buttons and the bar's drag region to match whatever
    /// the web layer has just drawn. Snapped to whole points: the buttons are
    /// small and a half-point offset shows as a soft edge.
    func moveChrome(to buttonX: CGFloat, width: CGFloat? = nil, height: CGFloat? = nil) {
        guard let win = window else { return }
        let x = buttonX.rounded()

        if let width = width { stripW?.constant = width.rounded() }
        if let height = height { stripH?.constant = height.rounded() }

        guard abs(win.trafficX - x) > 0.5 else { return }
        win.trafficX = x
        stripX?.constant = x - kBarPad
        win.positionTrafficLights()
    }

    func applyChrome() {
        guard let w = window else { return }
        let fullScreen = w.styleMask.contains(.fullScreen)

        // In full screen there is no bar to drag, and the top of the window
        // belongs to the document again.
        if fullScreen {
            strip?.isHidden = true
            edge?.isHidden = true
            // The strip can still be peeked at in full screen, and its empty
            // run still has to be draggable when it is.
            rest?.isHidden = !tabsShowing || (restW?.constant ?? 0) < 1
            return                 // leave the buttons to AppKit while full screen
        }

        // The thin grabbable margin runs the whole width of the window, which
        // is right when there is nothing up there but document, and wrong the
        // moment the tab strip arrives: it would lie across the top 8px of
        // every tab and the new-tab button, so a click near the top of a tab
        // would pick the window up instead of selecting the document.
        //
        // While the strip is out it goes, and the two regions beside the tabs
        // take over — the bar on the left, the empty run past the last tab on
        // the right. Both are the full height of the strip, so there is more
        // to grab than there was, not less, and none of it is over a tab.
        // Hiding it cannot interrupt a drag already under way: AppKit's
        // window-move loop belongs to the window once the mouse is down, not
        // to the view the mouse went down on.
        edge?.isHidden = tabsShowing

        // While zen has the bar hidden, its drag region has to go with it.
        // Otherwise there is an invisible dead patch sitting on the paper,
        // swallowing clicks and selections over text that looks perfectly live.
        //
        // The tab strip overrides zen: reaching for the top edge is a request
        // for the chrome back, and a strip arriving without the window buttons
        // in the corner it has just cleared for them looks broken.
        let hide = zenOn && !zenRevealed && !tabsShowing
        strip?.isHidden = hide
        rest?.isHidden = hide || !tabsShowing || (restW?.constant ?? 0) < 1
        for type in [NSWindow.ButtonType.closeButton, .miniaturizeButton, .zoomButton] {
            w.standardWindowButton(type)?.isHidden = hide
        }
    }

    // ------------------------------------------------------------------
    // Window delegate
    // ------------------------------------------------------------------

    func windowShouldClose(_ sender: NSWindow) -> Bool {
        guard tabs.contains(where: { $0.dirty }) else { return true }
        confirmDiscard { ok in
            guard ok else { return }
            for tab in self.tabs { tab.dirty = false }
            self.window?.isDocumentEdited = false
            self.window?.close()
        }
        return false
    }

    func windowDidResize(_ note: Notification)     { window?.positionTrafficLights() }
    func windowDidBecomeKey(_ note: Notification)  { window?.positionTrafficLights() }
    func windowDidEndLiveResize(_ note: Notification) { window?.positionTrafficLights() }

    func windowDidEnterFullScreen(_ note: Notification) {
        js("if(window.App)App.setFullscreen(true)")
        applyChrome()
    }

    func windowDidExitFullScreen(_ note: Notification) {
        js("if(window.App)App.setFullscreen(false)")
        applyChrome()
        window?.positionTrafficLights()
    }

    // ------------------------------------------------------------------
    // Navigation policy
    //
    // The web layer never navigates. Anything that tries is either a link the
    // JS did not intercept or a file dropped onto the window, and letting
    // WebKit follow it would replace the whole app with that page.
    // ------------------------------------------------------------------

    func webView(_ webView: WKWebView,
                 decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {

        guard let url = navigationAction.request.url else { decisionHandler(.cancel); return }

        if url.scheme == "about" { decisionHandler(.allow); return }

        if url.isFileURL {
            let index = Bundle.main.resourceURL?.appendingPathComponent("index.html")
            if let index = index,
               url.standardizedFileURL.path == index.standardizedFileURL.path {
                decisionHandler(.allow)
                return
            }
            decisionHandler(.cancel)
            if kDocExtensions.contains(url.pathExtension.lowercased()) {
                openDocument(at: url)
            }
            return
        }

        if let scheme = url.scheme?.lowercased(), ["http", "https", "mailto"].contains(scheme) {
            decisionHandler(.cancel)
            NSWorkspace.shared.open(url)
            return
        }

        decisionHandler(.cancel)
    }

    func webView(_ webView: WKWebView,
                 didFailProvisionalNavigation navigation: WKNavigation!,
                 withError error: Error) {
        presentError("minimark could not load its interface", error.localizedDescription)
    }

    // ------------------------------------------------------------------
    // Menu actions
    // ------------------------------------------------------------------

    /// The `menu` bridge message and the File menu items run the same code.
    func runMenuAction(_ name: String) {
        switch name {
        case "new":        menuNew(nil)
        case "newTab":     menuNew(nil)
        case "closeTab":   menuCloseTab(nil)
        case "open":       menuOpen(nil)
        case "save":       menuSave(nil)
        case "saveAs":     menuSaveAs(nil)
        case "templates":  menuTemplates(nil)
        case "exportHTML": menuExportHTML(nil)
        case "exportPDF":  menuExportPDF(nil)
        case "print":      menuPrint(nil)
        case "pageSetup":  menuPageSetup(nil)
        case "reveal":     menuReveal(nil)
        case "fullscreen": window?.toggleFullScreen(nil)
        case "zoom":       window?.performZoom(nil)
        default:           break
        }
    }

    @objc func webCommand(_ sender: NSMenuItem) {
        guard let name = sender.representedObject as? String else { return }
        command(name)
    }

    /// New and New Tab are the same act in a one-window app: a blank document
    /// alongside the others rather than over the top of one. Nothing is
    /// discarded, so nothing has to be asked about first.
    @objc func menuNew(_ sender: Any?) {
        newTab()
        command("showTabs")
    }

    @objc func menuCloseTab(_ sender: Any?) {
        guard let id = activeTab?.id else { window?.performClose(nil); return }
        closeTab(id)
    }

    @objc func menuOpen(_ sender: Any?) {
        guard let window = window else { return }
        let panel = NSOpenPanel()
        panel.allowedContentTypes = docContentTypes()
        // Several at once now that there is somewhere to put them.
        panel.allowsMultipleSelection = true
        panel.canChooseDirectories = false
        panel.beginSheetModal(for: window) { response in
            guard response == .OK, !panel.urls.isEmpty else { return }
            for url in panel.urls { self.openDocument(at: url) }
            self.command("showTabs")
        }
    }

    // ------------------------------------------------------------------
    // Open Recent
    //
    // The list itself is NSDocumentController's, so it is deduped, capped and
    // persisted by AppKit, and the same entries turn up in the Dock menu and
    // the Apple menu's Recent Items for free. This app has no NSDocument
    // subclasses, but noteNewRecentDocumentURL does not require one.
    // ------------------------------------------------------------------

    /// Recent documents that are still on disk. A menu that offers a file it
    /// cannot open is worse than a shorter menu.
    func recentDocuments() -> [URL] {
        // Every file already in a tab is dropped, not only the one in front:
        // offering to open something that is one click away in the strip is
        // noise, and taking it would only bring that tab forward anyway.
        let open = Set(tabs.compactMap { $0.url?.standardizedFileURL })
        return NSDocumentController.shared.recentDocumentURLs.filter { url in
            !open.contains(url.standardizedFileURL)
                && FileManager.default.isReadableFile(atPath: url.path)
        }
    }

    /// Two files called Notes.md need telling apart, so a name that appears
    /// more than once carries its enclosing folder.
    func recentTitles(_ urls: [URL]) -> [String] {
        var seen: [String: Int] = [:]
        for url in urls { seen[url.lastPathComponent, default: 0] += 1 }
        return urls.map { url in
            let name = url.lastPathComponent
            guard seen[name, default: 0] > 1 else { return name }
            let folder = url.deletingLastPathComponent().lastPathComponent
            return folder.isEmpty ? name : "\(name) — \(folder)"
        }
    }

    func menuNeedsUpdate(_ menu: NSMenu) {
        guard menu === recentMenu else { return }
        menu.removeAllItems()
        let urls = recentDocuments()
        if urls.isEmpty {
            // a nil action is all it takes: AppKit greys it out for us
            menu.addItem(NSMenuItem(title: "No Recent Documents", action: nil, keyEquivalent: ""))
            return
        }
        let titles = recentTitles(urls)
        for (i, url) in urls.enumerated() {
            let item = NSMenuItem(title: titles[i], action: #selector(openRecent(_:)), keyEquivalent: "")
            item.target = self
            item.representedObject = url
            item.toolTip = url.path
            let icon = NSWorkspace.shared.icon(forFile: url.path)
            icon.size = NSSize(width: 16, height: 16)
            item.image = icon
            menu.addItem(item)
        }
        menu.addItem(.separator())
        let clear = NSMenuItem(title: "Clear Menu", action: #selector(clearRecent(_:)), keyEquivalent: "")
        clear.target = self
        menu.addItem(clear)
    }

    @objc func openRecent(_ sender: NSMenuItem) {
        guard let url = sender.representedObject as? URL else { return }
        openRecentDocument(url)
    }

    func openRecentDocument(_ url: URL) {
        // Both the menu and the palette are built from readable files only, so
        // this is a race guard: the file went while the list was on screen.
        guard FileManager.default.isReadableFile(atPath: url.path) else {
            pushRecents()
            presentError("Could not open “\(url.lastPathComponent)”",
                         "The file has been moved, renamed or deleted.")
            return
        }
        openDocument(at: url)
    }

    @objc func clearRecent(_ sender: Any?) {
        NSDocumentController.shared.clearRecentDocuments(sender)
        pushRecents()
    }

    /// The palette is where this writer actually lives, so the same list goes
    /// over the bridge and can be typed at rather than pointed at.
    func pushRecents() {
        guard webReady else { return }
        let urls = recentDocuments()
        let titles = recentTitles(urls)
        let rows: [[String: String]] = urls.enumerated().map { i, url in
            ["name": titles[i], "path": url.path]
        }
        guard let data = try? JSONSerialization.data(withJSONObject: rows, options: []),
              let json = String(data: data, encoding: .utf8) else { return }
        js("if(window.App&&App.setRecents)App.setRecents(\(json))")
    }

    @objc func menuSave(_ sender: Any?) {
        saveDocument { _ in }
    }

    @objc func menuSaveAs(_ sender: Any?) {
        saveAs { _ in }
    }

    @objc func menuRename(_ sender: Any?) {
        guard let url = docURL else { menuSaveAs(sender); return }

        let alert = NSAlert()
        alert.messageText = "Rename document"
        alert.informativeText = "Enter a new name for “\(url.lastPathComponent)”."
        let field = NSTextField(frame: NSRect(x: 0, y: 0, width: 260, height: 24))
        field.stringValue = url.lastPathComponent
        alert.accessoryView = field
        alert.addButton(withTitle: "Rename")
        alert.addButton(withTitle: "Cancel")
        alert.window.initialFirstResponder = field
        alert.beginSheetModal(for: window) { response in
            guard response == .alertFirstButtonReturn else { return }
            self.renameDocument(to: field.stringValue)
        }
    }

    @objc func menuExportHTML(_ sender: Any?) {
        fetchHTML { body in
            guard let body = body else {
                self.presentError("Could not export",
                                  "minimark could not render the document to HTML.")
                return
            }
            let panel = NSSavePanel()
            panel.allowedContentTypes = [.html]
            let base = self.docURL?.deletingPathExtension().lastPathComponent ?? "Untitled"
            panel.nameFieldStringValue = base + ".html"
            panel.canCreateDirectories = true
            panel.beginSheetModal(for: self.window) { response in
                guard response == .OK, let url = panel.url else { return }
                let page = self.htmlDocument(title: base, body: body)
                do { try page.write(to: url, atomically: true, encoding: .utf8) }
                catch { self.presentError("Could not export", error.localizedDescription) }
            }
        }
    }

    // ------------------------------------------------------------------
    // Printing
    //
    // The live web view is what gets printed, so the page carries exactly what
    // the writer is looking at: rendered maths, highlighted code, images
    // already resolved against the document's folder. styles.css strips the
    // app back to #doc under @media print and forces ink on paper, because
    // none of the six themes belong on a sheet of A4.
    // ------------------------------------------------------------------

    func documentPrintInfo() -> NSPrintInfo {
        let info = (NSPrintInfo.shared.copy() as? NSPrintInfo) ?? NSPrintInfo.shared
        info.horizontalPagination = .automatic
        info.verticalPagination = .automatic
        info.isHorizontallyCentered = false
        info.isVerticallyCentered = false
        // Margins are deliberately left to NSPrintInfo — one inch by default,
        // and whatever Page Setup last set otherwise. An @page rule in the
        // stylesheet would be applied on top of these and double them.
        return info
    }

    /// A block open for editing is a textarea, and a textarea does not print.
    /// Close it, then give the layout a moment to settle before paginating.
    func prepareToPrint(_ done: @escaping () -> Void) {
        web?.evaluateJavaScript("if(window.App&&App.beforePrint)App.beforePrint();true") { _, _ in
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.12, execute: done)
        }
    }

    func printOperation(_ info: NSPrintInfo) -> NSPrintOperation? {
        guard let web = web else { return nil }
        let op = web.printOperation(with: info)
        // Without this the web view paginates against its on-screen width and
        // the right-hand side of every line falls off the sheet.
        op.view?.frame = NSRect(x: 0, y: 0,
                                width: info.paperSize.width - info.leftMargin - info.rightMargin,
                                height: info.paperSize.height - info.topMargin - info.bottomMargin)
        op.jobTitle = docURL?.deletingPathExtension().lastPathComponent ?? "Untitled"
        return op
    }

    /// Opens ~/Library/Application Support/minimark/ in Finder, writing the
    /// two starter files first if they are not there. Both are inert as
    /// shipped — the CSS is entirely inside a comment and the template is the
    /// built-in page — so opening the folder cannot change how the app looks
    /// until somebody decides it should.
    @objc func menuTemplates(_ sender: Any?) {
        Templates.writeStartersIfMissing()
        guard let dir = Templates.dir else {
            presentError("Could not open the templates folder",
                         "minimark could not reach its Application Support folder.")
            return
        }
        NSWorkspace.shared.open(dir)
    }

    /// Edits the shared print info directly, so paper size and margins stick
    /// for the next print rather than being thrown away with a copy.
    @objc func menuPageSetup(_ sender: Any?) {
        NSPageLayout().beginSheet(with: NSPrintInfo.shared, modalFor: window,
                                  delegate: nil, didEnd: nil, contextInfo: nil)
    }

    @objc func menuPrint(_ sender: Any?) {
        prepareToPrint { [weak self] in
            guard let self = self, let op = self.printOperation(self.documentPrintInfo()) else { return }
            op.showsPrintPanel = true
            op.showsProgressPanel = true
            op.runModal(for: self.window, delegate: nil, didRun: nil, contextInfo: nil)
        }
    }

    @objc func menuExportPDF(_ sender: Any?) {
        let panel = NSSavePanel()
        panel.allowedContentTypes = [.pdf]
        let base = docURL?.deletingPathExtension().lastPathComponent ?? "Untitled"
        panel.nameFieldStringValue = base + ".pdf"
        panel.canCreateDirectories = true
        panel.beginSheetModal(for: window) { [weak self] response in
            guard let self = self, response == .OK, let url = panel.url else { return }
            self.prepareToPrint {
                let info = self.documentPrintInfo()
                info.jobDisposition = .save
                // rawValue, not the AttributeKey itself: the dictionary is an
                // NSMutableDictionary and a Swift struct key would not bridge.
                info.dictionary()[NSPrintInfo.AttributeKey.jobSavingURL.rawValue] = url as NSURL
                guard let op = self.printOperation(info) else { return }
                op.showsPrintPanel = false
                op.showsProgressPanel = false
                op.runModal(for: self.window,
                            delegate: self,
                            didRun: #selector(self.pdfExportDidRun(_:success:contextInfo:)),
                            contextInfo: nil)
            }
        }
    }

    @objc func pdfExportDidRun(_ op: NSPrintOperation, success: Bool, contextInfo: UnsafeMutableRawPointer?) {
        toast(success ? "Exported as PDF" : "Could not export PDF")
    }

    @objc func menuReveal(_ sender: Any?) {
        guard let url = docURL else { toast("Save the document first"); return }
        NSWorkspace.shared.activateFileViewerSelecting([url])
    }

    @objc func menuInsertImageItem(_ sender: Any?) {
        menuInsertImage()
    }

    func validateMenuItem(_ menuItem: NSMenuItem) -> Bool {
        // The tab items are the one place the menu has state to show as well
        // as to enable: "Keep Tabs Showing" is a toggle and reads its own pref.
        if let name = menuItem.representedObject as? String {
            switch name {
            case "nextTab", "prevTab":
                return tabs.count > 1
            case "toggleTabs":
                menuItem.state = UserDefaults.standard.string(forKey: "tabsPin") == "1" ? .on : .off
                return true
            default:
                return true
            }
        }
        switch menuItem.action {
        case #selector(menuReveal(_:)), #selector(menuRename(_:)):
            return docURL != nil
        default:
            return true
        }
    }

    /// The stylesheet the exported page carries: the built-in one, then the
    /// writer's own, in that order so theirs wins.
    func exportCSS() -> String {
        let user = Templates.userCSS()
        return user.isEmpty ? kExportCSS : kExportCSS + "\n\n/* user.css */\n" + user
    }

    func htmlDocument(title: String, body: String) -> String {
        let safeTitle = title
            .replacingOccurrences(of: "&", with: "&amp;")
            .replacingOccurrences(of: "<", with: "&lt;")
            .replacingOccurrences(of: ">", with: "&gt;")

        // A template's own placeholders are filled and nothing else is
        // touched. Substitution is one pass over a fixed set of names rather
        // than anything resembling a template language: this is somebody's
        // HTML file, and the least surprising thing to do with it is put four
        // strings into it and leave.
        //
        // {{body}} goes in last, on purpose. It is the only substitution whose
        // value could itself contain the characters "{{title}}", and filling
        // it first would then let a document rewrite its own template.
        if let tpl = Templates.exportTemplate() {
            var out = tpl
            out = out.replacingOccurrences(of: "{{title}}", with: safeTitle)
            out = out.replacingOccurrences(of: "{{style}}", with: exportCSS())
            out = out.replacingOccurrences(of: "{{usercss}}", with: Templates.userCSS())
            out = out.replacingOccurrences(of: "{{date}}", with:
                DateFormatter.localizedString(from: Date(), dateStyle: .long, timeStyle: .none))
            out = out.replacingOccurrences(of: "{{body}}", with: body)
            return out
        }

        return """
        <!DOCTYPE html>
        <html lang="en">
        <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <title>\(safeTitle)</title>
        <style>
        \(exportCSS())
        </style>
        </head>
        <body>
        <main>
        \(body)
        </main>
        </body>
        </html>
        """
    }
}

/// The exported page's stylesheet, kept apart from the document that wraps it
/// so a template can ask for it by name with {{style}} without the two having
/// to agree on anything else.
let kExportCSS = """
          :root { color-scheme: light dark; --ink:#1c1b19; --paper:#fbfaf7; --rule:#e2ded6; --muted:#6b6862; }
          @media (prefers-color-scheme: dark) {
            :root { --ink:#e8e6e1; --paper:#191817; --rule:#33312e; --muted:#9a968e; }
          }
          html { background: var(--paper); }
          body { margin: 0; padding: 56px 24px 96px; color: var(--ink);
                 font: 17px/1.65 -apple-system, BlinkMacSystemFont, "Iowan Old Style", Georgia, serif; }
          main { max-width: 42rem; margin: 0 auto; }
          h1,h2,h3,h4 { line-height: 1.25; margin: 1.9em 0 .6em; font-weight: 650; letter-spacing: -.012em; }
          h1 { font-size: 2em; margin-top: 0; }
          p, ul, ol, blockquote, table, pre { margin: 0 0 1.1em; }
          a { color: inherit; text-underline-offset: 2px; }
          code, pre { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .88em; }
          pre { background: rgba(127,127,127,.10); padding: 14px 16px; border-radius: 8px; overflow-x: auto; }
          code { background: rgba(127,127,127,.12); padding: .12em .35em; border-radius: 4px; }
          pre code { background: none; padding: 0; }
          blockquote { margin-left: 0; padding-left: 1.1em; border-left: 2px solid var(--rule); color: var(--muted); }
          img { max-width: 100%; height: auto; }
          hr { border: 0; border-top: 1px solid var(--rule); margin: 2.4em 0; }
          table { border-collapse: collapse; width: 100%; font-size: .95em; }
          th, td { border: 1px solid var(--rule); padding: 7px 10px; text-align: left; }
          th { background: rgba(127,127,127,.08); }
"""

extension AppDelegate {
    func presentError(_ title: String, _ detail: String) {
        let alert = NSAlert()
        alert.messageText = title
        alert.informativeText = detail
        alert.alertStyle = .warning
        alert.addButton(withTitle: "OK")
        if let w = window, w.isVisible {
            alert.beginSheetModal(for: w, completionHandler: nil)
        } else {
            alert.runModal()
        }
    }

    // ------------------------------------------------------------------
    // Menu bar
    //
    // The JS handles every one of these shortcuts itself when the web view has
    // focus; a menu key equivalent is matched first, so nothing double-fires.
    // The items exist for discoverability and for when focus is elsewhere.
    // ------------------------------------------------------------------

    @discardableResult
    func add(_ menu: NSMenu,
             _ title: String,
             key: String = "",
             mods: NSEvent.ModifierFlags = .command,
             action: Selector? = nil,
             target: AnyObject? = nil,
             command name: String? = nil) -> NSMenuItem {

        let selector: Selector?
        if let action = action { selector = action }
        else if name != nil    { selector = #selector(webCommand(_:)) }
        else                   { selector = nil }

        let item = NSMenuItem(title: title, action: selector, keyEquivalent: key)
        item.keyEquivalentModifierMask = key.isEmpty ? [] : mods
        if let name = name {
            item.representedObject = name
            item.target = self
        } else if let target = target {
            item.target = target
        }
        menu.addItem(item)
        return item
    }

    func submenu(_ parent: NSMenu, _ title: String) -> NSMenu {
        let item = NSMenuItem(title: title, action: nil, keyEquivalent: "")
        let menu = NSMenu(title: title)
        item.submenu = menu
        parent.addItem(item)
        return menu
    }

    func buildMenu() {
        let main = NSMenu()

        // ---- minimark ----------------------------------------------------
        let app = submenu(main, "minimark")
        add(app, "About minimark",
            action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), target: NSApp)
        app.addItem(.separator())
        add(app, "Settings…", key: ",", command: "themes")
        app.addItem(.separator())
        add(app, "Hide minimark", key: "h",
            action: #selector(NSApplication.hide(_:)), target: NSApp)
        add(app, "Hide Others", key: "h", mods: [.command, .option],
            action: #selector(NSApplication.hideOtherApplications(_:)), target: NSApp)
        add(app, "Show All",
            action: #selector(NSApplication.unhideAllApplications(_:)), target: NSApp)
        app.addItem(.separator())
        add(app, "Quit minimark", key: "q",
            action: #selector(NSApplication.terminate(_:)), target: NSApp)

        // ---- File --------------------------------------------------------
        let file = submenu(main, "File")
        // Two names for the one act. minimark has a single window, so a new
        // document is always a new tab; ⌘N is what every Mac app trains you to
        // press and ⌘T is what everything with tabs does.
        add(file, "New", key: "n", action: #selector(menuNew(_:)), target: self)
        add(file, "New Tab", key: "t", action: #selector(menuNew(_:)), target: self)
        add(file, "Open…", key: "o", action: #selector(menuOpen(_:)), target: self)
        let recentItem = NSMenuItem(title: "Open Recent", action: nil, keyEquivalent: "")
        recentMenu = NSMenu(title: "Open Recent")
        recentMenu.delegate = self          // rebuilt each time it is pulled down
        recentItem.submenu = recentMenu
        file.addItem(recentItem)
        file.addItem(.separator())
        add(file, "Save", key: "s", action: #selector(menuSave(_:)), target: self)
        add(file, "Save As…", key: "s", mods: [.command, .shift],
            action: #selector(menuSaveAs(_:)), target: self)
        add(file, "Rename…", action: #selector(menuRename(_:)), target: self)
        file.addItem(.separator())
        add(file, "Insert Image…", key: "i", mods: [.command, .shift],
            action: #selector(menuInsertImageItem(_:)), target: self)
        file.addItem(.separator())
        add(file, "Export as HTML…", action: #selector(menuExportHTML(_:)), target: self)
        add(file, "Export as PDF…", action: #selector(menuExportPDF(_:)), target: self)
        add(file, "Reveal in Finder", action: #selector(menuReveal(_:)), target: self)
        file.addItem(.separator())
        // Without this the feature does not exist. Nobody finds two optional
        // files in a Library folder they were never told about, and a
        // stylesheet hook nobody can find is the same as no stylesheet hook.
        add(file, "Templates Folder…", action: #selector(menuTemplates(_:)), target: self)
        file.addItem(.separator())
        add(file, "Page Setup…", key: "p", mods: [.command, .shift],
            action: #selector(menuPageSetup(_:)), target: self)
        add(file, "Print…", key: "p", action: #selector(menuPrint(_:)), target: self)
        file.addItem(.separator())
        // ⌘W closes the tab, and the window along with it when it is the last
        // one, which is what every tabbed Mac app does. ⇧⌘W is the whole
        // window regardless.
        add(file, "Close Tab", key: "w", action: #selector(menuCloseTab(_:)), target: self)
        add(file, "Close Window", key: "w", mods: [.command, .shift],
            action: NSSelectorFromString("performClose:"))

        // ---- Edit --------------------------------------------------------
        let edit = submenu(main, "Edit")
        /* The web layer keeps the undo stack itself — WebKit's own is wiped
           every time a textarea's value is assigned, which the formatting
           commands do constantly. Route both items at the JS, not the
           responder chain, or ⌘Z reaches a stack that is always empty. */
        add(edit, "Undo", key: "z", command: "undo")
        add(edit, "Redo", key: "z", mods: [.command, .shift], command: "redo")
        edit.addItem(.separator())
        add(edit, "Cut", key: "x", action: NSSelectorFromString("cut:"))
        add(edit, "Copy", key: "c", action: NSSelectorFromString("copy:"))
        add(edit, "Paste", key: "v", action: NSSelectorFromString("paste:"))
        add(edit, "Select All", key: "a", action: NSSelectorFromString("selectAll:"))
        edit.addItem(.separator())
        add(edit, "Copy as Rich Text", key: "c", mods: [.command, .option], command: "copyRich")
        edit.addItem(.separator())
        add(edit, "Find", key: "f", command: "find")
        add(edit, "Find Next", key: "g", command: "findNext")
        add(edit, "Find Previous", key: "g", mods: [.command, .shift], command: "findPrev")
        edit.addItem(.separator())

        let restore = submenu(edit, "Restore")
        add(restore, "Version History…", key: "h", mods: [.command, .shift], command: "history")
        restore.addItem(.separator())
        let steps: [(String, String)] = [
            ("1 minute ago",   "restore1m"),
            ("5 minutes ago",  "restore5m"),
            ("15 minutes ago", "restore15m"),
            ("1 hour ago",     "restore1h"),
            ("5 hours ago",    "restore5h"),
            ("1 day ago",      "restore1d"),
            ("3 days ago",     "restore3d"),
            ("1 week ago",     "restore1w")
        ]
        for (title, name) in steps { add(restore, title, command: name) }
        add(restore, "Oldest snapshot", command: "restoreOldest")
        restore.addItem(.separator())
        add(restore, "Undo Restore", command: "restoreUndo")

        // ---- Format ------------------------------------------------------
        let format = submenu(main, "Format")
        add(format, "Bold", key: "b", command: "bold")
        add(format, "Italic", key: "i", command: "italic")
        add(format, "Inline Code", key: "e", command: "code")
        add(format, "Link", key: "k", mods: [.command, .shift], command: "link")

        // ---- View --------------------------------------------------------
        let view = submenu(main, "View")
        add(view, "Split", key: "1", command: "split")
        add(view, "Live", key: "2", command: "live")
        add(view, "Toggle Mode", key: "m", mods: [.command, .shift], command: "toggleMode")
        view.addItem(.separator())
        add(view, "Zen", key: "z", mods: [.control, .option], command: "zen")
        add(view, "Focus", key: "d", mods: [.command, .shift], command: "focus")
        add(view, "Typewriter", key: "t", mods: [.command, .shift], command: "typewriter")
        view.addItem(.separator())
        add(view, "Bigger Text", key: "+", command: "bigger")
        add(view, "Smaller Text", key: "-", command: "smaller")
        add(view, "Actual Size", key: "0", command: "resetSize")
        view.addItem(.separator())
        add(view, "Appearance", key: "l", mods: [.command, .shift], command: "themes")
        view.addItem(.separator())
        // The strip hides itself by design. This is for anyone who would
        // rather see it, and it is remembered.
        add(view, "Keep Tabs Showing", key: "t", mods: [.control, .option], command: "toggleTabs")
        view.addItem(.separator())
        add(view, "Enter Full Screen", key: "f", mods: [.control, .command],
            action: NSSelectorFromString("toggleFullScreen:"))

        // ---- Go ----------------------------------------------------------
        let go = submenu(main, "Go")
        add(go, "Command Palette", key: "k", command: "palette")
        add(go, "Jump to Heading", key: "r", command: "headings")

        // ---- Window ------------------------------------------------------
        // Standard on every Mac app, and ⌘M in particular is muscle memory.
        // ⇧⌘M is Toggle Mode here, which is close enough to ⌘M that leaving
        // Minimize unbound was a trap rather than a saving.
        let window = submenu(main, "Window")
        add(window, "Minimize", key: "m", action: NSSelectorFromString("performMiniaturize:"))
        add(window, "Zoom", action: NSSelectorFromString("performZoom:"))
        window.addItem(.separator())
        // ⌃⇥ and ⌃⇧⇥ here; ⇧⌘] and ⇧⌘[ are handled in the web layer, which is
        // the only way to have both without two more items in this menu.
        add(window, "Show Next Tab", key: "\t", mods: [.control], command: "nextTab")
        add(window, "Show Previous Tab", key: "\t", mods: [.control, .shift], command: "prevTab")
        window.addItem(.separator())
        add(window, "Bring All to Front",
            action: #selector(NSApplication.arrangeInFront(_:)), target: NSApp)
        NSApp.windowsMenu = window

        // ---- Help --------------------------------------------------------
        let help = submenu(main, "Help")
        add(help, "Markdown Reference", key: "/", command: "help")

        NSApp.mainMenu = main
        NSApp.helpMenu = help
    }
}

// ============================================================================
// Entry point
// ============================================================================

let application = NSApplication.shared
let minimarkDelegate = AppDelegate()
application.delegate = minimarkDelegate
application.run()
