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
/// How many wikilink names one render may ask about. A document with more
/// distinct links than this is not a document anybody is reading; the cap is
/// there so a pasted wall of [[...]] cannot make the app stat for a second.
let kMaxWikiCheck = 400
/// How many embedded files one render may read, and how large each may be.
/// Reading is the expensive half — a check is a stat, an embed is the whole
/// file — so this is far smaller than the check cap and the size is capped too.
/// A chapter is tens of kilobytes; a megabyte is somebody embedding a log.
let kMaxEmbedRead = 32
let kMaxEmbedBytes = 1 << 20
/// How long the launch waits for the history sidecar before showing documents
/// without it. Generous — it is a single file read on a warm cache almost
/// always — because losing this race costs the session's history, and only a
/// disk that has stopped answering should be able to lose it.
let kHistoryLoadTimeout: TimeInterval = 3.0

let kAutosaveDelay: TimeInterval = 1.0
let kWatchInterval: TimeInterval = 2.0
/// How long the app sits on a burst of kernel file-change events before it
/// looks. One event is one write() somebody made, so a document put down a
/// chunk at a time is a burst of them, and something rewriting a whole worktree
/// is one per open document — measured, 200 documents, 200 events. Each of
/// those turning into a pass over every tab, and a coordinated read of a file
/// still being written, is the shape this avoids. Short enough that a change
/// made while you watch appears at once rather than at the next poll, which is
/// the whole point of the watch.
let kWatchSettle: TimeInterval = 0.15
/// How long anything waits on a coordination before deciding it is not coming.
/// No read or write is bounded by this any more — they wait for the file
/// however long it takes, because going in without it is what costs somebody
/// their document. What is still bounded by it is the two places where WE are
/// the ones somebody is waiting on: a presenter's completion handler must run
/// or the other process waits forever, so a watchdog answers it if the app
/// cannot; and insureSlowSave, which puts the text somewhere safe when a save
/// of ours has been out this long.
let kCoordinationTimeout: TimeInterval = 2.0
/// How long a document may take to open before the writer is told why it has
/// not appeared. Reads are unbounded now, so the answer to a wedged sync daemon
/// is no longer a stale tab — it is a tab that arrives late — and a wait nobody
/// explains is the one thing that would read as a hang. Longer than any local
/// disk needs, short enough to be an answer rather than an epitaph.
let kSlowOpenNotice: TimeInterval = 0.6
/// Consecutive autosave failures before the status bar says so. One is noise —
/// a sync client holding the file for a moment, a volume waking up. Three in a
/// row, at a second apart, is a file that has stopped being written.
let kSaveFailuresBeforeSaying = 3
/// How many separate looks have to find nothing at an open document's path
/// before the app says the document has gone, and the shortest run of absence
/// those looks may stand for. Both, because two looks can land in the same
/// instant — the poll and a presenter's notification arriving together — and
/// two looks inside one replace window are really one look. See noteMissing for
/// where the numbers come from; they are measured, not chosen.
let kLooksBeforeGone = 2
let kAbsentBeforeGone: TimeInterval = 0.25
/// How long after a presenter is told its document is being deleted the app
/// waits before looking to see whether it was. Long enough for the deletion to
/// have happened, short enough that a document that really has gone is called
/// gone within half a second rather than at the next poll. It has to look at
/// all because that callback does not mean what it says: see documentDeleted.
let kFirstLookAfterDeletion: TimeInterval = 0.15
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
                 "zen", "focus", "focusLevel", "typewriter", "styleCheck", "mode", "scroll",
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

// ============================================================================
// Unsaved buffers
//
// An Untitled document has no path, so until the first ⌘S everything typed
// into it lives in one WKWebView's memory and nowhere else. A normal quit
// asks. A crash, a force quit, a power cut, a WebKit process crash: silent,
// and total. Tabs made that worse rather than better, because several
// untitled documents at once is one ⌘T away.
//
// So an untitled buffer gets a file of its own in
// ~/Library/Application Support/minimark/unsaved/, written on the same one
// second debounce as every other autosave and named by an id the tab carries
// for its whole life. Nothing here is a document the writer owns: these are
// crash insurance, deleted the moment the buffer becomes a real file or the
// writer says they do not want it. What is left in the folder at launch is,
// by definition, what did not get that far — so that is what is offered back.
//
// The id is a UUID rather than the tab number, which is only unique within a
// run: two launches both writing "2.md" would have the second overwrite the
// first crash's work with its own.
// ============================================================================
enum Scratch {
    static var dir: URL? {
        guard let base = Templates.dir else { return nil }
        let dir = base.appendingPathComponent("unsaved", isDirectory: true)
        let fm = FileManager.default
        if !fm.fileExists(atPath: dir.path) {
            try? fm.createDirectory(at: dir, withIntermediateDirectories: true)
        }
        return dir
    }

    static func url(_ id: String) -> URL? {
        // The id is ours, but it reaches this from a preference, which is a
        // file anybody can edit. A "../../" in there would make this write
        // wherever it pointed.
        guard isID(id) else { return nil }
        return dir?.appendingPathComponent(id + ".md")
    }

    /// UUID shaped, and nothing else. Deliberately stricter than "no slashes":
    /// this names a file the app writes to unprompted.
    static func isID(_ id: String) -> Bool {
        guard id.count == 36 else { return false }
        return UUID(uuidString: id) != nil
    }

    @discardableResult
    static func write(_ text: String, id: String) -> Bool {
        guard let url = url(id) else { return false }
        return (try? text.write(to: url, atomically: true, encoding: .utf8)) != nil
    }

    static func read(_ id: String) -> String? {
        guard let url = url(id),
              let data = try? Data(contentsOf: url), !data.isEmpty,
              let text = String(data: data, encoding: .utf8) else { return nil }
        return text
    }

    static func remove(_ id: String) {
        guard let url = url(id) else { return }
        try? FileManager.default.removeItem(at: url)
    }

    /// Every buffer still on disk, newest last, so a restore that has to stop
    /// at kMaxRestoredTabs keeps the ones most recently written.
    static func all() -> [String] {
        guard let dir = dir,
              let names = try? FileManager.default.contentsOfDirectory(
                  at: dir, includingPropertiesForKeys: [.contentModificationDateKey])
        else { return [] }
        return names
            .filter { $0.pathExtension == "md" && isID($0.deletingPathExtension().lastPathComponent) }
            .sorted { a, b in
                let da = (try? a.resourceValues(forKeys: [.contentModificationDateKey]))?.contentModificationDate ?? .distantPast
                let db = (try? b.resourceValues(forKeys: [.contentModificationDateKey]))?.contentModificationDate ?? .distantPast
                return da < db
            }
            .map { $0.deletingPathExtension().lastPathComponent }
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
/// documents are not in here, because a path is all this key can hold — they
/// travel in kOpenTabsKey instead. Both are still written, so a downgrade to
/// an older build, or to a single-document one, finds something it understands
/// rather than nothing; kLastDocKey is written alongside for the same reason.
let kOpenDocsKey = "openDocumentPaths"
let kActiveDocKey = "activeDocumentIndex"

/// The whole strip, in order, including the untitled buffers that kOpenDocsKey
/// cannot describe. Each entry is one of:
///
///     f:<path>            a document on disk
///     s:<uuid>            an unsaved buffer in ~/…/minimark/unsaved/
///
/// A tagged string rather than a dictionary because UserDefaults round-trips
/// [String] without ceremony, and because an older build reading this key by
/// accident gets something it will fail to open rather than something it will
/// half-understand.
let kOpenTabsKey = "openTabs"
let kActiveTabKey = "activeTabIndex"

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

/// What one look at a file records, and what the next look is compared
/// against.
///
/// A modification date used to be the whole of it, and a modification date is
/// not as sharp as it looks. Measured, on volumes a folder of markdown really
/// lives on: APFS and exFAT stamp it to the nanosecond, but HFS+ and MS-DOS
/// stamp it to the whole second — 40 out of 40 back-to-back rewrites of one
/// file left the date byte-for-byte identical on both. So on an external drive
/// or a USB stick, any outside write landing in the same second as the last
/// look is invisible to a date comparison, whatever it did to the file. 39 of
/// 40, with the two writes deliberately different lengths.
///
/// The size costs nothing — it comes out of the same stat — and it is the one
/// other thing a rewrite nearly always moves. It is not a hash and does not
/// pretend to be: a same-length rewrite inside one second still gets past both
/// of these, which is what the kernel watch beside the poll is for.
///
/// The inode is deliberately not here, and that is a judgement rather than an
/// oversight. It would also catch an atomic replace that restored the old
/// timestamp — but a volume that does not keep inode numbers stable across
/// stats would then look like a file changing every two seconds, forever, and
/// turn every poll into a read of every open document. That is the cost round
/// four measured and removed. There is no such volume here to test against, so
/// it is left out rather than guessed at.
///
/// Coordinated.Stamp holds the same two fields and is not this. That one is
/// taken twice inside a single read, microseconds apart, to ask whether the
/// file moved while it was being read; this one is kept on a tab for as long as
/// the document is open, to ask whether it has changed since anyone last
/// looked. They exclude the inode for two different reasons — see the note on
/// Stamp — and either could want it back without the other. Kept apart on
/// purpose rather than shared and hoped over.
struct FileMark: Equatable {
    let modified: Date
    let size: Int64
}

func fileMark(_ url: URL) -> FileMark? {
    guard let a = try? FileManager.default.attributesOfItem(atPath: url.path),
          let modified = a[.modificationDate] as? Date,
          let size = (a[.size] as? NSNumber)?.int64Value else { return nil }
    return FileMark(modified: modified, size: size)
}

/// Whether a path is inside a Trash — the home one, or a volume's.
///
/// Here because moving a document to the Trash is not a delete, it is a MOVE,
/// and that was worth measuring rather than assuming. FileManager.trashItem,
/// which is how it is done, reaches a presenter as
/// presentedItemDidMove(to: ~/.Trash/…) and never as
/// accommodatePresentedItemDeletion. A presenter that simply follows its
/// document wherever it goes therefore follows it into the Trash and keeps
/// autosaving there — the writer's work kept up to date in the one folder on
/// the machine that exists to be emptied, and the file they meant to delete
/// quietly refusing to stay deleted.
///
/// By component rather than by comparing against
/// FileManager.urls(for: .trashDirectory): there is one of those per volume,
/// an external disk's is .Trashes/<uid> rather than .Trash, and a network
/// volume may have neither at a path this process can resolve.
func isInTrash(_ url: URL) -> Bool {
    url.standardizedFileURL.pathComponents.contains { $0 == ".Trash" || $0 == ".Trashes" }
}

/// Whether a run of looks that found nothing at an open document's path has
/// gone on long enough, over enough separate looks, to mean the document has
/// gone rather than that a stat lost a race.
///
/// A function of its own rather than three lines inside the poll, because it is
/// the one judgement in this file that is wrong in both directions: too eager
/// and the app stops saving a file that is perfectly fine, too slow and the
/// writing goes nowhere while the status bar says "saved 4m ago". Here it can
/// be driven with dates instead of with a filesystem. Where the numbers come
/// from is in noteMissing, which is the only thing that calls it.
func goneForGood(looks: Int, since: Date?, now: Date = Date()) -> Bool {
    guard let since = since else { return false }
    return looks >= kLooksBeforeGone && now.timeIntervalSince(since) >= kAbsentBeforeGone
}

// ============================================================================
// File coordination
//
// The likely home for a folder of markdown is iCloud Drive, Dropbox, or a git
// worktree, which makes "something else is writing this file right now" the
// default deployment rather than an edge case. Reading a file mid-sync gives
// back half a document; writing into one gives the sync client half a document
// to upload, and it is the half that wins.
//
// NSFileCoordinator is how processes on a Mac take turns. A coordinated write
// makes every other coordinated reader and writer stand back until it is done,
// and a coordinated read waits for any writer already in progress. iCloud and
// Dropbox both coordinate. git, vim, sed and rsync do not, which is why the
// mtime poll in checkFileOnDisk stays: coordination is how we take turns with
// the ones that play, and the poll is how we notice the ones that do not.
//
// The poll is not the whole of that any more, because a mark taken from stat
// has a shape of change it cannot see however carefully it is compared: a
// writer that rewrites the bytes in place and puts the timestamp back. There is
// a kevent on a descriptor beside the poll for exactly that one thing — see
// DocWatch, which is also where the reasons for every event it does and does
// not ask for are written down. It is a third way of hearing, not a
// replacement: the poll needs nothing but stat and covers the volumes the
// kernel watch gets nothing from.
//
// A coordinated READ used to be bounded here, on the argument that a wedged
// sync daemon must not be able to hang the app on opening a document, and that
// giving up on a read destroys nothing because the worst it can see is a file
// mid-write, which the decoder already has to survive. Both halves were wrong,
// and the second one was wrong in the way that costs a document.
//
// The decoder survives a file mid-write, in the sense that it does not crash:
// half a UTF-8 file is still valid UTF-8 up to the cut. What it hands back is
// half a document, with nothing anywhere saying so, and half a document read
// into a tab is half a document the autosave writes back a second later.
// Measured, against a holder rewriting a 401-line file in place under a proper
// coordinated write: the wait timed out, the fallback read uncoordinated, and
// 240 lines came back as the whole file — after freezing main for 2004ms to get
// them, because readTextFile is reached from opening a document and from the
// poll, both on main.
//
// So the read waits like everything else here, and the answer arrives at the
// caller rather than the caller waiting for it. Nothing is bounded, so there is
// no fallback, so there is nothing left to hand back half a file.
//
// That closes the readers that coordinate. It does nothing about the ones that
// do not — git, vim, sed, rsync — and those write in place, which is the one
// shape that can be read torn. Coordination cannot help there because they are
// not in it, so the read checks instead: the file's size and modification date
// are taken either side of the read, and a file that moved under it is read
// again, and one that will not settle is refused rather than guessed at. A
// refused read costs a tab that opens a moment later; a guessed one costs the
// half of the document nobody has a copy of. See settled(_:) for what that
// check can and cannot see.
//
// A WRITE is a different animal, and this is where this code used to be wrong.
// It waited the same two seconds and then wrote anyway, over a process that was
// still holding the file. That process got no error, believed it had succeeded,
// and released to find its bytes gone. Measured, in a reproduction: 2098ms of
// frozen main thread — ⌘S and the presenter flush both come through here — and
// then somebody else's afternoon destroyed.
//
// So a write no longer waits on a thread at all. It goes through the
// asynchronous side of NSFileCoordinator: nothing blocks, so there is nothing
// to time out, so there is no fallback left to get wrong. A contended save
// simply lands later — after the other writer, never over them.
//
// The worry that produced the old fallback is still real, and it is answered
// rather than dismissed: "losing coordination is a bad afternoon; losing the
// page you just typed is not recoverable". A write that has not come back
// leaves the writing in one WKWebView and nowhere else. The answer to that is
// not to barge in, it is insurance — see insureSlowSave, which puts the text in
// the same crash-insurance buffer an untitled document uses and says so in the
// status bar. Neither writer's text is destroyed, and neither is dropped.
//
// A RENAME was the last thing here still on the bounded wait, kept there on the
// argument that its fallback could only fail: moveItem refuses a destination
// that already exists, so an uncoordinated move cannot land on top of another
// writer. That argument was wrong about which end of a move is at risk.
// moveItem refuses an existing DESTINATION; nothing in it protects the SOURCE,
// and the source is the file somebody else is holding. Measured: the wait timed
// out, the rename took a held file out from under its holder, and this app's own
// write — still queued on the old name, because writes wait and renames did not
// — then recreated the name the rename had just emptied. Two files, and the
// newest text in the one nobody is looking at.
//
// So the rename waits too, and the waiting is exactly what buys the ordering.
// The coordinator grants the two in the order they were asked for and announces
// the move to whatever is still pending, so a write issued on either side of a
// rename ends up in the one file at the new name. Measured both ways round.
//
// Nothing here is on a bounded wait any more, and nothing here has a fallback.
//
// The last thing wrong here was quieter than any of that: the app had no idea
// its file could stop existing. A write refused because the document had been
// moved out from under it protected only the write already in flight; the NEXT
// one was issued fresh at a path nothing was at, saw nothing to protect, and
// recreated the name the document had left. The fix was not a better stat. What
// the disk cannot answer is which of two things a write to an empty path is —
// a Save As making a file, or a save aimed at a document that has gone — and
// the caller has always known. So it says: see Intent below.
//
// A note on what the presenter machinery actually hears, because the comment
// that used to sit here was wrong about it. "Presenters hear about coordinated
// operations only" is not true. Measured, with a presenter on the file and
// nothing else registered: a bare `mv` — no coordination anywhere, the case
// git, vim and rsync are — arrives as presentedItemDidMove(to:) about 1.07
// SECONDS later, carrying the destination, whether the file moved within its
// folder, to another folder, or because its whole folder was renamed. The
// coordination daemon watches presented items itself and synthesises the move.
// So a bare rename is followed, not lost; the hole it leaves is the second
// before the news arrives, which is exactly long enough for one autosave tick,
// and that tick is what Intent stops. A bare `rm` is the one thing nothing
// reports at all — measured, no callback of any kind — and that one is the
// poll's, in checkFileOnDisk.
// ============================================================================

enum Coordinated {

    /// What a write is for, which is the only thing that can separate "the
    /// document this belongs to has gone" from "this write is what makes the
    /// file". On disk those are the same thing — a path with nothing at it —
    /// and no amount of statting will tell them apart. The caller knows.
    enum Intent {
        /// May make the file: Save As, a wikilink making the note it points
        /// at, the first save of a document that has never had a path.
        case create
        /// A save of a document that is already on disk. Nothing at the path
        /// when the claim is granted means the document is not there any more,
        /// and writing would recreate the name it left rather than save it.
        case update
    }

    /// Where a coordinated write's body runs once the file is really ours.
    ///
    /// One queue for the app rather than one per call, because the queue has to
    /// outlive the call that made it and a coordination can now stay pending
    /// for as long as the other writer likes. Four at a time: enough that one
    /// slow volume cannot hold up another document's save, few enough that a
    /// strip of tabs all saving at once cannot become a thread each.
    private static let writeQueue: OperationQueue = {
        let q = OperationQueue()
        q.maxConcurrentOperationCount = 4
        q.qualityOfService = .userInitiated
        q.name = "minimark.coordinated-write"
        return q
    }()

    /// A coordinated write. Asynchronous, unbounded, and it never goes in
    /// without the claim.
    ///
    /// `body` runs at most once, off main, with the file genuinely held — the
    /// claim is not given up until it returns. `then` runs on main afterwards,
    /// on every path, with whatever the coordinator had to say: nil means the
    /// file was ours and `body` ran, an error means it never was and `body` did
    /// not run at all. Passing the `presenter` that owns this URL is what stops
    /// our own writes coming back to us as somebody else's change.
    ///
    /// There is deliberately no timeout here. Waiting longer costs a save that
    /// lands late, which the caller can insure against; going in without the
    /// claim costs somebody else their file, which nobody can insure against.
    ///
    /// Waiting that long is also long enough for the document to be renamed out
    /// from under the write, so where the bytes go is settled when the claim is
    /// granted rather than when the write was asked for. Two things do that.
    /// `access.url` is the coordinator's own answer: it follows an announced
    /// move, so a rename either side of this write lands it in the file at the
    /// new name. A move nothing announced cannot be followed here — the news of
    /// it arrives about a second later, through the presenter — and until it
    /// does, `intent` is what keeps this write off the name the document left.
    static func write(_ url: URL,
                      intent: Intent = .update,
                      presenter: NSFilePresenter? = nil,
                      _ body: @escaping (URL) -> Void,
                      then: @escaping (Error?) -> Void) {
        let coordinator = NSFileCoordinator(filePresenter: presenter)
        // .forReplacing because every write here is atomic: the write lands on
        // a temporary file and swaps it in, so the file the coordinator is told
        // about is replaced rather than edited.
        let access = NSFileAccessIntent.writingIntent(with: url, options: .forReplacing)
        coordinator.coordinate(with: [access], queue: writeQueue) { error in
            if let error = error {
                DispatchQueue.main.async { then(error) }
                return
            }
            // A save with nothing at the path to save into. Writing would not
            // save the document, it would recreate the name the document left —
            // and leave the writer with two files and their newest sentence in
            // the one they are not looking at. Nothing here says where it went,
            // so there is nowhere to redirect to: the write is abandoned and
            // the caller is told, which leaves the document dirty and its text
            // where it already was.
            //
            // The round before this asked the disk instead — was there a file
            // here when the write was issued? — which answers only for a
            // document that vanished while this particular write waited. It
            // says nothing about the next write, issued fresh at a path that is
            // already empty, and that one recreated the name. What is being
            // asked was never a fact about the disk.
            guard intent == .create || FileManager.default.fileExists(atPath: access.url.path) else {
                DispatchQueue.main.async { then(vanished(url)) }
                return
            }
            body(access.url)
            DispatchQueue.main.async { then(nil) }
        }
    }

    /// What there is to say when there is no document at a path any more.
    /// Phrased for a person, because it reaches one: the status bar, and a
    /// toast on the way past. One sentence in one place — the write says it
    /// when a save is refused, and the poll says it when the poll is what
    /// noticed.
    static func gone(_ url: URL) -> String {
        "“\(url.lastPathComponent)” is not there any more. It was moved or deleted while it "
        + "was open here, so nothing is being written to that name."
    }

    /// And what there is to say when a file would not hold still long enough
    /// to be read whole. Also phrased for a person: this one reaches a sheet
    /// when they asked for the document, and a line in passing when they did
    /// not. It says what is happening rather than that something failed,
    /// because nothing has — the document is fine and somebody else is in the
    /// middle of writing it.
    static func busy(_ url: URL) -> String {
        "“\(url.lastPathComponent)” is being written by something else right now. It was not "
        + "opened, because what is in the file at this moment is only part of it."
    }

    private static let domain = "minimark.coordination"

    private static func vanished(_ url: URL) -> NSError {
        NSError(domain: domain, code: 1, userInfo: [NSLocalizedDescriptionKey: gone(url)])
    }

    private static func unsettled(_ url: URL) -> NSError {
        NSError(domain: domain, code: 2, userInfo: [NSLocalizedDescriptionKey: busy(url)])
    }

    /// Whether a write came back refused because there was no document at the
    /// path, rather than because the filesystem said no. The app does something
    /// quite different about the two, and matching on the sentence would break
    /// the first time the sentence was reworded.
    static func isGone(_ error: Error) -> Bool {
        let e = error as NSError
        return e.domain == domain && e.code == 1
    }

    /// Where a coordinated read's body runs. Its own queue rather than the
    /// write one, so that a strip of documents opening cannot be stuck behind
    /// four saves waiting on a slow volume, and so that a read pausing to let a
    /// file settle is not holding a slot a save needs.
    private static let readQueue: OperationQueue = {
        let q = OperationQueue()
        q.maxConcurrentOperationCount = 4
        q.qualityOfService = .userInitiated
        q.name = "minimark.coordinated-read"
        return q
    }()

    /// How many times a read will start over because the file moved under it,
    /// how long a file has to have been left alone before a read of it is
    /// believed, and how often that is checked. See stamp(_:) and still(_:_:)
    /// for what the numbers are actually buying.
    private static let settleAttempts = 3
    private static let settleQuiet: TimeInterval = 0.25
    private static let settlePause: TimeInterval = 0.05

    /// Enough of a file to tell whether it changed while it was being read.
    ///
    /// Size and modification date, and deliberately not the inode. An atomic
    /// replace — every save this app makes, and every sane writer's — changes
    /// the inode and can never be read torn: the read opens a descriptor and
    /// keeps reading the file it opened, which is a whole document whichever
    /// side of the swap it came from. Counting that as a change would refuse
    /// perfectly good reads for no gain.
    ///
    /// What this does see is the shape that actually tears: a writer holding
    /// the file open and rewriting it in place, which moves both the size and
    /// the modification date under the read.
    private struct Stamp: Equatable {
        let size: Int64
        let modified: Date
    }

    private static func stamp(_ url: URL) -> Stamp? {
        guard let a = try? FileManager.default.attributesOfItem(atPath: url.path),
              let size = (a[.size] as? NSNumber)?.int64Value,
              let modified = a[.modificationDate] as? Date else { return nil }
        return Stamp(size: size, modified: modified)
    }

    /// Whether the file has been left alone long enough for what was just read
    /// out of it to be the whole of it.
    ///
    /// Two identical stats either side of a read are not enough, and this is
    /// the trap the obvious version of this check falls into. Reading 10KB
    /// takes microseconds; a writer putting a file down a chunk at a time
    /// pauses for milliseconds. The read fits inside one pause, both looks
    /// agree, and half a document comes back looking settled. So the question
    /// is not "did it change while I looked", it is "has anything touched this
    /// file recently at all" — and a file whose last write was longer ago than
    /// any writer's pause is a file nobody is in the middle of.
    ///
    /// A file already still by that measure costs nothing here, which is nearly
    /// every read: the file was last written minutes or months ago and this
    /// returns on the first test. Only one written moments ago is waited on,
    /// and only until it has been quiet — on the read queue, never on main.
    ///
    /// The honest limit: a writer that goes quiet for longer than this between
    /// chunks still gets through. Nothing on the reading side can see that one.
    /// The answer to it is the writer coordinating, which is what the whole
    /// block above is about; this is the backstop for the ones that do not.
    private static func still(_ url: URL, _ mark: Stamp?) -> Bool {
        // Nothing at the path is a stable answer, not a file in mid-flight.
        guard let mark = mark else { return true }
        var waited: TimeInterval = 0
        // Bounded by the wait as well as by the clock, because a file on a
        // volume whose clock is ahead of ours has a modification date in the
        // future and would otherwise be waited on until the future arrived.
        while waited < settleQuiet, Date().timeIntervalSince(mark.modified) < settleQuiet {
            Thread.sleep(forTimeInterval: settlePause)
            waited += settlePause
            guard stamp(url) == mark else { return false }
        }
        return true
    }

    /// A coordinated read. Asynchronous and unbounded, like everything else
    /// here, and it never hands back half a file.
    ///
    /// `body` runs off main with the file held, and whatever it returns is the
    /// document. `then` runs on main afterwards, on every path, with one of
    /// three answers: a value, meaning the file was ours and settled and this
    /// is what was in it; nil and no error, meaning the read was clean and
    /// there was nothing in it to have — no file at the path, or one the caller
    /// could make nothing of; nil and an error, meaning the file could not be
    /// read whole. Nothing is handed back in that last case on purpose. A
    /// caller given a partial document has no way to know it is partial, and
    /// the next autosave writes it back over the whole one.
    ///
    /// `body` may run more than once, which is safe because it only reads: a
    /// file that moved under it is read again from the top rather than stitched
    /// together out of two looks.
    static func read<T>(_ url: URL,
                        presenter: NSFilePresenter? = nil,
                        _ body: @escaping (URL) -> T?,
                        then: @escaping (T?, Error?) -> Void) {
        let coordinator = NSFileCoordinator(filePresenter: presenter)
        let access = NSFileAccessIntent.readingIntent(with: url, options: [])
        coordinator.coordinate(with: [access], queue: readQueue) { error in
            if let error = error {
                DispatchQueue.main.async { then(nil, error) }
                return
            }
            for attempt in 0..<settleAttempts {
                if attempt > 0 { Thread.sleep(forTimeInterval: settlePause) }
                let before = stamp(access.url)
                let value = body(access.url)
                // Both nil is a stable answer too: nothing was there before the
                // read and nothing after, which is a path with no file at it
                // rather than a file being written.
                guard stamp(access.url) == before, still(access.url, before) else { continue }
                DispatchQueue.main.async { then(value, nil) }
                return
            }
            DispatchQueue.main.async { then(nil, unsettled(url)) }
        }
    }

    /// A rename, which is two files and therefore two coordinations taken
    /// together. Splitting them would leave a window where the old name is
    /// released and the new one is not yet held, which is the window a sync
    /// client uses to put the old file back.
    ///
    /// Unbounded and asynchronous, for the same reason the write is and for one
    /// more of its own: see the note above about which end of a move the old
    /// bounded wait failed to protect. `body` returns what went wrong, or nil,
    /// and the move is only announced when it actually happened. `then` runs on
    /// main on every path.
    static func move(from: URL, to: URL,
                     presenter: NSFilePresenter? = nil,
                     _ body: @escaping (URL, URL) -> Error?,
                     then: @escaping (Error?) -> Void) {
        let coordinator = NSFileCoordinator(filePresenter: presenter)
        let source = NSFileAccessIntent.writingIntent(with: from, options: .forMoving)
        let dest = NSFileAccessIntent.writingIntent(with: to, options: .forReplacing)
        coordinator.coordinate(with: [source, dest], queue: writeQueue) { error in
            if let error = error {
                DispatchQueue.main.async { then(error) }
                return
            }
            if let failed = body(source.url, dest.url) {
                DispatchQueue.main.async { then(failed) }
                return
            }
            // Tells the coordinator the item at `from` is now at `to`, so any
            // presenter watching the old path is moved to the new one rather
            // than being left pointed at a file that is gone — and so is any
            // write of ours still queued behind this on the old name, which is
            // how the newest text follows the document instead of recreating
            // the name it left.
            coordinator.item(at: source.url, didMoveTo: dest.url)
            DispatchQueue.main.async { then(nil) }
        }
    }
}

// ============================================================================
// One per open document, for as long as it has a path.
//
// Registering makes this app a participant rather than an observer: other
// coordinated writers now wait for us, ask us to flush what we have not saved
// before they read, and tell us the moment they have finished. `didChange`
// arrives on a sync client's write immediately, where the poll would take up
// to kWatchInterval to notice and could read the file halfway through.
//
// The queue is deliberately not the main one. Coordination messages presenters
// on this queue while the thread that started it waits, and pointing it at main
// while a coordinated write is running on main is the one arrangement that
// deadlocks. Every callback here hops to main with `async` for the same reason:
// nothing on this queue may ever wait on main.
// ============================================================================

final class DocPresenter: NSObject, NSFilePresenter {
    private let lock = NSLock()
    private var url: URL
    private let queue: OperationQueue

    /// Weak, and every callback re-checks it: a presenter can be messaged
    /// after the tab it belongs to has gone.
    weak var owner: AppDelegate?

    init(url: URL, owner: AppDelegate) {
        self.url = url
        self.owner = owner
        self.queue = OperationQueue()
        self.queue.maxConcurrentOperationCount = 1
        self.queue.qualityOfService = .userInitiated
        super.init()
    }

    var currentURL: URL {
        lock.lock(); defer { lock.unlock() }
        return url
    }

    // Read from arbitrary threads by the coordination machinery, so it goes
    // through the lock like everything else that touches `url`.
    var presentedItemURL: URL? { currentURL }
    var presentedItemOperationQueue: OperationQueue { queue }

    func presentedItemDidChange() {
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            // Straight into the poll's own logic rather than a second copy of
            // it. checkFileOnDisk is guarded by the recorded modification date,
            // so arriving here for a write we made ourselves costs a stat and
            // nothing else, and every decision about what to do with an outside
            // change — reload quietly, or ask — stays in one place.
            self.owner?.checkFileOnDisk()
        }
    }

    /// Dropbox resolving a conflict, iCloud evicting and restoring, a `git
    /// checkout` that renames into place: the document is still open and its
    /// path is now somewhere else. Following it keeps saving pointed at the
    /// file the writer is looking at.
    func presentedItemDidMove(to newURL: URL) {
        lock.lock()
        url = newURL
        lock.unlock()
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            self.owner?.documentMoved(self, to: newURL)
        }
    }

    /// Somebody is about to read or write this file and is asking us to put
    /// what we have on disk first. This is the call that stops conflicts being
    /// created rather than resolving them afterwards: the sync client uploads
    /// the sentence just typed instead of the one before it.
    ///
    /// The completion handler must run, or the other writer waits forever, so
    /// it is guarded twice — once for the flush and once for a timeout.
    func savePresentedItemChanges(completionHandler: @escaping (Error?) -> Void) {
        let done = OnceHandler(completionHandler)
        DispatchQueue.main.async { [weak self] in
            guard let self = self, let owner = self.owner else { done.fire(); return }
            owner.flushForCoordination(self.currentURL) { done.fire() }
        }
        // Main may be busy, and a document that will not flush must not be able
        // to stall another process indefinitely.
        DispatchQueue.global(qos: .userInitiated)
            .asyncAfter(deadline: .now() + kCoordinationTimeout) { done.fire() }
    }

    /// Somebody is about to take this file away and is waiting on us to let go
    /// of it. Any coordinated delete arrives here — measured — which is what a
    /// process that removes a file properly takes, and it arrives before the
    /// file goes rather than up to a watch interval afterwards.
    ///
    /// It is worth being exact about what else arrives here and what does not,
    /// because every obvious guess about it turned out to be wrong and every
    /// one of them was measured.
    ///
    /// A coordinated write taken with `.forReplacing` arrives here too, before
    /// the write, indistinguishable from a deletion. That is not an edge case:
    /// it is what every atomic save declares, this app's own included, so this
    /// callback fires whenever another editor or a sync client saves the
    /// document. A coordinated write with no options does not. So the app may
    /// not treat arriving here as proof of anything — see documentDeleted,
    /// which looks at the path afterwards rather than believing this.
    ///
    /// A bare `rm` reaches no presenter callback of any kind, so that one is
    /// the poll's — which is why the poll has a case for this as well. And
    /// moving a document to the Trash is not a deletion at all: trashItem is a
    /// move, and it comes in as presentedItemDidMove pointing at ~/.Trash,
    /// which documentMoved has to refuse to follow.
    ///
    /// What must NOT happen here is a flush. savePresentedItemChanges writes
    /// what is unsaved because the other process is about to READ; this one is
    /// about to delete, and putting our text on disk first would be recreating
    /// the file underneath somebody taking it away — the same mistake as
    /// writing to a name a document has left, made politely.
    ///
    /// The completion handler must run or the deleting process waits forever,
    /// so it is guarded exactly like the flush above.
    ///
    /// accommodatePresentedItemEviction is deliberately not implemented beside
    /// this. Eviction is iCloud reclaiming local space, not a deletion: the
    /// document still exists, the path still answers — an evicted file on the
    /// systems this targets is a dataless file, still there to stat — and
    /// saying "your file has gone" about one would be a lie. The only duty an
    /// implementation would carry is running the completion handler, which is
    /// what the system does for us when the method is absent. The one thing it
    /// could add is refusing the eviction, by handing back an error, and a text
    /// editor overruling the user's own disk-space setting because it happens
    /// to have a document open is not this app's call to make.
    func accommodatePresentedItemDeletion(completionHandler: @escaping (Error?) -> Void) {
        let done = OnceHandler(completionHandler)
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { done.fire(); return }
            self.owner?.documentDeleted(self)
            done.fire()
        }
        DispatchQueue.global(qos: .userInitiated)
            .asyncAfter(deadline: .now() + kCoordinationTimeout) { done.fire() }
    }

    // relinquishPresentedItemToReader: and ToWriter: are deliberately not here,
    // and this is the one place a future reader will wonder why, so: they were
    // measured rather than argued about. The A/B was this class against itself,
    // one implementation, with the two selectors hidden from responds(to:) in
    // one arm — which is exactly how the runtime decides an optional protocol
    // method is absent, so nothing else differed.
    //
    // Across five kinds of outside operation, seven runs each, the process on
    // the other side waited the same: 4.2–10.5ms without them, 4.5–10.8ms with,
    // one distribution. Every other callback was identical — the same flush
    // before a reader, the same accommodation before a replace, the same
    // didChange, the same didMove. The reacquire block, the one thing they add
    // that carries information, fired 0.1ms after presentedItemDidChange, which
    // is a callback this class already implements. And the yield to a reader
    // arrives immediately before savePresentedItemChanges, which is the one
    // that actually does the work.
    //
    // The instrument was checked rather than trusted: an arm that sat on the
    // block for 400ms before yielding held the other process up for 413ms. So
    // the methods do have teeth, and the dead heat is a fact about this
    // presenter rather than a harness that was not measuring.
    //
    // Which leaves what they would actually be for. Their only power is to make
    // another process wait while we let go of something. This app holds nothing
    // outside a coordination to let go of, so the implementation could only be
    // "yield at once" — which is precisely what the system does for a presenter
    // that does not implement them. Adding them would buy nothing and put a new
    // way to hang another process into the file.

    // The NSFileVersion surface — presentedItemDidGainVersion:,
    // presentedItemDidLoseVersion: and presentedItemDidResolveConflictVersion:
    // — is not here either, and it was measured the same way.
    //
    // The obvious guess about it is wrong, so it is worth writing down: this is
    // not iCloud-only machinery. Every volume has a version store, and another
    // process adding a version of an ordinary file in an ordinary folder
    // reaches a presenter as presentedItemDidGainVersion about 30ms later,
    // whether or not it bothered to coordinate.
    //
    // What it does not do is mean anything to an editor with no version
    // browser. 105 runs, one presenter class against itself with the three
    // selectors hidden from responds(to:) in one arm: every cell came out
    // single-valued and every other callback was identical. Adding a version
    // fires didGainVersion and NOT presentedItemDidChange, because nothing
    // about the document changed — the bytes on disk are the same afterwards.
    // Removing versions fires didGain and didLose, same again. The one version
    // operation that does change the file, another process reverting it to an
    // older version, fires presentedItemDidChange too, which is the callback
    // above and is already wired into checkFileOnDisk. So everything that
    // changes the document is announced already, and everything these would add
    // leaves the document exactly as it was. That is the last section of
    // coordination-test.js, instrument and all.
    //
    // presentedItemDidLoseVersion: is worse than merely useless, and this is
    // the part to know before anyone adds it to match a symbol list. It is
    // handed an NSFileVersion whose storage has already gone, so its URL is nil
    // — while NSFileVersion.h declares that property nonnull and admits the nil
    // only in prose. Swift believes the annotation. The obvious one-line body
    // dies in URL._unconditionallyBridgeFromObjectiveC, on this queue, every
    // time. modificationDate is nil as well.
    //
    // presentedItemDidResolveConflictVersion: is only ever called about a
    // version whose isConflict is true, and nothing public makes one. Two
    // versions added from divergent contents: none. Two coordinated writers
    // racing for one file, one .forMerging and one .forReplacing: none. Setting
    // isResolved on a version that is not a conflict does not even take — false
    // before, false after — though the header says it is "simply YES". Conflict
    // versions come from the ubiquity daemon finding two devices that disagree,
    // and that cannot be staged on one machine.
    //
    // Which is the one thing here left genuinely open, and it is left open
    // rather than waved away. This app's documents CAN be iCloud files: the
    // machine this was measured on is signed in, and ~/Documents and ~/Desktop
    // both come back as ubiquitous items, so a folder of notes in either is
    // synced and can really conflict. What can be said without a second device
    // is what happens when it does — however iCloud settles a conflict it
    // settles it by changing the file, and a changed file is didChange, the
    // poll, and checkFileOnDisk, which reloads it or asks. What the callback
    // would add on top is showing the writer the versions that disagreed and
    // letting them pick. That is a feature, and a decent one, but it is not a
    // hole in the coordination and should not arrive disguised as one.
    //
    // primaryPresentedItemURL is a different thing and was judged separately.
    // NSFilePresenter.h introduces it under "Support for App Sandbox": it is
    // how a sandboxed app handed a movie gets at the subtitle file beside it.
    // This app is not sandboxed — it carries no entitlements at all — and it
    // has no subordinate item to declare. Every presenter here is one tab on
    // one document the writer chose, all peers, and openDocument brings forward
    // the tab that already has a file rather than registering a second
    // presenter on it. Measured anyway, 56 runs, a document and a sidecar with
    // a related name, the sidecar naming the document its primary in one arm
    // and hiding the method in the other: not one callback differed, on either
    // presenter, across a replace, a move and a delete of the primary and a
    // replace of the sidecar. The only thing that did differ is that the arm
    // implementing it sends the sandbox related-item machinery off to issue an
    // extension it cannot have, which fails and says so in the system log, once
    // per run. That is the whole return — nothing, plus a line of noise.
}

/// A completion handler that runs once however many times it is called. The
/// coordination callbacks all have a real path and a timeout racing to answer
/// them, and calling one of those handlers twice is a crash rather than a
/// warning.
final class OnceHandler {
    private let lock = NSLock()
    private var handler: ((Error?) -> Void)?
    init(_ handler: @escaping (Error?) -> Void) { self.handler = handler }
    func fire(_ error: Error? = nil) {
        lock.lock()
        let h = handler
        handler = nil
        lock.unlock()
        h?(error)
    }
}

// ============================================================================
// The kernel's own answer, one per open document.
//
// The poll compares a mark taken from stat, and there is a shape of change no
// mark taken from stat can see: a writer that rewrites the bytes through the
// file's own inode and leaves the timestamp where it was. Different bytes under
// an open document with the modification date, the size and the inode all
// exactly as they were. Reproduced, scratchpad/watchtest. The tab then shows
// stale text for as long as it is open, and the moment the writer types, the
// autosave puts the stale text back over whatever landed.
//
// Two things produce it, and the obvious guess about the first was measured and
// was wrong. `cp -p` does NOT leave the destination's old timestamp: it stamps
// the SOURCE's onto it, so it usually moves the mark and the poll sees it. What
// really carries an unchanged timestamp is a tool that snapshots the times
// around an in-place edit and puts them back — `touch -r` and everything shaped
// like it, some formatters, some restores.
//
// The second is not exotic at all, and it is the reason this earns its place.
// Measured: HFS+ and MS-DOS volumes stamp the modification date to the WHOLE
// SECOND — 40 of 40 back-to-back rewrites of one file left the date byte for
// byte identical — so on an external drive, a Time Machine volume or a USB
// stick, any outside write landing in the same second as the last look is
// invisible to a date comparison whatever it did to the file. 39 of 40 with the
// two writes deliberately different lengths.
//
// Hashing every open document on the poll's timer would find it. It would also
// be a read of every open document every two seconds to catch something rare,
// which is most of what round four went to the trouble of removing. So this is
// a kevent on a descriptor instead: the kernel says when a file was written and
// says nothing at all the rest of the time. Measured, 50 armed watches over
// five idle seconds: 0 wakeups, and 1 wakeup when exactly one of the 50 was
// written.
//
// WHICH EVENTS MEAN WHAT was measured rather than assumed, because the whole
// value of this depends on it:
//
//   .write / .extend   somebody wrote through the inode this descriptor holds.
//                      That is an IN-PLACE write, and it is the one shape that
//                      can carry an unchanged timestamp. Measured: `cp -p`,
//                      `dd conv=notrunc`, a shell append and an mmap write all
//                      arrive this way — and THIS APP'S OWN SAVE NEVER DOES.
//                      Every save here goes through replaceContents, which
//                      stages beside the file and swaps it in, so our bytes
//                      never travel through the watched inode. That is what
//                      makes this signal safe to act on without a flag saying
//                      "not us": it cannot be us. Measured both ways round.
//
//   .delete / .rename  the descriptor is now on a file the path no longer
//                      names. EVERY atomic replace does this, ours included —
//                      measured, our own save arrives here as delete, and the
//                      save after it arrives as nothing at all because the
//                      watch was left on an unreachable file. So this means
//                      re-arm on the path, and it means nothing else. Treating
//                      it as a content change would make every one of our own
//                      saves look like somebody else's.
//
//   .revoke            the volume went. Same answer: try the path again.
//
//   .attrib            deliberately not asked for. It fires for a Finder tag,
//                      for chmod, and — measured — for the timestamp restore
//                      itself, none of which change a byte of the document;
//                      round one's xattr carry-over means our own saves would
//                      be in that traffic too. The one content change that
//                      reports .attrib and nothing else is ftruncate, and that
//                      moves both the size and the modification date, which is
//                      exactly what the poll compares. So asking for it would
//                      buy nothing and cost 18 wakeups per `cp -p`.
//
// This does not replace the poll and must not be allowed to. A vnode source
// needs a descriptor on a real file: network mounts and virtual filesystems
// give nothing here, and a document that vanishes leaves nothing to re-arm on.
// The poll is what covers those, and it is also the backstop that re-arms this
// when a replace left the path momentarily empty.
// ============================================================================

final class DocWatch {
    /// One serial queue for every watch in the app rather than one each. The
    /// handler does nothing but hop to main or re-open a path, so a strip of
    /// twenty documents is still one thread.
    ///
    /// .userInitiated, the same as the presenter's queue, and not because the
    /// work is heavy — it is a hop to main. A stir is the only way the app ever
    /// hears about a rewrite that kept its timestamp: the poll cannot see that
    /// one at all, so a starved watch is not a late reload, it is no reload.
    private static let queue = DispatchQueue(label: "minimark.file-watch",
                                             qos: .userInitiated)

    private let lock = NSLock()
    private let url: URL
    private var source: DispatchSourceFileSystemObject?
    private var stopped = false
    private var rearmPending = false
    /// One look back after a failed re-arm, and no more. Reset every time the
    /// watch actually gets a descriptor, so each replace gets its own. Without
    /// a budget this becomes an open() every kWatchSettle, forever, for a
    /// document that has simply been deleted.
    private var retryLeft = 1

    /// Runs on the watch queue when this document's bytes were rewritten in
    /// place. Whatever it does about that has to hop to main itself.
    private let stirred: () -> Void

    init(url: URL, stirred: @escaping () -> Void) {
        self.url = url
        self.stirred = stirred
        // Claimed before the hop, so a poll landing in the moment between this
        // and the descriptor existing does not arm a second one over it.
        rearmPending = true
        Self.queue.async { [weak self] in self?.arm() }
    }

    deinit { source?.cancel() }

    /// The path this watch was made for. What syncWatches compares against to
    /// decide whether a tab still has the right one.
    var watching: URL { url }

    /// Re-open the path if the watch is not on anything. Cheap when it is —
    /// a lock and a branch — and it is only ever called from the poll, on a
    /// tab whose file the poll has just seen, so a document that has really
    /// gone costs nothing here.
    func ensureArmed() {
        lock.lock()
        let idle = !stopped && source == nil && !rearmPending
        lock.unlock()
        guard idle else { return }
        Self.queue.async { [weak self] in self?.arm() }
    }

    /// Let the descriptor go. Called when the tab closes, when the document is
    /// re-pointed at another path, and at quit — a descriptor left open on a
    /// document nobody has open is the same leak as a presenter left
    /// registered, and this app has had one of those.
    func stop() {
        lock.lock()
        stopped = true
        let s = source
        source = nil
        lock.unlock()
        s?.cancel()
    }

    private func arm() {
        lock.lock()
        rearmPending = false
        let done = stopped
        let old = source
        source = nil
        lock.unlock()
        old?.cancel()
        guard !done else { return }

        // O_EVTONLY: a descriptor for being told about the file, which does not
        // count as having it open — it does not stop the volume unmounting.
        let fd = open(url.path, O_EVTONLY)
        guard fd >= 0 else {
            // Nothing at the path this instant. Usually the middle of somebody
            // else's atomic replace, which is over in well under a millisecond,
            // so it is worth one look back; after that it is the poll's, and
            // the poll only asks when it can see a file there.
            retryOnce()
            return
        }
        let s = DispatchSource.makeFileSystemObjectSource(
            fileDescriptor: fd,
            eventMask: [.write, .extend, .delete, .rename, .revoke],
            queue: Self.queue)
        s.setEventHandler { [weak self] in
            guard let self = self else { return }
            let events = s.data
            if events.contains(.write) || events.contains(.extend) { self.stirred() }
            if events.contains(.delete) || events.contains(.rename)
                || events.contains(.revoke) { self.arm() }
        }
        s.setCancelHandler { close(fd) }
        lock.lock()
        // Stopped while the descriptor was being opened. Handing it to a source
        // now would leave it open for good.
        if stopped { lock.unlock(); close(fd); return }
        source = s
        retryLeft = 1
        lock.unlock()
        s.resume()
    }

    private func retryOnce() {
        lock.lock()
        guard !stopped, !rearmPending, retryLeft > 0 else { lock.unlock(); return }
        retryLeft -= 1
        rearmPending = true
        lock.unlock()
        Self.queue.asyncAfter(deadline: .now() + kWatchSettle) { [weak self] in
            self?.arm()
        }
    }
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
    /// The app's own formatting items, built fresh each time the menu opens.
    /// Only asked for where WebKit thinks the click landed in editable text.
    var contextExtras: (() -> [NSMenuItem])?

    // ------------------------------------------------------------------
    // Context menu
    //
    // A right-click in a writing app should not offer Reload, Services and
    // Inspect Element. That menu is WebKit's, built for a browser, and it is
    // the loudest "there is a web view under here" tell in the product.
    //
    // Removing by identifier rather than keeping by it, on purpose. The
    // spelling corrections at the top of the menu carry no identifier at all —
    // they are built per click from what the checker found — so an allow-list
    // would silently throw away the one part of this menu a writer needs most.
    // A deny-list also fails in the safe direction: a WebKit release that adds
    // an item nobody here has heard of leaves it on screen rather than removing
    // something that turns out to matter.
    // ------------------------------------------------------------------

    /// Browser furniture. Everything here either navigates away from the
    /// document, saves something off the internet, or opens the inspector.
    private static let unwantedMenuItems: Set<String> = [
        "WKMenuItemIdentifierReload",
        "WKMenuItemIdentifierGoBack",
        "WKMenuItemIdentifierGoForward",
        "WKMenuItemIdentifierInspectElement",
        "WKMenuItemIdentifierOpenFrameInNewWindow",
        "WKMenuItemIdentifierOpenImageInNewWindow",
        "WKMenuItemIdentifierOpenLinkInNewWindow",
        "WKMenuItemIdentifierOpenMediaInNewWindow",
        "WKMenuItemIdentifierDownloadImage",
        "WKMenuItemIdentifierDownloadLinkedFile",
        "WKMenuItemIdentifierDownloadMedia",
        "WKMenuItemIdentifierToggleFullScreen",
        "WKMenuItemIdentifierToggleEnhancedFullScreen",
        "WKMenuItemIdentifierShowHideMediaControls"
    ]

    override func willOpenMenu(_ menu: NSMenu, with event: NSEvent) {
        super.willOpenMenu(menu, with: event)

        // Cut and Paste are only in this menu when WebKit believes the click
        // landed in something editable. That is a better answer than anything
        // this side could work out — it knows which element is under the
        // pointer, and willOpenMenu cannot wait on a round trip to ask.
        var editable = false

        for item in menu.items.reversed() {
            if let id = item.identifier?.rawValue {
                if id == "WKMenuItemIdentifierPaste" { editable = true }
                if EditorWebView.unwantedMenuItems.contains(id) {
                    menu.removeItem(item)
                    continue
                }
            }
            // The Services submenu carries no identifier, but it is always the
            // one AppKit hands out, so it can be recognised by identity rather
            // than by its title — which is localised, and would make this work
            // in English and nowhere else.
            if let sub = item.submenu, sub === NSApp.servicesMenu {
                menu.removeItem(item)
            }
        }

        if editable, let extras = contextExtras?(), !extras.isEmpty {
            if menu.items.last?.isSeparatorItem == false { menu.addItem(.separator()) }
            for item in extras { menu.addItem(item) }
        }

        EditorWebView.tidySeparators(menu)
    }

    /// Removing items leaves the separators that were dividing them, which
    /// reads as a menu with holes in it. Runs collapse to one, and neither end
    /// keeps one.
    private static func tidySeparators(_ menu: NSMenu) {
        var i = 0
        while i < menu.items.count {
            let item = menu.items[i]
            guard item.isSeparatorItem else { i += 1; continue }
            let leading = (i == 0)
            let trailing = (i == menu.items.count - 1)
            let doubled = (i > 0 && menu.items[i - 1].isSeparatorItem)
            if leading || trailing || doubled { menu.removeItem(at: i) } else { i += 1 }
        }
    }

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

    /// The same read, off the main thread, with the answer handed back on it.
    /// The store can reach a couple of megabytes, and load() reads the whole
    /// file and decodes it as UTF-8 — done on the main thread at launch that
    /// is time the first frame spends waiting on a disk. Nothing on screen
    /// needs history to draw, so the launch does not wait for it.
    ///
    /// Serialised behind the same queue as the writes, so a load and a write
    /// cannot be looking at the file at once. `sync` inside `load()` for the
    /// migration path would deadlock if this ran the whole thing on that queue,
    /// so the utility queue below is a different one and load() keeps its own.
    func loadAsync(_ done: @escaping (String?) -> Void) {
        DispatchQueue.global(qos: .utility).async { [weak self] in
            let json = self?.load()
            DispatchQueue.main.async { done(json) }
        }
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
    /// What the file looked like at the last look this tab agreed with — the
    /// modification date and the size, together, because one of them alone is
    /// blind on half the volumes a document lives on. See FileMark.
    var mark: FileMark?
    /// A fingerprint of the text this tab and the file last agreed on, kept
    /// beside the mark and answering the question the mark cannot: whether a
    /// file that was written actually says anything different.
    ///
    /// It is what stops the kernel watch being worse than no watch at all. The
    /// watch says a document was rewritten in place; it cannot say whether the
    /// bytes changed, and a great deal of what rewrites a file writes the same
    /// thing back. Without this, `touch`, a `cp` of an identical file, or a
    /// sync client re-materialising one would each land as an external change:
    /// a "Reloaded from disk" toast in front of somebody typing, a background
    /// tab's undo history thrown away, or a sheet asking whether to discard
    /// unsaved work — over a file that says exactly what it said before.
    ///
    /// A hash rather than the text, because the text lives in the web layer and
    /// keeping a second copy of every open document here to compare against
    /// would cost more than the problem. Swift's hashing is seeded per process,
    /// which is all this needs: it is only ever compared with another hash
    /// taken in the same run. Sixty-four bits, so two different documents can
    /// collide and one outside change go unnoticed; at that probability it is a
    /// worse bet than the disk failing.
    var digest: Int?
    /// Only used while the document has no path of its own.
    var placeholder: String
    /// What the file was decoded as, and therefore what it gets written back
    /// as. A new document is UTF-8 because it has never been anything else.
    var encoding: String.Encoding = .utf8
    var encodingGuessed = false

    /// Consecutive silent autosave failures, and whether the status bar has
    /// already been told about this run of them. A read-only volume, a full
    /// disk, an ejected drive: the write stops working and nothing on screen
    /// changes, while "saved 4m ago" from the last good write reads as
    /// reassurance. One failure is noise — a sync client holding the file for
    /// a moment. Three in a row is a fact worth saying, once.
    var saveFailures = 0
    var saveTroubleShown = false
    /// Why the last write failed, in the system's own words.
    var lastSaveError: String?

    /// Names this tab's crash-insurance file for as long as it has no path of
    /// its own. Survives a relaunch, which is the whole point: it is how the
    /// text left in ~/…/minimark/unsaved/ finds its way back to a tab.
    let scratchID: String
    /// What was last written there, so an autosave triggered by a keystroke in
    /// some other tab does not rewrite this one's file byte for byte.
    var scratchText: String?

    /// This document's seat at the table, for as long as it has a path. Made
    /// and dropped by syncPresenters rather than here, because registering is
    /// process-wide state and one place has to own it.
    var presenter: DocPresenter?

    /// The kernel's report on this document, for as long as it has a path.
    /// Beside the presenter, made and dropped by the same reconciler, and for
    /// the same reason: one descriptor per open document is process-wide state.
    var watch: DocWatch?

    /// True when the watch has said this document's bytes were rewritten under
    /// us since the last look the poll took. It is not a verdict — the file may
    /// well say the same thing it said before — it is the poll being told to
    /// look at a document whose mark it would otherwise skip. Cleared where the
    /// mark is recorded, which is the one place a look counts as finished.
    var stirred = false

    /// True from the moment the autosave hands a write to the coordinator
    /// until that write comes back. Coordination is unbounded now — a save can
    /// legitimately be out for as long as the other writer holds the file — and
    /// the autosave is rearmed by every keystroke, so without this a file held
    /// for a minute would collect a minute of stacked writes, each of them
    /// carrying text older than the last. One at a time; the pass that finds a
    /// write already out leaves the tab dirty and the write reschedules itself
    /// on the way back.
    var saving = false

    /// True from the moment the poll hands a read of this document to the
    /// coordinator until that read comes back. Reads are unbounded now, for the
    /// same reason writes are, and the poll comes round every two seconds: a
    /// file somebody is holding for a minute would otherwise collect thirty
    /// stacked reads, landing together, each one carrying an older copy of the
    /// document than the one after it. One at a time; the pass that finds a
    /// read already out leaves the tab alone and comes back in two seconds.
    var reading = false

    /// True while a rename of this document is out with the coordinator. The
    /// rename is unbounded too now, so it can be waiting on another writer for
    /// as long as a save can, and it finishes on disk a moment before this tab
    /// hears about it. An autosave landing in that moment would aim at the name
    /// the document has just left and create it. So the tab stays dirty and
    /// leaves the writing alone until it has one name again.
    var renaming = false

    /// True when the file this document was open on is not there any more:
    /// deleted, moved away by something that has not said where to yet, or on a
    /// volume that went. The text on screen is untouched — what stops is
    /// writing to that path, since putting the file back is recreating a name
    /// somebody took away. Cleared the moment a file is at the path again,
    /// whether it came back or the writer said where it went.
    var vanished = false

    /// Consecutive looks that have found nothing at this document's path, and
    /// when the first of them was. One miss is not a deletion; see noteMissing.
    var missing = 0
    var missingSince: Date?

    /// Whether there is a file to save into. A document that has never been
    /// saved has none, and neither does one whose file has gone — so both of
    /// them autosave into the crash-insurance buffer instead of onto a path,
    /// both of them get asked about at close and at quit rather than written
    /// silently, and neither of them may have a write aimed at a name.
    var hasFile: Bool { url != nil && !vanished }

    /// Bumped every time the web layer reports an edit. The autosave writes off
    /// the main thread now, which leaves a window where keystrokes can land
    /// between the text being fetched and the write coming back; clearing
    /// `dirty` on the strength of a write that predates those keystrokes would
    /// mark the document saved without them. Compared rather than trusted: the
    /// count going up means what was written is already out of date.
    var edits = 0

    init(id: Int, url: URL?, placeholder: String = "Untitled.md", scratchID: String? = nil) {
        self.id = id
        self.url = url
        self.placeholder = placeholder
        self.mark = url.flatMap(fileMark)
        self.scratchID = scratchID ?? UUID().uuidString
    }

    /// The fingerprint kept in `digest`. One place, so the hash a read records
    /// and the hash a write records cannot be taken two different ways.
    static func digest(of text: String) -> Int { text.hashValue }

    /// Drop the crash-insurance file. Called when the buffer becomes a real
    /// document, and when the writer says they do not want it.
    func forgetScratch() {
        guard scratchText != nil else { return }
        scratchText = nil
        Scratch.remove(scratchID)
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
    /// Paths whose documents have been asked for and not arrived. A read is
    /// unbounded now, so there is a real stretch of time between wanting a
    /// document and having it, and asking twice inside that stretch — a second
    /// ⌘O, a double-click on a file a sync client is holding — would otherwise
    /// end with one file open in two tabs, each with its own undo stack and its
    /// own autosave aimed at the same path.
    var opening: Set<String> = []
    /// Whether sudden termination is currently disabled by us. See suddenTermination().
    private var suddenBlocked = false

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
    var recentMenu: NSMenu!
    var webReady = false
    var pendingOpen: URL?
    var pendingExtra: [URL] = []

    var watchTimer: Timer?
    var autosaveWork: DispatchWorkItem?
    /// A look asked for by a kernel watch and not yet taken. See lookSoon.
    var watchLookPending = false
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
            openDocuments(urls)
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
        // Last thing before going, and only on the path that is actually
        // going. A presenter left registered while the app tears down would be
        // asked to flush documents whose tabs are already gone.
        if ok { dropFileWatching() }
        NSApp.reply(toApplicationShouldTerminate: ok)
    }

    private func finishTerminate() {
        let dirty = tabs.filter { $0.dirty }
        guard !dirty.isEmpty else {
            replyToTerminate(true)
            return
        }

        // Anything with a file is simply written, the same as the autosave a
        // second later would have. A document that has never been saved has
        // something left to decide, and so does one whose file has gone —
        // writing that one silently would put back a name somebody took away,
        // on the way out, with nobody looking. Both get asked about.
        let onDisk = dirty.filter { $0.hasFile }
        let untitled = dirty.filter { !$0.hasFile }

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
                self.write(text, to: url, silent: true) { wrote in finish(wrote) }
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

            // Nowhere on disk to go and something in them: ask, one at a time.
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
        // Debug builds only. Left on unconditionally, this puts Inspect
        // Element in front of anybody who right-clicks a word, which is a
        // different app than the one this is meant to be. Build with
        // `swiftc -D DEBUG` to get it back.
        #if DEBUG
        if cfg.preferences.responds(to: NSSelectorFromString("setDeveloperExtrasEnabled:")) {
            cfg.preferences.setValue(true, forKey: "developerExtrasEnabled")
        }
        #endif

        let v = EditorWebView(frame: .zero, configuration: cfg)
        v.onImageFiles = { [weak self] urls, at in self?.importImages(urls, at: at) }
        // Dropped documents join the session rather than replacing what is
        // open, so there is nothing to ask about before taking one.
        v.onDocumentFile = { [weak self] url in self?.openDocument(at: url) }
        v.contextExtras = { [weak self] in self?.formattingMenuItems() ?? [] }
        // Deliberately no registerForDraggedTypes: it *replaces* the type list
        // rather than adding to it, and WKWebView registers a large one at init
        // (text, RTF, web archives, promised files). Narrowing it to .fileURL
        // would stop the view being a drop target for dragged text at all, which
        // is exactly what the overrides above are written to preserve. File
        // drops already reach us — that acceptance is the bug being fixed.
        v.navigationDelegate = self
        v.allowsBackForwardNavigationGestures = false
        v.allowsMagnification = false
        #if DEBUG
        if #available(macOS 13.3, *) { v.isInspectable = true }
        #endif
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
    /// Hand the stored history over, then call back. The read is off the main
    /// thread — the store reaches a couple of megabytes and reading and
    /// decoding it at launch is time the first frame spends waiting on a disk —
    /// but the callback is not decoration: the web layer's histLoad *replaces*
    /// the in-memory store, and its first flush writes that store back to the
    /// file. So anything that could take a snapshot has to happen after this,
    /// or a restore would write its own near-empty store over the real one.
    func pushHistory(_ done: @escaping () -> Void) {
        var answered = false
        let finish: (String?) -> Void = { [weak self] json in
            if answered { return }
            answered = true
            if let self = self, let json = json, !json.isEmpty, self.webReady {
                self.js("if(window.App&&App.setHistory)App.setHistory(\(jsLiteral(json)))")
            }
            done()
        }
        history.loadAsync(finish)
        // A disk that never answers must not leave the app with no document on
        // screen. Losing the race means starting from an empty store, which is
        // the same state a first launch is in.
        DispatchQueue.main.asyncAfter(deadline: .now() + kHistoryLoadTimeout) { finish(nil) }
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
        let target = tab ?? activeTab
        let id = target?.id ?? activeID
        // A write that worked ends any run of failures, whoever asked for it.
        // ⌘S onto a newly writable volume has to clear the warning as surely
        // as the next autosave would.
        if let target = target { noteAutosave(target, ok: true) }
        js("if(window.App)App.setSaved(\(jsLiteral(url.lastPathComponent))," +
           "\(jsLiteral(url.deletingLastPathComponent().path)),\(id))")
    }

    /// The whole tab list. Sent on every change rather than diffed: it is a
    /// handful of short strings, and one reconciliation path on the far side
    /// is worth more than the bytes a patch would save.
    func pushTabs() {
        // Before the guard on purpose. This is the one function every path that
        // adds, removes, renames or re-points a tab already calls, which makes
        // it the only place a reconciler can sit and be sure of seeing every
        // change; and the presenters have to be right during launch and session
        // restore, which is exactly when the web layer is not ready yet.
        syncPresenters()
        syncWatches()
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

        case "openWiki":
            if let name = body["name"] as? String { openWikilink(name) }

        case "wikiCheck":
            if let names = body["names"] as? [String] { answerWikiCheck(names) }

        case "embedRead":
            if let names = body["names"] as? [String] { answerEmbedRead(names) }

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
            if dirty { target?.edits += 1 }
            window?.isDocumentEdited = tabs.contains { $0.dirty }
            suddenTermination()
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
        pushRecents()
        pushSystemTheme()
        pushUserCSS()
        applyChrome()
        // Everything that puts a document on screen waits for the history to
        // arrive — see pushHistory. Nothing above this needs it, so the first
        // frame is already painted by the time the disk answers.
        pushHistory { self.openInitialDocuments() }
    }

    /// Whatever this launch is meant to show: a file double-clicked in Finder,
    /// the session as it was left, or the welcome document.
    private func openInitialDocuments() {
        if let url = pendingOpen {
            pendingOpen = nil
            // A document arriving with the launch replaces the session rather
            // than joining it: double-clicking a file in Finder means "show me
            // this", not "show me this and the nine things I had open".
            tabs = [makeTab(url: nil)]
            activeID = tabs[0].id
            let extra = pendingExtra
            pendingExtra = []
            // The one that was double-clicked goes back in front once the rest
            // have landed. That tab is the placeholder above, which the first
            // document adopts, so its id is known before any of them arrive.
            let front = tabs[0].id
            openDocuments([url] + extra) { [weak self] in
                guard let self = self, !extra.isEmpty else { return }
                self.activate(front)
            }
            return
        }

        // A tab for the welcome document the web layer has already put on
        // screen. Nothing is loaded into it — loadDoc with empty text would
        // wipe it, and the web layer adopts what is on screen into the tab
        // rather than blanking it.
        //
        // It goes up before the session rather than after it, because reads are
        // unbounded now and there is a real stretch between asking for the
        // session and having it. Without a tab, a keystroke landing in that
        // stretch has nowhere to go. restoreSession takes this one away when the
        // first document arrives — unless it has been typed in by then, in
        // which case it has become a document of its own and stays.
        tabs = [makeTab(url: nil)]
        activeID = tabs[0].id
        pushTabs()
        syncWindowToTab()

        restoreSession()
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
    func freeUntitledName(among list: [DocTab]? = nil) -> String {
        let taken = Set((list ?? tabs).filter { $0.url == nil }.map { $0.placeholder })
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
        pushEncoding()
        saveSession()
    }

    /// Whether the process may be killed outright at logout or restart rather
    /// than being asked to quit. Info.plist opts in; this takes the permission
    /// back for as long as anything is unsaved, which is the pairing Apple's
    /// own documents use. Without it the opt-in would mean a restart could
    /// take the last second of typing with it — the one thing the unsaved
    /// buffers exist to prevent.
    ///
    /// Counted rather than set, because disable/enable is a counter in
    /// ProcessInfo and an unbalanced call leaks the permission for the life of
    /// the process. `suddenBlocked` is what keeps the pairs matched.
    func suddenTermination() {
        let unsaved = tabs.contains { $0.dirty }
        guard unsaved != suddenBlocked else { return }
        suddenBlocked = unsaved
        if unsaved { ProcessInfo.processInfo.disableSuddenTermination() }
        else       { ProcessInfo.processInfo.enableSuddenTermination() }
    }

    /// The window furniture that follows whichever document is in front.
    func syncWindowToTab() {
        let url = activeTab?.url
        window?.representedURL = url
        window?.title = url?.lastPathComponent ?? "minimark"
        window?.isDocumentEdited = tabs.contains { $0.dirty }
        suddenTermination()
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
            // Out of the strip, so the reconcilers in pushTabs will never visit
            // it again: whatever it holds on the filesystem's behalf has to go
            // here or it never goes at all.
            self.releaseFileWatching(doomed)
            // Belt and braces: confirmClose has already dropped it on both of
            // the paths that can create one, and a tab nobody has open must
            // not be able to leave a buffer behind whatever route it took.
            doomed.forgetScratch()
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
    /// a file is simply written, the same as the autosave a second later would
    /// have: asking about a file the app saves by itself is theatre. One that
    /// has never been saved has nowhere to go, and so has one whose file is not
    /// there any more, so both of those get the question — the second because
    /// writing it silently would put back a name somebody took away, as the
    /// tab closed, which is the one moment nobody would see it happen.
    func confirmClose(_ tab: DocTab, _ done: @escaping (Bool) -> Void) {
        guard tab.dirty else { done(true); return }

        if let url = tab.url, tab.hasFile {
            fetchText(tab.id) { text in
                // The write is issued and the tab goes. Coordination can take
                // as long as the other writer needs it to, and holding a tab
                // open on that would be a window that will not close; the text
                // has already been captured, the write will land when the file
                // is free, and insureSlowSave has it in the meantime.
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
            case .alertSecondButtonReturn:
                // Discarded on purpose. Leaving the buffer behind would offer
                // it back at the next launch as though it had been lost.
                tab.forgetScratch()
                self.saveSession()
                done(true)
            default:                       done(false)
            }
        }
    }

    // ------------------------------------------------------------------
    // Session
    // ------------------------------------------------------------------

    func saveSession() {
        let defaults = UserDefaults.standard

        // The whole strip, untitled buffers included. A buffer only earns a
        // place once it has been written, or the next launch would offer back
        // a tab with nothing in it.
        let strip = tabs.filter { $0.url != nil || $0.scratchText != nil }
        defaults.set(strip.map { tab -> String in
            if let url = tab.url { return "f:" + url.path }
            return "s:" + tab.scratchID
        }, forKey: kOpenTabsKey)
        defaults.set(strip.firstIndex { $0.id == activeID } ?? 0, forKey: kActiveTabKey)

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
    ///
    /// The answer has to be given now — the caller puts the welcome document up
    /// on a false — but the documents cannot be. Reads are unbounded, so a file
    /// a sync client is busy with arrives when it arrives, and a launch that
    /// waited for the slowest one would be a window full of nothing for as long
    /// as that took. So what is settled here is the list: which entries name a
    /// readable file and which name a buffer, in the order they were in. That
    /// needs no file contents and answers the question.
    ///
    /// Then the documents are read at the same time and each takes its seat as
    /// it arrives, in the position the session recorded rather than the order
    /// the disk answered in. Buffers have their text already and go straight
    /// in. Nothing is ever put in the strip empty: a tab with no document in it
    /// is a tab somebody can type into, and what they type has nowhere to go.
    @discardableResult
    func restoreSession() -> Bool {
        let defaults = UserDefaults.standard
        let fm = FileManager.default

        // The strip as it stood, in order. Older sessions only recorded paths,
        // so those are read into the same shape rather than through a second
        // path that would then have to be kept in step with this one.
        var entries = defaults.stringArray(forKey: kOpenTabsKey) ?? []
        var wantIndex = defaults.integer(forKey: kActiveTabKey)
        if entries.isEmpty {
            var paths = defaults.stringArray(forKey: kOpenDocsKey) ?? []
            if paths.isEmpty, let legacy = defaults.string(forKey: kLastDocKey) { paths = [legacy] }
            entries = paths.map { "f:" + $0 }
            wantIndex = defaults.integer(forKey: kActiveDocKey)
        }

        // Buffers on disk that the session does not mention. That is what a
        // crash leaves behind — the strip was recorded before the buffer was
        // written, or the write and the crash crossed — and they are the whole
        // reason the folder exists, so they are offered back at the end of the
        // strip rather than dropped.
        var named = Set<String>()
        for entry in entries where entry.hasPrefix("s:") { named.insert(String(entry.dropFirst(2))) }
        for id in Scratch.all() where !named.contains(id) { entries.append("s:" + id) }

        /// One seat in the strip: a crash-insurance buffer, whose text is
        /// already in hand, or a path whose document has still to be read.
        enum Seat {
            case buffer(id: String, text: String)
            case file(URL)
        }

        var seenPaths = Set<String>()
        var seenIDs = Set<String>()
        var seats: [Seat] = []

        for entry in entries {
            if seats.count >= kMaxRestoredTabs { break }

            if entry.hasPrefix("s:") {
                let id = String(entry.dropFirst(2))
                guard seenIDs.insert(id).inserted else { continue }
                // Gone, or emptied since. Nothing to offer back, and the file
                // should not sit in the folder being offered back forever.
                guard let text = Scratch.read(id) else { Scratch.remove(id); continue }
                seats.append(.buffer(id: id, text: text))
                continue
            }

            let path = entry.hasPrefix("f:") ? String(entry.dropFirst(2)) : entry
            guard !path.isEmpty, fm.isReadableFile(atPath: path) else { continue }
            let url = URL(fileURLWithPath: path).standardizedFileURL
            guard seenPaths.insert(url.path).inserted else { continue }
            seats.append(.file(url))
        }
        guard !seats.isEmpty else { return false }

        let wantSeat = max(0, min(wantIndex, seats.count - 1))
        var taken: [Int: DocTab] = [:]
        var outstanding = seats.count
        var busy: [String] = []

        /// The tab the launch put up for the welcome document, so that a
        /// keystroke had somewhere to go while the disk was being waited on. It
        /// is not part of the session: it is left out of the untitled naming, so
        /// that a restored buffer is Untitled.md rather than Untitled 2.md, and
        /// it is taken away when the first real document arrives. If it has been
        /// typed in by then it is a document in its own right and it stays.
        let welcome = tabs.first { $0.url == nil && !$0.dirty && $0.scratchText == nil }

        /// Put a restored document in the strip, in its own seat: after every
        /// earlier seat that has already been filled. Which is what keeps the
        /// order the session recorded when the documents come back in whatever
        /// order the disk feels like answering in.
        let sit: (DocTab, Int, String) -> Void = { [unowned self] tab, seat, text in
            var at = 0
            for earlier in 0..<seat {
                guard let done = taken[earlier],
                      let idx = self.tabs.firstIndex(where: { $0 === done }) else { continue }
                at = max(at, idx + 1)
            }
            let first = taken.isEmpty
            taken[seat] = tab
            self.tabs.insert(tab, at: min(at, self.tabs.count))
            if first, let w = welcome, !w.dirty, w.scratchText == nil,
               let idx = self.tabs.firstIndex(where: { $0 === w }) {
                self.tabs.remove(at: idx)
            }
            // The document is handed over before the strip is, so the strip has
            // somewhere to switch *to*. setTabs then activates whichever was in
            // front and the web layer finds its text already waiting.
            self.js("if(window.App)App.loadDoc(\(jsLiteral(text))," +
                    "\(jsLiteral(tab.name)),\(jsLiteral(tab.dir)),\(tab.id))")
            // Whatever arrives first is put in front so the window is showing a
            // real document rather than the welcome one, and the tab that was
            // actually in front takes over from it when it lands.
            if first || seat == wantSeat { self.activeID = tab.id }
            self.pushTabs()
            self.syncWindowToTab()
        }

        /// One seat answered for, either way. The last of them is where
        /// anything that could not be read is said, once, rather than a
        /// document at a time — a launch is the wrong moment for a stack of
        /// them, and a tab that is simply not there is the sort of silence a
        /// writer notices later and cannot explain. A session where nothing
        /// could be reopened needs nothing done: the welcome tab is still
        /// standing, because no document ever arrived to take it away.
        let answered: () -> Void = { [unowned self] in
            outstanding -= 1
            guard outstanding == 0, !busy.isEmpty else { return }
            self.toast(busy.count == 1
                       ? "“\(busy[0])” could not be reopened — something else is writing it"
                       : "\(busy.count) documents could not be reopened — "
                         + "something else is writing them")
        }

        for (seat, entry) in seats.enumerated() {
            switch entry {
            case .buffer(let id, let text):
                let tab = DocTab(id: nextTabID, url: nil,
                                 placeholder: freeUntitledName(
                                     among: tabs.filter { $0 !== welcome }),
                                 scratchID: id)
                nextTabID += 1
                // Never saved, and still not saved. Dirty is the truth about
                // it, and it is also what makes quit ask rather than throw the
                // buffer away a second time.
                tab.dirty = true
                tab.scratchText = text
                sit(tab, seat, text)
                answered()

            case .file(let url):
                readTextFile(url) { outcome in
                    switch outcome {
                    case .text(let file):
                        let tab = DocTab(id: self.nextTabID, url: url)
                        tab.encoding = file.encoding
                        tab.encodingGuessed = file.guessed
                        tab.digest = DocTab.digest(of: file.text)
                        self.nextTabID += 1
                        sit(tab, seat, file.text)
                    case .notText:
                        // A file that has become unreadable since it was noted
                        // is skipped rather than reported: a launch is the
                        // wrong moment for a stack of alerts about documents
                        // nobody has asked for yet.
                        break
                    case .busy:
                        // Worth one line, because a tab that is simply not
                        // there is the kind of silence a writer notices later
                        // and cannot explain.
                        busy.append(url.lastPathComponent)
                    }
                    answered()
                }
            }
        }
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
        // The buffer is a document now. Its crash-insurance file would only
        // come back at the next launch as a second, older copy of the same
        // writing under an Untitled name.
        if url != nil { target.forgetScratch() }
        target.url = url
        target.mark = url.flatMap(fileMark)
        // Save As, a rename landing, a buffer becoming a document: whatever
        // brought us here, this tab has a file at a path again and is not the
        // one whose file has gone.
        if url != nil { documentFound(target) }
        if let url = url {
            NSDocumentController.shared.noteNewRecentDocumentURL(url)
            pushRecents()
        }
        if target.id == activeID { syncWindowToTab() }
        pushTabs()
        saveSession()
    }

    // ------------------------------------------------------------------
    // Reading and writing text
    //
    // This used to end with String(decoding:as:UTF8.self), which never fails:
    // it substitutes U+FFFD for every byte it cannot make sense of. Open a
    // Latin-1 file, type one character, and the autosave a second later wrote
    // the replacement characters back over the original. There is no undo for
    // that on disk, and nothing anywhere said it had happened.
    //
    // Two things fix it, and it needs both. Decoding stops guessing and says
    // which encoding it used; writing then uses that same encoding rather than
    // always UTF-8. Reading Latin-1 and writing UTF-8 is what destroyed the
    // file — reading Latin-1 and writing Latin-1 round-trips every byte.
    //
    // Latin-1 is last and always succeeds, because every byte is a valid
    // Latin-1 character. That is a feature here: it means a file is never
    // refused for being in some 8-bit encoding we did not think of, and
    // whatever it was, saving gives its bytes back unchanged. It is recorded
    // as a guess rather than a fact, and the status bar says so.
    // ------------------------------------------------------------------

    struct TextFile {
        let text: String
        let encoding: String.Encoding
        /// True when nothing identified the encoding and Latin-1 was assumed.
        let guessed: Bool

        var label: String {
            let name: String
            switch encoding {
            case .utf8:            name = "UTF-8"
            case .utf16:           name = "UTF-16"
            case .utf16LittleEndian: name = "UTF-16 LE"
            case .utf16BigEndian:  name = "UTF-16 BE"
            case .utf32:           name = "UTF-32"
            case .isoLatin1:       name = "Latin-1"
            case .macOSRoman:      name = "Mac OS Roman"
            case .windowsCP1252:   name = "Windows-1252"
            default:               name = "Encoding \(encoding.rawValue)"
            }
            return guessed ? name + " (assumed)" : name
        }
    }

    /// A file that is not text at all. Opening one and letting autosave have
    /// it is the same data loss by a different road, and a NUL byte outside a
    /// UTF-16 or UTF-32 file is the cheapest reliable tell there is.
    func looksBinary(_ data: Data) -> Bool {
        if data.starts(with: [0xFE, 0xFF]) || data.starts(with: [0xFF, 0xFE]) { return false }
        if data.starts(with: [0x00, 0x00, 0xFE, 0xFF]) { return false }
        return data.prefix(8000).contains(0x00)
    }

    /// What a read of a document came back with. Three answers rather than the
    /// two an optional can carry, and the third is the one this exists for: a
    /// file that could not be read whole is not the same thing as a file with
    /// nothing in it, and a caller handed `nil` for both would open an empty
    /// tab over a document somebody is halfway through writing.
    enum ReadOutcome {
        /// The document, read whole.
        case text(TextFile)
        /// The read was clean and there is nothing here to open: no file at the
        /// path, or a file that is not text this app may edit.
        case notText
        /// Something is writing the file right now and it could not be read
        /// whole. Nothing is handed back, and the sentence is for a person.
        case busy(String)
    }

    /// Read a document, and answer on main when it has been read.
    ///
    /// Coordinated, so a file being written by iCloud or Dropbox is read after
    /// that write rather than during it, and asynchronous, because waiting for
    /// that on the thread the writer is typing on is what froze the app for two
    /// seconds a document. Every decode goes inside the one coordinated block:
    /// two reads would be two chances to catch the file in different states.
    ///
    /// `presenter(for:)` reads the tab list, so this is main's to call.
    func readTextFile(_ url: URL, then: @escaping (ReadOutcome) -> Void) {
        Coordinated.read(url, presenter: presenter(for: url), { u in
            self.decodeTextFile(u)
        }, then: { file, error in
            if let error = error { then(.busy(error.localizedDescription)); return }
            guard let file = file else { then(.notText); return }
            then(.text(file))
        })
    }

    private func decodeTextFile(_ url: URL) -> TextFile? {
        guard let data = try? Data(contentsOf: url) else { return nil }
        if looksBinary(data) { return nil }

        // UTF-8 first and strictly. String(data:encoding:) returns nil on a
        // byte sequence that is not valid UTF-8, which is the check the old
        // code was missing.
        if let s = String(data: data, encoding: .utf8) {
            return TextFile(text: s, encoding: .utf8, guessed: false)
        }
        // A byte-order mark is the one time a file states its own encoding.
        for (bom, enc) in [([0xFF, 0xFE, 0x00, 0x00], String.Encoding.utf32LittleEndian),
                           ([0x00, 0x00, 0xFE, 0xFF], .utf32BigEndian),
                           ([0xFF, 0xFE], .utf16LittleEndian),
                           ([0xFE, 0xFF], .utf16BigEndian)] {
            if data.starts(with: bom.map { UInt8($0) }),
               let s = String(data: data, encoding: enc) {
                return TextFile(text: s, encoding: enc, guessed: false)
            }
        }
        // Then whatever the system can tell us, which includes the encoding
        // recorded in the file's extended attributes by other Mac editors.
        var used = String.Encoding.utf8
        if let s = try? String(contentsOf: url, usedEncoding: &used) {
            return TextFile(text: s, encoding: used, guessed: false)
        }
        // Last, and never fails.
        if let s = String(data: data, encoding: .isoLatin1) {
            return TextFile(text: s, encoding: .isoLatin1, guessed: true)
        }
        return nil
    }

    /// The presenter registered for a path, if a tab holds it. Handed to the
    /// coordinator so that our own reads and writes are not reported back to us
    /// a moment later as somebody else's change.
    func presenter(for url: URL) -> DocPresenter? {
        let target = url.standardizedFileURL
        return tabs.first { $0.url?.standardizedFileURL == target }?.presenter
    }

    /// What a write did, with nothing in it that belongs to the app. Kept apart
    /// so the disk half can run on any thread and the state half always runs on
    /// main, without either of them being written twice.
    enum WriteOutcome {
        /// Written. `promoted` when the file's own encoding could not hold the
        /// text and UTF-8 was used instead.
        case wrote(promoted: Bool)
        case failed(String)
        /// There was no document at the path to save into. Not a write that
        /// failed — a document that is not where the app thought it was, which
        /// wants a different answer and a different sentence, so it is kept
        /// apart from `failed` rather than folded into it.
        case vanished(String)
    }

    /// Every extended attribute the file at `src` carries, copied onto `dst`.
    ///
    /// Finder tags, Finder comments, the encoding some other Mac editor
    /// recorded, a download's quarantine flag: all of that is extended
    /// attributes, all of it is the writer's, and a freshly made file swapped
    /// into place has none of it. com.apple.provenance is the one exception —
    /// the kernel owns it and setxattr on it fails, and a loop that took that
    /// for a real error would drop every attribute after it.
    private static func carryXattrs(from src: String, to dst: String) {
        let size = listxattr(src, nil, 0, 0)
        guard size > 0 else { return }
        var names = [CChar](repeating: 0, count: size)
        guard listxattr(src, &names, size, 0) > 0 else { return }
        for name in names.split(separator: 0).compactMap({ String(cString: Array($0) + [0]) }) {
            if name == "com.apple.provenance" { continue }
            let valueSize = getxattr(src, name, nil, 0, 0, 0)
            guard valueSize >= 0 else { continue }
            var value = [UInt8](repeating: 0, count: max(valueSize, 1))
            if valueSize > 0 {
                guard getxattr(src, name, &value, valueSize, 0, 0) >= 0 else { continue }
            }
            _ = setxattr(dst, name, value, valueSize, 0, 0)
        }
    }

    /// Puts `data` where `url` is, keeping what the filesystem already knew
    /// about the file that is there.
    ///
    /// `String.write(atomically: true)` writes a brand new file and swaps it
    /// in. That is what makes it crash-safe, and it is also what made every
    /// autosave quietly destroy the file's extended attributes and reset its
    /// creation date — measured, against iA Writer, which preserves both.
    /// Finder tags and Finder comments *are* extended attributes. None of it is
    /// ours to throw away.
    ///
    /// So the swap is done by hand: stage the bytes beside the file, carry the
    /// metadata across onto the staging file, and only then replace. Beside,
    /// rather than in a temporary directory, so the replace is a rename on the
    /// one volume; dot-prefixed and uniquely named, and it exists for the
    /// length of the swap and no longer.
    ///
    /// The inode still changes and a hard link still breaks. That is simply
    /// what an atomic replace is — iA Writer does the same — and the trade the
    /// other way is a half-written document after a power cut.
    private static func replaceContents(of url: URL, with data: Data) throws {
        let fm = FileManager.default
        // Nothing there yet: a Save As, or a file being created. No metadata to
        // keep, and the ordinary atomic write is already the right answer.
        guard let was = try? fm.attributesOfItem(atPath: url.path) else {
            try data.write(to: url, options: .atomic)
            return
        }

        let token = String(UInt32.random(in: 0 ... .max), radix: 16)
        let staged = url.deletingLastPathComponent()
            .appendingPathComponent(".\(url.lastPathComponent).minimark-\(token)")
        do {
            // Not atomically: this is a file nobody knows about yet, and an
            // atomic write of it would only stage a staging file.
            try data.write(to: staged)
            carryXattrs(from: url.path, to: staged.path)
            var keep: [FileAttributeKey: Any] = [:]
            if let mode = was[.posixPermissions] { keep[.posixPermissions] = mode }
            // When the document came into being is not a fact about this save.
            if let born = was[.creationDate] { keep[.creationDate] = born }
            if !keep.isEmpty { try? fm.setAttributes(keep, ofItemAtPath: staged.path) }
            // .usingNewMetadataOnly, because the metadata that matters is
            // now on the staging file and that is the copy this option keeps.
            // Neither option is right on its own: measured, this one leaves
            // the permissions at 644 and the default rewrites them to 600.
            // That is what the two lines above are for.
            _ = try fm.replaceItemAt(url, withItemAt: staged, backupItemName: nil,
                                     options: [.usingNewMetadataOnly])
        } catch {
            try? fm.removeItem(at: staged)
            throw error
        }
    }

    /// The half that touches the disk. No app state is read or written here, so
    /// it is safe anywhere; `applyWrite` does the rest, on main.
    ///
    /// Asynchronous, because coordination is: `done` is called on main once the
    /// file has actually been written, which on a contended file is whenever
    /// the other writer lets go. Nothing waits on a thread for it, and nothing
    /// is written without the claim.
    ///
    /// `done` is told where the bytes went as well as how it went, because on a
    /// contended file those are no longer the same question: a coordinated
    /// rename while this write waits its turn carries it to the document's new
    /// name, and the caller has a modification date to record against whichever
    /// path it actually landed on.
    ///
    /// `intent` has no default on purpose. Whether a path with nothing at it is
    /// a file waiting to be made or a document that has gone is the one thing
    /// this cannot work out for itself, and a default would let a call site
    /// answer it by not thinking about it.
    static func writeToDisk(_ text: String, to url: URL, encoding want: String.Encoding,
                            intent: Coordinated.Intent,
                            presenter: NSFilePresenter?,
                            done: @escaping (WriteOutcome, URL) -> Void) {
        // Which encoding wins is settled before anything touches the disk, so
        // the two attempts cost one staged file rather than two. The file's own
        // encoding first: if the writer has since typed something it cannot
        // hold — an em dash into a Latin-1 file, an emoji into anything 8-bit —
        // data(using:) returns nil rather than mangling, and the document is
        // promoted to UTF-8 and stays that way. Promoting is safe in a way the
        // reverse would not be: UTF-8 can hold everything the old encoding
        // could.
        var promoted = false
        var payload = want == .utf8 ? nil : text.data(using: want)
        if payload == nil {
            payload = text.data(using: .utf8)
            promoted = want != .utf8
        }
        guard let data = payload else {
            done(.failed("The document could not be encoded."), url)
            return
        }

        var outcome = WriteOutcome.failed("The file could not be written.")
        // Where the bytes actually went. The same path unless the coordinator
        // moved the claim while it was pending, and written before `then` runs
        // for the same reason `outcome` is.
        var landed = url
        // One coordination for the whole attempt, not one per encoding. Taking
        // it twice would let a sync client in between the two, and the second
        // write would be racing the copy it had just uploaded.
        Coordinated.write(url, intent: intent, presenter: presenter, { u in
            landed = u
            do {
                try replaceContents(of: u, with: data)
                outcome = .wrote(promoted: promoted)
            } catch {
                outcome = .failed(error.localizedDescription)
            }
        }, then: { error in
            // An error here means the file was never ours and nothing was
            // written — the claim was cancelled, the coordinator refused, or
            // there is no document at that path to save into. The last of those
            // is not a bad write, it is a document that has gone somewhere, and
            // the app answers it differently: it stops writing to that name
            // rather than trying again a second later.
            if let error = error {
                done(Coordinated.isGone(error) ? .vanished(error.localizedDescription)
                                               : .failed(error.localizedDescription), url)
            } else { done(outcome, landed) }
        })
    }

    /// Insurance against a save that has not come back.
    ///
    /// Coordination is unbounded now, which is what stops a contended save
    /// destroying the other writer's file — but it also means a wedged sync
    /// daemon can keep the writing off disk for as long as it likes, and until
    /// it lands the only copy of that writing is in one WKWebView. So a save
    /// still out at kCoordinationTimeout puts the text into the same
    /// crash-insurance buffer an untitled document uses, and says so in the
    /// status bar rather than in a sheet — the same reasoning as the silent
    /// autosave: an unprompted write must not take the keyboard away
    /// mid-sentence.
    ///
    /// Nothing is dropped and nothing is written over. When the other writer
    /// lets go the real save lands, `applyWrite` throws the buffer away, and
    /// the status bar goes quiet. If instead the app dies waiting, the next
    /// launch finds the buffer in ~/…/minimark/unsaved/ and offers it back,
    /// which is exactly what that folder is for.
    ///
    /// Returns the pending work so the write can cancel it on the way back.
    private func insureSlowSave(_ tab: DocTab, _ text: String) -> DispatchWorkItem {
        let work = DispatchWorkItem { [weak self, weak tab] in
            guard let self = self, let tab = tab else { return }
            if Scratch.write(text, id: tab.scratchID) { tab.scratchText = text }
            guard !tab.saveTroubleShown else { return }
            tab.saveTroubleShown = true
            let why = "Waiting for another app to release this file. Your text is safe."
            self.js("if(window.App&&App.saveTrouble)App.saveTrouble(\(tab.id),\(jsLiteral(why)))")
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + kCoordinationTimeout, execute: work)
        return work
    }

    /// `silent` is for the autosave path, which runs unprompted: a modal sheet
    /// there interrupts typing, and because the document stays dirty every
    /// keystroke reschedules the write, so one unwritable file produces an
    /// alert roughly once a second.
    ///
    /// Asynchronous, all of it, ⌘S included: `done` runs on main once the bytes
    /// are on disk. It used to block whichever thread called it for up to
    /// kCoordinationTimeout and then write over whoever was holding the file.
    /// A person who pressed ⌘S is waiting, but they are better served by a
    /// window that still moves and a save that lands a moment late than by a
    /// frozen app and a stranger's file destroyed.
    ///
    /// `intent` is `.update` for everything except the two writes that exist to
    /// make a file — Save As, and a wikilink making the note it points at.
    func write(_ text: String, to url: URL, intent: Coordinated.Intent = .update,
               silent: Bool = false, tab: DocTab? = nil,
               done: @escaping (Bool) -> Void = { _ in }) {
        let target = tab ?? tabs.first { $0.url?.standardizedFileURL == url.standardizedFileURL }
        let insurance = target.map { insureSlowSave($0, text) }
        AppDelegate.writeToDisk(text, to: url,
                                encoding: target?.encoding ?? .utf8,
                                intent: intent,
                                presenter: presenter(for: url)) { outcome, landed in
            insurance?.cancel()
            done(self.applyWrite(outcome, to: landed, wrote: text, silent: silent, tab: target))
        }
    }

    /// The autosave's write: the same one, plus the check only the autosave
    /// needs, and the flag that keeps it from stacking.
    func writeFromAutosave(_ text: String, to url: URL, tab: DocTab,
                           done: @escaping (Bool) -> Void) {
        let insurance = insureSlowSave(tab, text)
        tab.saving = true
        // .update without exception: the autosave saves documents that are on
        // disk, and it is the one write that must never be able to make a file.
        AppDelegate.writeToDisk(text, to: url, encoding: tab.encoding,
                                intent: .update,
                                presenter: presenter(for: url)) { outcome, landed in
            insurance.cancel()
            tab.saving = false
            // Re-checked on the way back, not on the way out, and against where
            // the bytes went rather than where they were aimed: a Save As
            // during the write leaves this landing on a path the tab no longer
            // holds, and a coordinated rename during it carries the write to
            // the path the tab now does. Stamping a path this tab is not at
            // would hide the next real outside change to it.
            guard tab.url?.standardizedFileURL == landed.standardizedFileURL else {
                done(false)
                return
            }
            done(self.applyWrite(outcome, to: landed, wrote: text, silent: true, tab: tab))
        }
    }

    /// Everything a finished write means to the app: what the file now looks
    /// like and says, the promotion to UTF-8, and who gets told. Main thread
    /// only.
    private func applyWrite(_ outcome: WriteOutcome, to url: URL, wrote text: String,
                            silent: Bool, tab target: DocTab?) -> Bool {
        switch outcome {
        case .wrote(let promoted):
            stampFile(url, text: text)             // don't watch our own write back in
            if let target = target {
                // The writing is on disk, so the insurance taken out against
                // this save being slow is not needed and must not be left in
                // the folder for the next launch to offer back. Both of these
                // are no-ops unless the save actually was slow.
                target.forgetScratch()
                if target.saveTroubleShown {
                    target.saveTroubleShown = false
                    target.saveFailures = 0
                    target.lastSaveError = nil
                    js("if(window.App&&App.saveTrouble)App.saveTrouble(\(target.id),null)")
                }
            }
            if promoted, let target = target {
                target.encoding = .utf8
                target.encodingGuessed = false
                if target.id == activeID { pushEncoding() }
                if !silent { toast("Saved as UTF-8 — the new text needed it") }
            }
            return true
        case .failed(let why):
            target?.lastSaveError = why
            if !silent { presentError("Could not save “\(url.lastPathComponent)”", why) }
            return false
        case .vanished(let why):
            target?.lastSaveError = why
            // One more look before giving a document up, because this is the
            // one route to that verdict that does not go through the poll's two
            // of them. The write held the claim when it looked, so no
            // coordinating writer could have been mid-replace — but a writer
            // that removes the file and writes it again coordinates with
            // nobody, and that shape leaves a window measured at 0.162ms.
            // Looking again here, milliseconds later and back on main, costs a
            // stat and turns a lost race into a save that retries a second
            // later rather than a document given up for gone.
            guard !FileManager.default.fileExists(atPath: url.path) else { return false }
            // Not a run of failures to be counted up to three before saying
            // anything: the file is gone, that is a fact on the first attempt,
            // and the thing that has to stop is not the reporting but the
            // writing. documentVanished says it once, stops the tab aiming at
            // that name, and schedules the pass that puts the text into the
            // crash-insurance buffer — which is where a document with nowhere
            // on disk to go keeps its writing.
            if let target = target { documentVanished(target, why: why) }
            if !silent { presentError("Could not save “\(url.lastPathComponent)”", why) }
            return false
        }
    }

    /// Called after every autosave attempt on a tab. Counts a run of failures
    /// and says so once when it reaches three, in the status bar rather than
    /// in a sheet — the sheet is what the silent write was introduced to stop,
    /// and an unprompted write should not be able to take the keyboard away
    /// mid-sentence. A single success clears it.
    func noteAutosave(_ tab: DocTab, ok: Bool) {
        if ok {
            tab.saveFailures = 0
            tab.lastSaveError = nil
            guard tab.saveTroubleShown else { return }
            tab.saveTroubleShown = false
            js("if(window.App&&App.saveTrouble)App.saveTrouble(\(tab.id),null)")
            return
        }
        tab.saveFailures += 1
        guard tab.saveFailures >= kSaveFailuresBeforeSaying, !tab.saveTroubleShown else { return }
        tab.saveTroubleShown = true
        let why = tab.lastSaveError ?? "The file could not be written."
        js("if(window.App&&App.saveTrouble)App.saveTrouble(\(tab.id),\(jsLiteral(why)))")
    }

    /// Tells the page what the document in front is encoded as, so the status
    /// bar can say so. It stays quiet for UTF-8, which is every file anyone
    /// will open and not worth a word about; anything else is worth knowing
    /// before you have typed a page into it.
    func pushEncoding() {
        guard let tab = activeTab else { return }
        let label = tab.encoding == .utf8 ? "" : TextFile(text: "", encoding: tab.encoding,
                                                          guessed: tab.encodingGuessed).label
        js("if(window.App&&App.setEncoding)App.setEncoding(\(jsLiteral(label)))")
    }


    /// Every tab holding this path, so the watcher does not report our own
    /// write back to us as an outside change.
    ///
    /// The text as well as the mark, because the mark is no longer the only
    /// thing a look compares. A save records what the file now says, so that a
    /// later look at a file somebody rewrote with the same bytes — a `cp` of an
    /// identical copy, a sync client putting back what we just sent it — is
    /// recognised as saying nothing new rather than reloaded over the writer.
    func stampFile(_ url: URL, text: String?) {
        let now = fileMark(url)
        let target = url.standardizedFileURL
        for tab in tabs where tab.url?.standardizedFileURL == target {
            tab.mark = now
            tab.stirred = false
            if let text = text { tab.digest = DocTab.digest(of: text) }
        }
    }

    /// Open a file into a tab. Which tab depends on what is in front: an
    /// untitled document nobody has typed in is a placeholder, so it is used
    /// rather than left behind, and anything else gets a tab of its own.
    ///
    /// The read is unbounded now, so this returns straight away and the tab
    /// appears when the document has been read whole. No tab is made before
    /// then, deliberately. A tab that opens empty and fills itself in three
    /// seconds later is a document that was empty for three seconds as far as
    /// anyone looking at it could tell, and anything typed into it in that time
    /// is typed into the wrong place — or worse, saved from it. So the window
    /// keeps showing what it was showing, which is true, and if the disk takes
    /// long enough for that to look like nothing happening, it says why.
    ///
    /// Which tab to use is decided when the text arrives rather than when it
    /// was asked for, and that is the more truthful answer as well as the only
    /// possible one: the untitled tab in front may have been typed into while
    /// the disk was busy, and a tab somebody has started writing in is not a
    /// placeholder any more.
    ///
    /// `then` runs on main, with whether a document ended up open.
    func openDocument(at url: URL, then: ((Bool) -> Void)? = nil) {
        // Already open. Two tabs on one file would give it two undo stacks and
        // two autosaves racing for the same path, so this brings the one that
        // exists forward instead.
        if let open = tabs.first(where: { $0.url?.standardizedFileURL == url.standardizedFileURL }) {
            activate(open.id)
            command("showTabs")
            then?(true)
            return
        }
        // The same guard, for a document that has been asked for and has not
        // arrived. Without it a second ⌘O — or an impatient double-click while
        // a sync client is holding the file — ends with one file in two tabs
        // the moment the disk answers.
        let pending = url.standardizedFileURL.path
        guard opening.insert(pending).inserted else { then?(false); return }

        var arrived = false
        DispatchQueue.main.asyncAfter(deadline: .now() + kSlowOpenNotice) { [weak self] in
            guard let self = self, !arrived else { return }
            self.toast("Waiting for “\(url.lastPathComponent)” — something else is using it")
        }

        readTextFile(url) { outcome in
            arrived = true
            self.opening.remove(pending)

            let file: TextFile
            switch outcome {
            case .text(let read):
                file = read
            case .notText:
                self.presentError("Could not open “\(url.lastPathComponent)”",
                                  "It could not be read as text. Files that are not text are refused "
                                  + "rather than opened, because editing one and saving it back would "
                                  + "destroy it.")
                then?(false)
                return
            case .busy(let why):
                // Not a failure, and not phrased as one: the document is fine
                // and somebody is in the middle of writing it. Refusing costs a
                // second and another ⌘O; opening what was there at that moment
                // costs the half of the document that had not landed yet.
                self.presentError("Could not open “\(url.lastPathComponent)” yet", why)
                then?(false)
                return
            }
            let text = file.text

            // The world moved while the disk was answering. Something else may
            // have opened this document in the meantime — the session, a drop,
            // a wikilink — and one file in two tabs is the thing the guard at
            // the top exists to prevent, so it is asked again down here.
            if let open = self.tabs.first(where: {
                $0.url?.standardizedFileURL == url.standardizedFileURL
            }) {
                self.activate(open.id)
                then?(true)
                return
            }

            let target: DocTab
            if let current = self.activeTab, current.url == nil, !current.dirty {
                target = current
            } else {
                let fresh = self.makeTab(url: nil)
                let at = (self.tabs.firstIndex { $0.id == self.activeID }).map { $0 + 1 }
                    ?? self.tabs.count
                self.tabs.insert(fresh, at: at)
                target = fresh
            }

            target.dirty = false
            target.encoding = file.encoding
            target.encodingGuessed = file.guessed
            // What the file says, recorded now, so that the first outside
            // rewrite of it can be told from the first outside change to it.
            target.digest = DocTab.digest(of: text)
            // The text first, then the list. loadDoc parks a document named
            // against a tab that is not yet in front, so by the time setTabs
            // switches to it the page already has it — the other order shows an
            // empty document for however long the two messages take to cross.
            self.js("if(window.App)App.loadDoc(\(jsLiteral(text))," +
                    "\(jsLiteral(url.lastPathComponent))," +
                    "\(jsLiteral(url.deletingLastPathComponent().path)),\(target.id))")
            self.activeID = target.id
            self.setDocument(url, tab: target)
            self.syncWindowToTab()
            self.pushEncoding()
            then?(true)
        }
    }

    /// Several documents at once — a multiple selection from Finder, an open
    /// panel, the extras that arrive with a launch. One after another rather
    /// than all at once, so the strip ends up in the order they were handed
    /// over rather than the order the disk happened to answer in.
    func openDocuments(_ urls: [URL], then: (() -> Void)? = nil) {
        guard let first = urls.first else { then?(); return }
        let rest = Array(urls.dropFirst())
        openDocument(at: first) { [weak self] _ in
            guard let self = self else { then?(); return }
            self.openDocuments(rest, then: then)
        }
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
    ///
    /// A document whose file has gone takes the Save As branch too, and that is
    /// a decision rather than a fallthrough. ⌘S could put the file back where
    /// it was — one keystroke, the document restored, nothing to think about —
    /// and that is exactly the trap. The most ordinary way for a file to
    /// disappear from under an open document is that somebody moved it, and
    /// writing it back to the old name would make the second file this whole
    /// round exists to prevent, this time with the writer's own keystroke on
    /// it. So it asks. The panel opens with the document's own name already in
    /// it, so a file that really was deleted costs one confirmation to put
    /// back; a file that was moved is the writer's to place, because they are
    /// the only one who knows where it went.
    func saveDocument(tab: DocTab? = nil, _ done: @escaping (Bool) -> Void) {
        guard let target = tab ?? activeTab else { done(false); return }
        guard let url = target.url, target.hasFile else { saveAs(tab: target, done); return }
        fetchText(target.id) { text in
            guard let text = text else {
                self.presentError("Could not save “\(url.lastPathComponent)”",
                                  "minimark could not read the document back from the editor. "
                                  + "The file on disk has been left as it was.")
                done(false)
                return
            }
            self.write(text, to: url, tab: target) { ok in
                if ok {
                    target.dirty = false
                    self.window?.isDocumentEdited = self.tabs.contains { $0.dirty }
                    self.suddenTermination()
                    self.pushSaved(url, tab: target)
                }
                done(ok)
            }
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
                // The one write in the app whose whole purpose is to make a
                // file, so the one that says so. Everything else is a save of a
                // document that is already there.
                self.write(text, to: url, intent: .create) { ok in
                    guard ok else { done(false); return }
                    target.dirty = false
                    self.setDocument(url, tab: target)
                    self.window?.isDocumentEdited = self.tabs.contains { $0.dirty }
                    self.suddenTermination()
                    self.pushSaved(url, tab: target)
                    done(true)
                }
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

    /// What the writer typed in the rename field, turned into a filename this
    /// will act on, or nil if there is nothing there to act on.
    ///
    /// Pulled out of renameDocument so it can be tested on its own: it is the
    /// whole of the rename that can destroy something, and the rest of that
    /// function is a file move and two messages.
    ///
    /// `keepingExtension` is the current file's extension, put back when the
    /// new name does not carry one — renaming "notes.md" to "drafts" should
    /// not leave an extensionless file behind.
    func sanitiseFilename(_ raw: String, keepingExtension ext: String) -> String? {
        var name = raw
            .replacingOccurrences(of: "/", with: "-")
            .replacingOccurrences(of: ":", with: "-")
            .trimmingCharacters(in: .whitespacesAndNewlines)

        // A leading dot hides the file from Finder and from every open panel in
        // the system, so renaming to ".notes" reads as the document having been
        // destroyed. Nobody types one on purpose in a rename field; the ones
        // that get typed are a slip, or the start of an extension.
        //
        // Stripping and trimming until neither changes anything, rather than
        // once each. ". ." trims to ". .", loses its dot to ".", and is a
        // leading dot again — one pass leaves it, and the extension put back
        // below then makes "..md", which is exactly the hidden file this is
        // here to prevent.
        while true {
            let was = name
            while name.hasPrefix(".") { name.removeFirst() }
            name = name.trimmingCharacters(in: .whitespacesAndNewlines)
            if name == was { break }
        }
        guard !name.isEmpty else { return nil }

        if (name as NSString).pathExtension.isEmpty && !ext.isEmpty {
            name += "." + ext
        }
        return name
    }

    func renameDocument(to raw: String) {
        // `hasFile`, not just a path: renaming a file that is not there can
        // only fail, and the honest answer to "give this document a new name"
        // when it has no file is the panel that gives it one.
        guard let target = activeTab, let url = target.url, target.hasFile else {
            menuSaveAs(nil)
            return
        }

        guard let name = sanitiseFilename(raw, keepingExtension: url.pathExtension) else { return }
        guard name != url.lastPathComponent else { return }

        let dest = url.deletingLastPathComponent().appendingPathComponent(name)
        if FileManager.default.fileExists(atPath: dest.path) {
            presentError("Could not rename", "“\(name)” already exists in that folder.")
            js("if(window.App)App.renamed(\(jsLiteral(url.lastPathComponent)),\(target.id))")
            return
        }
        // The tab keeps the old name until the file has it, because saying it
        // moved before it moved is telling the writer something landed that has
        // not — and because a write aimed at a name the document has already
        // left is the whole bug this round is about. A write issued while the
        // rename is still waiting is safe either way round: the coordinator
        // either lands it on the old name and lets the rename carry it across,
        // or announces the rename to it and lets it follow.
        //
        // What is not safe is the sliver between the two, after the file has
        // moved on disk and before this completion has run on main and told the
        // tab. An autosave firing in there would stat a path that has just gone
        // and create it. So the tab does not autosave while its rename is out;
        // it stays dirty and writes the moment it has one name again.
        target.renaming = true
        Coordinated.move(from: url, to: dest, presenter: target.presenter, { a, b in
            do { try FileManager.default.moveItem(at: a, to: b); return nil }
            catch { return error }
        }, then: { [weak target] error in
            guard let target = target, self.tabs.contains(where: { $0 === target }) else { return }
            target.renaming = false
            if let error = error {
                self.presentError("Could not rename", error.localizedDescription)
                self.js("if(window.App)App.renamed(\(jsLiteral(url.lastPathComponent)),\(target.id))")
            } else {
                self.setDocument(dest, tab: target)
                self.js("if(window.App)App.renamed(\(jsLiteral(name)),\(target.id))")
            }
            self.scheduleAutosave()
        })
    }

    // ------------------------------------------------------------------
    // Autosave + file watching
    // ------------------------------------------------------------------

    func scheduleAutosave() {
        autosaveWork?.cancel()
        // Every dirty tab has somewhere to go now: a file, or a crash-insurance
        // buffer in ~/…/minimark/unsaved/. This used to return early unless
        // some tab had a path, which is exactly how a page of untitled writing
        // came to exist in one WKWebView's memory and nowhere else.
        guard tabs.contains(where: { $0.dirty }) else { return }
        let work = DispatchWorkItem { [weak self] in self?.runAutosave() }
        autosaveWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + kAutosaveDelay, execute: work)
    }

    /// Every dirty document with a path, not only the one on screen. Editing a
    /// tab and switching away from it used to leave the edit unwritten until
    /// you came back — which, with several tabs open, could be never.
    func runAutosave() {
        // Dirty with nowhere on disk to go — never saved, or saved to a file
        // that is not there any more — so it is written somewhere the next
        // launch can find it instead. The tab stays dirty on purpose: this is
        // not a save, and quit still has to ask.
        for tab in tabs where tab.dirty && !tab.hasFile {
            fetchText(tab.id) { text in
                guard let text = text, !tab.hasFile else { return }
                guard text != tab.scratchText else { return }
                // Empty is not worth insuring, and leaving the old file there
                // would offer back a page the writer has since cleared.
                if text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    tab.forgetScratch()
                    return
                }
                if Scratch.write(text, id: tab.scratchID) {
                    let first = tab.scratchText == nil
                    tab.scratchText = text
                    // Recorded once, when the buffer starts existing on disk,
                    // so a crash before the next tab change still finds it.
                    if first { self.saveSession() }
                }
            }
        }

        // `saving` excluded: a write already out is carrying this tab's text
        // and will reschedule if the text has moved on since. Queueing a second
        // one behind it would only write an older document later. `renaming`
        // excluded for the neighbouring reason: a rename finishes on disk a
        // moment before the tab hears about it, and a write issued in that
        // moment would create the name the document has just left. `hasFile`
        // is the same sentence about a document that has gone for good rather
        // than for a moment: it is above, being insured, not here being aimed
        // at a name nothing is at.
        for tab in tabs where tab.dirty && tab.hasFile && !tab.saving && !tab.renaming {
            guard let url = tab.url else { continue }
            fetchText(tab.id) { text in
                // Silent on failure: autosave runs unprompted, so an alert here
                // would interrupt typing. The file keeps its last good contents
                // and the next save tries again — but the failures are counted,
                // so a file that has stopped being writable says so rather than
                // going quiet behind a stale "saved 4m ago".
                guard let text = text else { return }
                // Renamed mid-flight, between asking the web layer for the text
                // and getting it back. Standardized like every other comparison
                // of two paths in this file: a /private prefix or a trailing
                // slash makes raw URL equality miss, and the miss here is a
                // write aimed at a name this document has left.
                guard tab.url?.standardizedFileURL == url.standardizedFileURL else { return }
                // Off main for the disk half. The coordinated write waits for
                // whatever else is holding the file, and this one runs on a
                // keystroke's schedule — blocking the thread the writer is
                // typing on to wait for Dropbox is the stall this whole change
                // exists to avoid causing.
                let generation = tab.edits
                self.writeFromAutosave(text, to: url, tab: tab) { ok in
                    guard ok else {
                        self.noteAutosave(tab, ok: false)
                        return
                    }
                    self.noteAutosave(tab, ok: true)
                    // Typed into while the write was in the air. What reached
                    // the disk is already behind the screen, so the document
                    // stays dirty and the next pass writes the rest of it.
                    guard tab.edits == generation else {
                        self.scheduleAutosave()
                        return
                    }
                    tab.dirty = false
                    self.window?.isDocumentEdited = self.tabs.contains { $0.dirty }
                    self.suddenTermination()
                    self.js("if(window.App)App.autoSaved(\(tab.id))")
                }
            }
        }
    }

    /// Brings the registered presenters into line with the tabs, whatever just
    /// happened to them. Reconciled rather than registered and unregistered at
    /// each of the seven places a tab can change, because the cost of missing
    /// one of those places is a presenter left registered on a file nobody has
    /// open — and the coordination machinery will keep asking it to flush.
    func syncPresenters() {
        for tab in tabs {
            let want = tab.url?.standardizedFileURL
            let have = tab.presenter?.currentURL.standardizedFileURL
            guard want != have else { continue }
            if let old = tab.presenter {
                NSFileCoordinator.removeFilePresenter(old)
                tab.presenter = nil
            }
            if let url = tab.url {
                let fresh = DocPresenter(url: url, owner: self)
                NSFileCoordinator.addFilePresenter(fresh)
                tab.presenter = fresh
            }
        }
    }

    /// The same reconciliation for the kernel watches, and a separate pass
    /// rather than three more lines inside the one above, because the two are
    /// answerable for different things: a presenter is process-wide state the
    /// coordination machinery holds on to, and a watch is a file descriptor.
    /// Both are wrong in the same way if a tab changes and nobody notices.
    func syncWatches() {
        for tab in tabs {
            let want = tab.url?.standardizedFileURL
            let have = tab.watch?.watching.standardizedFileURL
            guard want != have else { continue }
            tab.watch?.stop()
            tab.watch = nil
            guard let url = tab.url else { continue }
            // Weak on both sides. The tab owns the watch, the watch's handler
            // runs on its own queue long after any particular tab may have
            // gone, and this closure is the one place the two could hold each
            // other up.
            tab.watch = DocWatch(url: url) { [weak self, weak tab] in
                DispatchQueue.main.async {
                    guard let self = self, let tab = tab,
                          self.tabs.contains(where: { $0 === tab }) else { return }
                    tab.stirred = true
                    self.lookSoon()
                }
            }
        }
    }

    /// A look at every open document, soon, however many changes asked for it.
    ///
    /// The poll comes round on its own timer; this is what the kernel watch
    /// uses instead of calling straight into checkFileOnDisk. One event is one
    /// write() somebody made: a `git checkout` of a worktree with the folder
    /// open fires one per document — measured, 200 documents, 200 events — and
    /// each of those turning into a pass over every tab would be forty thousand
    /// passes, and a coordinated read per tab per pass. Measured through this:
    /// 200 stirs become one look, and the next 200 become one more.
    private func lookSoon() {
        guard !watchLookPending else { return }
        watchLookPending = true
        DispatchQueue.main.asyncAfter(deadline: .now() + kWatchSettle) { [weak self] in
            guard let self = self else { return }
            self.watchLookPending = false
            self.checkFileOnDisk()
        }
    }

    /// Everything one tab holds on the filesystem's behalf, let go of.
    ///
    /// Called where a tab leaves the strip, which is the one place the
    /// reconcilers above cannot help: they walk `tabs`, so a tab that is no
    /// longer in it is never visited and whatever it registered is never
    /// dropped. That is not hypothetical — measured, addFilePresenter takes a
    /// reference of its own and holds it, so until this existed every closed
    /// tab left a presenter registered on a file nobody had open, being asked
    /// to flush a document that was not there. A descriptor left open would be
    /// the same bug wearing a different hat.
    func releaseFileWatching(_ tab: DocTab) {
        if let p = tab.presenter {
            NSFileCoordinator.removeFilePresenter(p)
            tab.presenter = nil
        }
        tab.watch?.stop()
        tab.watch = nil
    }

    /// Every seat this app holds, given up. For quit: a presenter outliving the
    /// app it reports to would be asked to flush a document that no longer
    /// exists, and a descriptor outliving it is a descriptor.
    func dropFileWatching() {
        for tab in tabs { releaseFileWatching(tab) }
    }

    /// The file moved under an open tab — a Dropbox conflict rename, an iCloud
    /// restore, a `git checkout` swapping it into place. Following it rather
    /// than asking, because there is no question here that a person can answer
    /// better than the filesystem already has: this is where the document went.
    func documentMoved(_ presenter: DocPresenter, to newURL: URL) {
        guard let tab = tabs.first(where: { $0.presenter === presenter }) else { return }
        guard tab.url?.standardizedFileURL != newURL.standardizedFileURL else { return }
        // Trashed, which arrives here rather than as a deletion — measured:
        // trashItem is a move, and the only thing a presenter is told about it
        // is where the file went. This is the one move not to follow. Doing so
        // would leave the autosave writing into ~/.Trash every second, which is
        // the writer's work kept in the one folder that exists to be emptied
        // and a file they meant to delete refusing to stay deleted.
        //
        // The tab keeps the name it had rather than taking the Trash's, so a
        // file put back where it came from is found by the poll and simply
        // picked up again — no sheet, no Save As, the document carries on.
        // pushTabs is what moves the presenter off the Trash and back onto that
        // path to wait for it.
        guard !isInTrash(newURL) else {
            documentVanished(tab, why: Coordinated.gone(tab.url ?? newURL))
            pushTabs()
            return
        }
        tab.url = newURL
        tab.mark = fileMark(newURL)
        // Where it went is the answer to where it had gone. A bare `mv` reaches
        // here about a second after the fact — measured — which is often after
        // the write that was aimed at the old name has already been refused,
        // and sometimes after the poll has given the document up. Either way it
        // has a file again, so it saves again.
        documentFound(tab)
        NSDocumentController.shared.noteNewRecentDocumentURL(newURL)
        pushRecents()
        if tab.id == activeID { syncWindowToTab() }
        pushTabs()
        saveSession()
    }

    /// A coordinated delete, arriving from the presenter before the file goes
    /// rather than from the poll a moment after it has. The answer is the same
    /// one either way — there is a single place that decides what a document
    /// with no file means, and this is not it.
    ///
    /// It is not a verdict, either, and taking it for one was wrong. Measured,
    /// with the real presenter registered on a real file: a coordinated write
    /// taken with `.forReplacing` — which is what every atomic save declares,
    /// this app's own included — reaches a presenter as
    /// accommodatePresentedItemDeletion, before the write, exactly as a real
    /// deletion does. A plain coordinated write does not. So the callback that
    /// means "somebody is deleting your document" also means "somebody is
    /// saving your document from another editor", and nothing in it says which.
    /// Believing it made every outside save mark the document gone: the status
    /// bar said "not saving", the autosave went to the crash buffer, and ⌘S
    /// asked where to put the file — until the next poll found the file exactly
    /// where it had always been and quietly took it all back.
    ///
    /// What tells the two apart is the only thing that ever could: whether
    /// there is a file there afterwards. So this looks instead of concluding,
    /// with the same rule the poll uses and for the same reason — one look is
    /// not enough, and the numbers behind that are in noteMissing. What it buys
    /// over simply waiting for the poll is speed: a document that really was
    /// deleted is called gone within half a second rather than within four.
    ///
    /// Nothing is at risk in that half second. The thing that stops a save
    /// recreating a file somebody is deleting is not this flag, it is the
    /// write's own intent — a save of a document with nothing at its path is
    /// refused whenever it is issued.
    func documentDeleted(_ presenter: DocPresenter) {
        guard tabs.contains(where: { $0.presenter === presenter }) else { return }
        // The first look is far enough past the callback for the deletion to
        // have happened; the second is the gap goneForGood asks for, plus a
        // little, so that two looks finding nothing really are a verdict.
        for delay in [kFirstLookAfterDeletion,
                      kFirstLookAfterDeletion + kAbsentBeforeGone + 0.05] {
            DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in
                self?.checkFileOnDisk()
            }
        }
    }

    /// A look that found nothing at an open document's path.
    ///
    /// One miss is not a deletion, and getting that line wrong in either
    /// direction is a bug of its own. Draw it too eagerly and a stat that lost
    /// a race stops the app saving a file that is perfectly fine. Never draw it
    /// and the writing goes nowhere while the status bar says "saved 4m ago".
    ///
    /// So it was measured before it was chosen. An atomic replace leaves NO
    /// window at all: 400 replaces through this app's own writeToDisk, sampled
    /// 63,635 times by a tight stat loop, found the file missing exactly 0
    /// times — the swap ends in a rename, and a rename resolves to the old file
    /// or the new one, never to nothing. Same for String.write(atomically:),
    /// same for replaceItemAt. The one shape that does leave a window is a
    /// writer that removes the file and writes it again, which is neither
    /// atomic nor common, and that window measured 0.162ms at its longest.
    ///
    /// The line is therefore two separate looks, a quarter of a second or more
    /// apart, all of which found nothing — three orders of magnitude past the
    /// longest window anything can leave, and cheap enough to pay every poll.
    /// The windows this app makes for itself are not counted at all: a save in
    /// flight is a temporary file waiting to be swapped in, and a rename is a
    /// document between two names, and neither is the file having gone.
    private func noteMissing(_ tab: DocTab, at url: URL) {
        guard !tab.vanished else { return }
        guard !tab.saving, !tab.renaming else { return }
        tab.missingSince = tab.missingSince ?? Date()
        tab.missing += 1
        guard goneForGood(looks: tab.missing, since: tab.missingSince) else { return }
        documentVanished(tab, why: Coordinated.gone(url))
    }

    /// The file a document was open on is not there any more.
    ///
    /// Three things reach here: the poll, when it has looked twice and found
    /// nothing both times; a coordinated delete, the moment another process
    /// asks us to stand back from one; and a save that was refused because
    /// there was no document at the path to save into.
    ///
    /// What it does is small, and what it does not do is the point.
    ///
    /// The text on screen is not touched. It is the only copy of the newest
    /// sentence and this is the worst imaginable moment to reload anything over
    /// it. Nothing is written to that path either, now or a tick later:
    /// `hasFile` is false from here on, so the autosave stops aiming at the
    /// name, ⌘S asks where the document should go instead of putting the file
    /// back, and a coordinated reader asking us to flush is told there is
    /// nothing to flush. Recreating a file the writer or their tools took away
    /// is the two-files bug arriving by a politer door.
    ///
    /// And there is no sheet. An unprompted write may not take the keyboard
    /// away mid-sentence — that is why the autosave path is silent at all — and
    /// a document disappearing is exactly as unprompted as a save that failed.
    /// It goes to the surface a file that has stopped being writable already
    /// uses, and which was built for this weight: the status bar stops saying
    /// "saved 4m ago" and says "not saving" instead, in the trouble colour,
    /// with the whole sentence on hover and a toast on the way past. That is
    /// not quiet — it is a permanent change to the one part of the window a
    /// writer looks at to know whether their work is safe — and unlike a sheet
    /// it is still true, and still on screen, ten minutes later.
    ///
    /// The unsaved text goes where an untitled document's goes: the
    /// crash-insurance buffer in ~/…/minimark/unsaved/, kept up to date by the
    /// autosave for as long as the document has nowhere on disk to be, and
    /// offered back at the next launch. That is what scheduleAutosave is doing
    /// on the last line, and the whole reason a document with no file autosaves
    /// at all.
    func documentVanished(_ tab: DocTab, why: String) {
        tab.missing = 0
        tab.missingSince = nil
        guard !tab.vanished else { return }
        tab.vanished = true
        tab.lastSaveError = why
        tab.saveTroubleShown = true
        js("if(window.App&&App.saveTrouble)App.saveTrouble(\(tab.id),\(jsLiteral(why)))")
        scheduleAutosave()
    }

    /// There is a file at the document's path again.
    ///
    /// Called on every look that finds one, so it is also where a run of near
    /// misses is forgotten before it can add up to a verdict. If the document
    /// had been given up for gone, this is where it stops being: it writes to
    /// that path again, and whatever the file holds now goes through the same
    /// modification-date comparison as any other outside change — reloaded
    /// quietly when there is nothing unsaved here, asked about when there is.
    /// A `git checkout` onto a branch without this file and back again costs a
    /// line in the status bar and nothing else.
    func documentFound(_ tab: DocTab) {
        tab.missing = 0
        tab.missingSince = nil
        guard tab.vanished else { return }
        tab.vanished = false
        tab.saveTroubleShown = false
        tab.saveFailures = 0
        tab.lastSaveError = nil
        js("if(window.App&&App.saveTrouble)App.saveTrouble(\(tab.id),null)")
        scheduleAutosave()
    }

    /// Another process is about to read this file and has asked us to put what
    /// is unsaved on disk first. Writing now is what keeps a conflict from
    /// being made at all — the sync client uploads the sentence just typed
    /// rather than the one before it — and it is the same write the autosave
    /// would have done within the second anyway.
    ///
    /// `done` runs on every path, including the ones where there is nothing to
    /// write, because a writer somewhere is waiting on it.
    func flushForCoordination(_ url: URL, done: @escaping () -> Void) {
        let target = url.standardizedFileURL
        // `hasFile`, because a document whose file has gone has nothing to
        // flush: the other process is about to read a path this app already
        // knows is empty, and writing our text into it first would recreate the
        // name rather than answer the question. `done` still runs, because
        // somebody is waiting on it either way.
        guard let tab = tabs.first(where: { $0.url?.standardizedFileURL == target }),
              tab.dirty, tab.hasFile else { done(); return }
        fetchText(tab.id) { text in
            guard let text = text, let live = tab.url,
                  live.standardizedFileURL == target else { done(); return }
            self.write(text, to: live, silent: true, tab: tab) { ok in
                if ok {
                    self.noteAutosave(tab, ok: true)
                    tab.dirty = false
                    self.window?.isDocumentEdited = self.tabs.contains { $0.dirty }
                    self.suddenTermination()
                    self.js("if(window.App)App.autoSaved(\(tab.id))")
                } else {
                    self.noteAutosave(tab, ok: false)
                }
                done()
            }
        }
    }

    /// The backstop, and still needed with presenters registered and a
    /// descriptor on every open document. A presenter only hears from writers
    /// that coordinate; git, vim, sed and rsync do not, and they are most of
    /// what actually edits a markdown file behind an editor's back. What
    /// changed is that the poll is no longer the only way an outside change is
    /// noticed — a coordinated writer reaches checkFileOnDisk the moment it
    /// finishes, and the kernel says so for a document rewritten in place,
    /// rather than up to two seconds later and possibly mid-write.
    ///
    /// This does not shrink and must not. A vnode source needs a descriptor on
    /// a real file, which network mounts and virtual filesystems do not always
    /// give; a presenter needs the other process to be coordinating. The poll
    /// needs nothing but stat, which is the point of it — and it is also what
    /// re-arms a watch left on a file an atomic replace took away.
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
    ///
    /// A file that does not answer at all is its own case now. It used to share
    /// a line with a file that could not be statted this instant — `guard let
    /// now = modificationDate(url) else { continue }` — which meant a document
    /// that had been deleted was skipped over, silently, every two seconds, for
    /// as long as the app was open. See noteMissing for how the two are told
    /// apart and documentVanished for what happens once they are.
    ///
    /// And a file whose mark says nothing changed is not proof that nothing
    /// did. `stirred` is the kernel saying this document was rewritten in place
    /// since the last look, which is the one shape that can carry the old
    /// timestamp; it is a reason to look, not a verdict, and what comes back is
    /// compared against the tab's digest like anything else. See DocWatch.
    func checkFileOnDisk() {
        guard !reloadPromptUp else { return }
        for tab in tabs {
            guard let url = tab.url else { continue }
            guard let now = fileMark(url) else { noteMissing(tab, at: url); continue }
            // There is a file here, so whatever the last few looks thought is
            // forgotten — and if the document had been given up for gone, this
            // is where it stops being. Everything below runs as usual on the way
            // back, so a file that returns with different bytes is reloaded, or
            // asked about, exactly like any other outside change.
            documentFound(tab)
            // And a file here is also something to watch. An atomic replace —
            // anyone's — leaves the old descriptor on a file the path no longer
            // names, and the watch re-arms itself for that; this is the backstop
            // for the re-arm that happened while the path was empty. Costs a
            // branch on every look and a syscall only when it is actually
            // disarmed.
            tab.watch?.ensureArmed()
            guard let known = tab.mark else { tab.mark = now; tab.stirred = false; continue }
            guard now != known || tab.stirred else { continue }

            // A read of this tab is already out. Reads are unbounded, so a file
            // somebody is holding leaves one in the air for as long as they
            // like, and a poll that issued another every two seconds would
            // stack up a queue of them all landing at once — each carrying an
            // older copy of the document than the last.
            guard !tab.reading else { continue }

            // Nothing unsaved here, so there is nothing to decide: take the
            // new text, whether or not this is the document on screen.
            guard tab.dirty else {
                reread(tab, at: url, seenAt: now) { text in
                    // Unless somebody typed in it while the read was out. That
                    // was impossible when this was synchronous and it is one
                    // keystroke away now, and loading over it would throw away
                    // a sentence nobody has a copy of. Left unhandled on
                    // purpose: the next pass finds the tab dirty and asks.
                    guard !tab.dirty else { return false }
                    self.js("if(window.App)App.externalChange(\(jsLiteral(text)),\(tab.id))")
                    return true
                }
                continue
            }

            // Unsaved changes on both sides. Only the document in front gets
            // asked about, and the others keep their old modification date on
            // purpose — dropping it here would mark the change as handled and
            // the question would never be asked when you came back to the tab.
            guard tab.id == activeID, window?.isVisible == true else { continue }

            // Claimed before the read rather than after it, because the read is
            // out for as long as the other writer wants and the poll comes
            // round every two seconds. Without this the same change would ask
            // twice — or the second sheet would arrive on top of the first.
            reloadPromptUp = true
            reread(tab, at: url, seenAt: now) { text in
                // The window and the front tab were both checked on the way
                // out, and a read can be out for a while. Anything that has
                // changed since means there is no longer a question to ask, or
                // nobody in front of it to answer — so it goes unhandled and
                // the poll comes back to it rather than being stamped away.
                guard let window = self.window, window.isVisible,
                      tab.id == self.activeID, tab.dirty else { return false }
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
                    self.suddenTermination()
                    self.js("if(window.App)App.externalChange(\(jsLiteral(text)),\(tab.id))")
                }
                return true
            } otherwise: {
                // Nothing to ask about after all: the file would not settle, it
                // stopped being text, or the question stopped being one. The
                // claim has to go back or the poll is silenced for good.
                self.reloadPromptUp = false
            }
            return                              // one question at a time
        }
    }

    /// Read a document that has changed underneath its tab, and hand the text
    /// to whatever the caller does about it.
    ///
    /// Everything that has to be true on the way back lives here rather than in
    /// each caller, because the way back is now a different moment from the way
    /// out and every one of these has bitten something at some point. The tab
    /// may have been closed. It may have been renamed, or moved, or given up
    /// for gone, in which case this text belongs to a path it has left. It may
    /// have been typed in, which turns a quiet reload into a question — so that
    /// judgement is the caller's and is made when the text arrives, not when it
    /// was asked for.
    ///
    /// `use` says whether it did something with the text, and only then is the
    /// change written off as handled. A change the app looked at and decided
    /// not to act on this time is a change it still has to act on next time,
    /// and recording the date would lose the question for good.
    ///
    /// `seenAt` is the mark that triggered the read, and it is what gets
    /// recorded rather than the mark afterwards. If the file has moved on again
    /// since, the poll should come back for it, and stamping the newer mark
    /// would be saying this text is the newer file's.
    ///
    /// A read that could not be settled records nothing at all. That is the
    /// point of the whole exercise: the file is left looking changed, so the
    /// next poll asks again, rather than half of it being taken for all of it.
    ///
    /// And a file that was written but says the same thing never reaches `use`
    /// at all. That is not an optimisation, it is the difference between the
    /// kernel watch being an improvement and being a nuisance: the watch fires
    /// on a rewrite, not on a change, and a great deal of what rewrites a file
    /// writes the same bytes back. Reaching `use` with them would put "Reloaded
    /// from disk" in front of somebody typing, throw away a background tab's
    /// undo stack, or ask whether to discard unsaved work — over a document
    /// that says exactly what it said before. The look still counts as
    /// finished, because it was: this is what the file says and the tab now
    /// knows it.
    private func reread(_ tab: DocTab, at url: URL, seenAt: FileMark,
                        _ use: @escaping (String) -> Bool,
                        otherwise: (() -> Void)? = nil) {
        tab.reading = true
        readTextFile(url) { outcome in
            tab.reading = false
            guard case .text(let file) = outcome,
                  self.tabs.contains(where: { $0 === tab }),
                  tab.url?.standardizedFileURL == url.standardizedFileURL,
                  !tab.vanished else { otherwise?(); return }
            let digest = DocTab.digest(of: file.text)
            guard tab.digest != digest else {
                // The encoding is taken even so. Rewriting a file into another
                // encoding leaves the text identical and the bytes different,
                // and a save that did not know would quietly put it back the
                // way it was.
                tab.encoding = file.encoding
                tab.encodingGuessed = file.guessed
                tab.mark = seenAt
                tab.stirred = false
                otherwise?()
                return
            }
            guard use(file.text) else { otherwise?(); return }
            tab.encoding = file.encoding
            tab.encodingGuessed = file.guessed
            tab.mark = seenAt
            tab.stirred = false
            tab.digest = digest
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

    /// The formatting run at the bottom of the right-click menu. The same
    /// actions the selection bubble offers, because a writer who has just
    /// right-clicked a word is asking the same question the bubble answers,
    /// and having to go and find the bubble instead is the friction.
    func formattingMenuItems() -> [NSMenuItem] {
        let actions: [(String, String, String)] = [
            ("Bold",          "bold",   "b"),
            ("Italic",        "italic", "i"),
            ("Strikethrough", "strike", ""),
            ("Inline Code",   "code",   "e"),
            ("Link…",         "link",   "")
        ]
        return actions.map { title, name, key in
            let item = NSMenuItem(title: title, action: #selector(webCommand(_:)), keyEquivalent: key)
            // Shown, not armed. The real shortcut is already on the Format
            // menu; a second live copy inside a context menu would fire twice.
            item.keyEquivalentModifierMask = key.isEmpty ? [] : [.command]
            item.isEnabled = true
            item.target = self
            item.representedObject = name
            return item
        }
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
            self.openDocuments(panel.urls)
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

    // ------------------------------------------------------------------
    // Wikilinks
    //
    // [[Another note]] resolves to a file beside the one it was written in.
    // The shell does the resolving because the shell is the half that owns
    // the folder; the page knows a name and nothing else.
    //
    // A name is a filename and only a filename. No separators, no "..", no
    // leading dot, and it has to land in the document's own folder when it is
    // resolved — checked afterwards as well as before, because the two are
    // not the same question once the file system has had its say about
    // symlinks and case. A document is data, and data does not get to name a
    // path for the app to open.
    // ------------------------------------------------------------------

    /// The file a wikilink or an embed names, or nil if the name is not one
    /// this will touch. `.md` is added when there is no extension, which is
    /// what makes [[Another note]] rather than [[Another note.md]] the thing
    /// people write.
    ///
    /// A name may now descend: `chapters/one` resolves, because a manuscript
    /// keeps its chapters in a folder beside the book and an embed that cannot
    /// reach them is an embed nobody can write a book with. It may not climb,
    /// and it may not start anywhere but here — no leading slash, no `..`, no
    /// `~`, and no component that begins with a dot.
    ///
    /// The containment check afterwards is the one that actually decides, and
    /// it resolves symlinks on both sides before comparing. Widening the rule
    /// from one folder to a tree is exactly what makes a symlink out of that
    /// tree worth planting, and `standardizedFileURL` does not follow one.
    func wikiURL(_ raw: String) -> URL? {
        let name = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty, name.count < 1024,
              !name.hasPrefix("/"), !name.hasPrefix("~"),
              !name.contains(":"),                         // the other path separator
              !name.contains("\0"),
              !name.contains("\\"),
              let dir = docURL?.deletingLastPathComponent()
        else { return nil }

        // Every component in its own right: "." and ".." are refused wherever
        // they appear, not only at the front, and a dotfile stays unreachable
        // at any depth.
        let parts = name.split(separator: "/", omittingEmptySubsequences: false)
        guard parts.count <= 16 else { return nil }
        for part in parts {
            guard !part.isEmpty, !part.hasPrefix("."), part.count < 256 else { return nil }
        }

        var file = name
        if (name as NSString).pathExtension.isEmpty { file += ".md" }

        let base = dir.resolvingSymlinksInPath().standardizedFileURL
        let url = dir.appendingPathComponent(file).standardizedFileURL
        // Resolve what exists of the answer before comparing. A file that is
        // not there yet resolves to itself, which is what a wikilink about to
        // create one needs.
        let real = url.resolvingSymlinksInPath().standardizedFileURL
        guard real.path == base.path || real.path.hasPrefix(base.path + "/") else { return nil }
        return url
    }

    /// Which of these names have a file behind them. One reply per batch: the
    /// page asks once per render for everything it has not been told about,
    /// rather than once per link, which is what makes drawing a dead link
    /// differently affordable at all.
    ///
    /// A name this refuses to resolve — a path, a dotfile, anything with a
    /// separator in it — answers false rather than being left out. It is not a
    /// link that will ever open, and looking exactly like one that will is the
    /// thing being fixed.
    func answerWikiCheck(_ names: [String]) {
        // A document is data. It does not get to make the app stat an
        // unbounded list of paths because somebody pasted one in.
        let batch = names.prefix(kMaxWikiCheck)
        guard !batch.isEmpty else { return }
        let fm = FileManager.default
        var out: [String: Bool] = [:]
        for name in batch {
            guard let url = wikiURL(name) else { out[name] = false; continue }
            out[name] = fm.fileExists(atPath: url.path)
        }
        guard let data = try? JSONSerialization.data(withJSONObject: out, options: []),
              let json = String(data: data, encoding: .utf8) else { return }
        js("if(window.App&&App.setWikiTargets)App.setWikiTargets(\(json))")
    }

    /// The text behind each embedded name. One reply per batch, like the
    /// check above, and for the same reason.
    ///
    /// Every failure answers with a reason rather than being left out. An
    /// embed that says nothing at all is indistinguishable from one still on
    /// its way, and the writer is left looking at a placeholder forever.
    func answerEmbedRead(_ names: [String]) {
        let batch = names.prefix(kMaxEmbedRead)
        guard !batch.isEmpty else { return }
        let fm = FileManager.default
        var out: [String: [String: Any]] = [:]

        for name in batch {
            guard let url = wikiURL(name) else { out[name] = ["error": "outside"]; continue }

            var isDir: ObjCBool = false
            guard fm.fileExists(atPath: url.path, isDirectory: &isDir), !isDir.boolValue else {
                out[name] = ["error": "missing"]; continue
            }
            // Asked before reading, so a video somebody dropped in the folder
            // is refused rather than pulled into memory to be refused.
            if let attrs = try? fm.attributesOfItem(atPath: url.path),
               let size = attrs[.size] as? Int, size > kMaxEmbedBytes {
                out[name] = ["error": "too-big"]; continue
            }

            // The document's own decoder, so an embedded file in Latin-1 reads
            // as it would in a tab, and a binary one is refused by the same
            // check that stops a tab opening it. Uncoordinated, unlike a tab:
            // this is a read of somebody else's file on the render path, and a
            // file coordinator's wait belongs nowhere near that. The worst a
            // torn read costs here is one stale embed until the next render.
            guard let text = decodeTextFile(url)?.text else {
                out[name] = ["error": "unreadable"]; continue
            }
            out[name] = ["text": text]
        }

        guard let data = try? JSONSerialization.data(withJSONObject: out, options: []),
              let json = String(data: data, encoding: .utf8) else { return }
        js("if(window.App&&App.setEmbeds)App.setEmbeds(\(json))")
    }

    func openWikilink(_ name: String) {
        guard let url = wikiURL(name) else {
            // An untitled document has no folder for a link to be relative to,
            // which is the common way to arrive here and worth saying plainly
            // rather than doing nothing.
            if docURL == nil {
                presentError("Nothing to link from",
                             "Save this document first. A wikilink points at a file "
                             + "beside it, and an unsaved document is not beside anything yet.")
            } else {
                presentError("Not a file name",
                             "“\(name)” cannot be used as a wikilink. A wikilink names a file "
                             + "in the same folder, without a path.")
            }
            return
        }

        if FileManager.default.fileExists(atPath: url.path) {
            openDocument(at: url)
            return
        }

        // Creating it is the useful thing to do and the whole reason people
        // write a link to a note they have not written yet. It still asks,
        // because a click that silently writes a file to disk is not something
        // to do on the strength of one click.
        let alert = NSAlert()
        alert.messageText = "Create “\(url.lastPathComponent)”?"
        alert.informativeText = url.deletingLastPathComponent().path
            == docURL?.deletingLastPathComponent().path
            ? "There is no file by that name in this folder yet."
            : "There is no file by that name in “\(url.deletingLastPathComponent().lastPathComponent)” yet. "
              + "That folder has to exist already."
        alert.addButton(withTitle: "Create")
        alert.addButton(withTitle: "Cancel")
        let make: (NSApplication.ModalResponse) -> Void = { [weak self] response in
            guard let self = self, response == .alertFirstButtonReturn else { return }
            // Coordinated like every other write to a document folder: the
            // file is being created in the same directory a sync client is
            // watching, and it is about to be opened straight back. Asynchronous
            // like every other coordinated write, so a folder somebody else is
            // busy in cannot freeze the click that made this file.
            var failure: Error?
            Coordinated.write(url, intent: .create, { u in
                do { try "".write(to: u, atomically: true, encoding: .utf8) }
                catch { failure = error }
            }, then: { error in
                if let why = error ?? failure {
                    self.presentError("Could not create “\(url.lastPathComponent)”",
                                      why.localizedDescription)
                    return
                }
                // Every document holding a link to this name has just stopped
                // being wrong about it, and so has every embed of it. Both are
                // cached per folder in the page, so both have to be dropped
                // rather than waited out.
                self.js("if(window.App&&App.forgetWikiTargets)App.forgetWikiTargets()")
                self.js("if(window.App&&App.forgetEmbeds)App.forgetEmbeds()")
                self.openDocument(at: url)
            })
        }
        if let w = window, w.isVisible {
            alert.beginSheetModal(for: w, completionHandler: make)
        } else {
            make(alert.runModal())
        }
    }

    /// Four libraries do work in here that this app does not do itself, and
    /// three of them are the reason it can render anything at all. Naming them
    /// is a licence condition for all four, and it belongs somewhere a person
    /// can find it rather than only in a file in the repository.
    ///
    /// Versions are the ones vendored in Resources/vendor, read off their own
    /// banners rather than remembered. Turndown ships without one, so it is
    /// listed without a version rather than with a guessed one.
    @objc func menuAcknowledgements(_ sender: Any?) {
        let alert = NSAlert()
        alert.messageText = "Acknowledgements"
        alert.informativeText = """
            minimark is built on work other people gave away.

            marked 12.0.2 — MIT
            Christopher Jeffrey and contributors
            github.com/markedjs/marked

            Turndown — MIT
            Dom Christie
            github.com/mixmark-io/turndown

            highlight.js 11.11.1 — BSD 3-Clause
            Ivan Sagalaev and contributors
            github.com/highlightjs/highlight.js

            KaTeX 0.16.47 — MIT
            Khan Academy and contributors
            github.com/KaTeX/KaTeX

            The full licence text for each ships in NOTICES beside the app's             source. Their fonts and stylesheets are included unmodified.
            """
        alert.addButton(withTitle: "OK")
        if let w = window, w.isVisible {
            alert.beginSheetModal(for: w, completionHandler: nil)
        } else {
            alert.runModal()
        }
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
        // Named for what it opens. Called "Settings…" it promised a settings
        // window and delivered a 240px appearance popover out of the far
        // bottom-left corner, with nothing connecting the keypress to the
        // corner it came from. Appearance is genuinely all there is to set, so
        // the honest name is the smaller change and the better one. ⌘, stays:
        // it is where a Mac user's hand goes, and it now arrives somewhere the
        // menu said it would.
        add(app, "Appearance…", key: ",", command: "themes")
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
        // The level the focus lands on. ⌃⌥D cycles the two in the web layer;
        // these are here so both are reachable by name rather than by guessing
        // which way a toggle will go.
        add(view, "Focus: Paragraph", command: "focusParagraph")
        add(view, "Focus: Sentence", key: "d", mods: [.control, .option], command: "focusSentence")
        add(view, "Typewriter", key: "t", mods: [.command, .shift], command: "typewriter")
        // ⌃⌥S rather than anything with ⌘⇧ in it: ⇧⌘S is Save As, and the
        // other view toggles that are not about the document itself already
        // live under ⌃⌥ — Zen is ⌃⌥Z and keeping tabs showing is ⌃⌥T.
        add(view, "Style Check", key: "s", mods: [.control, .option], command: "styleCheck")
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
        help.addItem(.separator())
        add(help, "Acknowledgements…", action: #selector(menuAcknowledgements(_:)))

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
