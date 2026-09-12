#!/usr/bin/env node
/* ============================================================
   minimark — file coordination tests

   The likely home for a folder of markdown is iCloud Drive, Dropbox, or a git
   worktree, which makes "something else is writing this file right now" the
   default deployment rather than an edge case. Until this landed, nothing in
   the app used NSFileCoordinator or NSFilePresenter at all: a two second mtime
   poll raced a one second autosave, and a read that happened to land mid-sync
   returned half a document — which the autosave then wrote back over the whole
   one a second later.

   Seven things have to hold:

   1. A coordinated write actually takes the file. Two writers going at the
      same path take turns rather than interleaving, so nobody ever sees a
      half-written document.

   2. A coordinated read waits for a writer that is already in progress, so a
      file being written is read after that write rather than during it — and
      it waits however long that takes, without a thread waiting with it. This
      is the assertion that used to say two seconds and then read anyway.
      Measured, against a holder putting a 401-line document down in place
      under a proper coordinated write: the wait timed out, the fallback read
      uncoordinated, and 240 lines came back as the whole file, after freezing
      the caller for 2004ms to get them. Half a document read into a tab is
      half a document the autosave writes back a second later.

   3. A write NEVER goes in without the claim, and no thread waits for one.
      This is the assertion that used to say the opposite. The write was on a
      bounded wait, and going over the bound ran the same write uncoordinated:
      measured, that blocked its caller — main, for ⌘S and for the presenter
      flush — for 2098ms and then destroyed the bytes of a process that was
      still holding the file and had been told nothing. The wait is now
      unbounded and asynchronous, so a contended save lands after the other
      writer rather than over them, and nothing freezes while it waits. The
      worry that produced the old fallback is answered by insurance rather
      than by barging in: see insureSlowSave in minimark.swift.

   4. A save keeps what the filesystem knew about the file it replaced. Finder
      tags and Finder comments are extended attributes; the creation date is
      when the document came into being, not when it was last saved. An atomic
      write to a fresh file destroys all of it, and it was doing exactly that
      on every autosave.

   5. A save cannot land on a name the document has left. This one is the bill
      for 3: once a write can be in the air for as long as another writer likes,
      it can still be in the air when the document is renamed, and the path it
      was aimed at is no longer the document. Measured, before this: the rename
      was on a bounded wait, timed out, moved a file another process was holding
      — moveItem refuses an existing destination, but nothing in it protects the
      source — and the pending write then recreated the name the rename had just
      emptied. Two files, the newest text in the one nobody is looking at, and
      the app saying "saved". The rename is unbounded now too, which is what
      lets the coordinator order the two and announce the move to the write
      still waiting; and a move nothing announced, which no coordinator can
      follow, is refused rather than guessed at.

   6. And it cannot land there one tick later either. 5 protected the write that
      was already in the air when the document moved, by asking the disk whether
      there had been a file at the path when the write was issued. That question
      has nothing to say about the NEXT write, which is issued fresh at a path
      that is already empty: measured, a bare mv followed by one autosave tick
      recreated the old name and left two files again, three milliseconds later.
      The disk cannot answer this. A path with nothing at it is a Save As about
      to make a file and a document that has been deleted, and the two look
      identical from outside. So the caller says which it is — Coordinated.Intent
      — and a save of a document that is not there is refused however long ago
      it stopped being there.

   7. And a read of a file nobody is coordinating over still never returns half
      of it. Waiting is only an answer for writers that are in the coordination;
      git, cp and `rsync --inplace` are not, and writing in place is the one
      shape that can be read torn. So the read checks: it takes the file's size
      and modification date around itself, starts over if they moved, and will
      not believe a file that was written moments ago until it has been left
      alone. It may wait a writer out or refuse — both are answers — but part of
      a document handed back as though it were all of it is not.

   Like the encoding and unsaved tests, this cannot be a browser test: it is
   Swift, and it is about two processes reaching for one file. So it compiles
   the real Coordinated helper — and the real writeToDisk, staging and all —
   out of minimark.swift into a throwaway binary and runs actual contention
   through it: a second process holding a real coordinated write while this one
   tries to get in. Extracted rather than copied, because a copy is worthless
   the moment the two drift.

   Usage:  node tools/coordination-test.js [swiftFile]
   ============================================================ */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawn } = require('child_process');

const swiftFile = process.argv[2] || path.resolve(__dirname, '..', 'minimark.swift');
const src = fs.readFileSync(swiftFile, 'utf8');

let passed = 0, failed = 0;
const ok = (name, cond, detail) => {
  if (cond) { passed++; console.log(`  ok    ${name}`); }
  else { failed++; console.log(`  FAIL  ${name}${detail ? '\n        ' + detail : ''}`); }
};

/* Braces balanced from the declaration, so the harness cannot quietly test a
   stale copy of anything. */
function extract(name) {
  const at = src.indexOf(name);
  if (at < 0) throw new Error(`could not find ${name} in ${swiftFile}`);
  const start = src.lastIndexOf('\n', at) + 1;
  let i = src.indexOf('{', at), depth = 0;
  for (let j = i; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}' && --depth === 0) return src.slice(start, j + 1);
  }
  throw new Error(`unbalanced braces after ${name}`);
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-coord-'));
const bin = path.join(dir, 'coord');

/* The harness is the app's own Coordinated, its own writeToDisk and its own
   timeout, plus a handful of commands to drive them from the outside. Nothing
   here reimplements any part of what is being tested. writeToDisk and the two
   helpers underneath it are static members of AppDelegate, so they are lifted
   into an enum of their own rather than rewritten. */
const harness = `
import Foundation
${/* Balancing braces from a `let` with none of its own runs on to the end of
      the next block, so this one arrives with the rest of the constants block
      — kWatchSettle, kLooksBeforeGone and kAbsentBeforeGone among them — in
      tow. Asking for those by name as well would declare them twice. */
   extract('let kAutosaveDelay')}
${extract('struct FileMark')}
${extract('func fileMark')}
${extract('func isInTrash')}
${extract('func goneForGood')}
${extract('enum Coordinated')}
${extract('final class OnceHandler')}
${extract('final class DocPresenter')}
${extract('final class DocWatch')}
${extract('    enum WriteOutcome')}
enum Disk {
${extract('    private static func carryXattrs')}
${extract('    private static func replaceContents')}
${extract('    static func writeToDisk')}
}

/* The crash-insurance folder, which a DocTab drops a buffer into and which has
   nothing to do with anything below. Stubbed for the same reason AppDelegate is
   stubbed: so that the DocTab under test is the app's own and not a copy of it. */
enum Scratch { static func remove(_ id: String) {} }
${extract('final class DocTab')}

/* Everything DocPresenter asks of the app it reports to, and nothing else, so
   the real presenter compiles and runs here without an NSApplication under it.
   It counts rather than acts: what is being tested is which of these the
   presenter calls, and which it does not. */
final class AppDelegate {
    var deletions = 0
    var flushes = 0
    var changes = 0
    var movedTo: String?
    func checkFileOnDisk() { changes += 1 }
    func documentMoved(_ p: DocPresenter, to newURL: URL) { movedTo = newURL.path }
    func flushForCoordination(_ url: URL, done: @escaping () -> Void) { flushes += 1; done() }
    func documentDeleted(_ p: DocPresenter) { deletions += 1 }

    /* The app's own coalescer, lifted in whole, because a storm of stirs is the
       one thing a folder of open documents can turn into: something rewriting a
       whole worktree fires one event per document — measured, 200 documents,
       200 wakeups — and each of those turning into a pass over every tab would
       be 40,000. \`private\` reaches the enclosing type and not the file's top
       level, hence the one line of wrapper. */
    var watchLookPending = false
${extract('    private func lookSoon')}
    func askForALook() { lookSoon() }
}

/* A presenter that DOES implement the NSFileVersion callbacks DocPresenter
   leaves out, registered alongside the real one so that the app's silence about
   versions can be told apart from a test that failed to make anything happen.
   The instrument has to be shown working before a zero from it means anything.

   presentedItemDidLose reads the version's URL through the Objective-C accessor
   rather than as a Swift URL, and that is not fussiness. The version handed to
   that callback has had its storage deleted already, so its URL is nil — while
   NSFileVersion.h declares the property nonnull and mentions the nil only in
   prose. The obvious one-liner traps in URL._unconditionallyBridgeFromObjectiveC,
   on the presenter's operation queue. Which is measured below rather than
   asserted here in a comment. */
final class VersionSpy: NSObject, NSFilePresenter {
    private let url: URL
    private let q: OperationQueue
    var gained = 0
    var lost = 0
    var lostWithNilURL = 0
    init(url: URL) {
        self.url = url
        self.q = OperationQueue()
        q.maxConcurrentOperationCount = 1
        q.qualityOfService = .userInitiated
        super.init()
    }
    var presentedItemURL: URL? { url }
    var presentedItemOperationQueue: OperationQueue { q }
    func presentedItemDidGain(_ version: NSFileVersion) { gained += 1 }
    func presentedItemDidLose(_ version: NSFileVersion) {
        lost += 1
        if (version as NSObject).value(forKey: "URL") == nil { lostWithNilURL += 1 }
    }
    func presentedItemDidResolveConflict(_ version: NSFileVersion) { }
}

let args = CommandLine.arguments
let url = URL(fileURLWithPath: args[2])

/// The one thing the disk cannot answer, spelled the way the tests spell it.
func intentNamed(_ s: String) -> Coordinated.Intent { s == "create" ? .create : .update }

// Every coordinated write is asynchronous now, and the app it lives in is an
// app: main keeps turning while a write is out. So this keeps turning too, or
// the answer would have nowhere to land. It is also the condition a blocking
// write would break, which is half of what is being tested.
func pump(_ sem: DispatchSemaphore) {
    while sem.wait(timeout: .now()) == .timedOut {
        RunLoop.main.run(mode: .default, before: Date().addingTimeInterval(0.02))
    }
}

// ---------------------------------------------------------------- the watch
//
// The poll compares a mark taken from stat, and there is one shape of change no
// mark taken from stat can see: a writer that rewrites the bytes through the
// file's own inode and leaves the timestamp where it was. \`touch -r\` and
// everything shaped like it — a tool that snapshots the times around an
// in-place edit and puts them back — and, more to the point, ANY in-place write
// on a volume whose modification dates are coarse. Measured: HFS+ and MS-DOS
// stamp the date to the whole second, and 40 of 40 back-to-back rewrites of one
// file on an HFS+ image left it byte for byte identical.
//
// \`cp -p\` is the obvious example and it is the wrong one: measured, it stamps
// the SOURCE's timestamp onto the destination rather than restoring the
// destination's, so it usually moves the mark and the poll sees it.
//
// So there is a kevent on a descriptor beside the poll. These cases drive the
// app's own DocWatch, on the app's own DocTab, and use the app's own mark and
// digest to decide what a stir means. Everything the harness owns is the
// outside writer and the clock.

/// The restore itself: capture the timespec with nanoseconds, rewrite through
/// the inode, put the times back. Going through Date rounds,
/// and a rounded restore leaves a mark the poll CAN see — which would make
/// every assertion below prove the opposite of what it is for. It reports
/// whether the restore really took, and the tests refuse to conclude anything
/// from a run where it did not.
@discardableResult
func rewriteKeepingTime(_ u: URL, _ text: String) -> Bool {
    var was = stat()
    guard stat(u.path, &was) == 0 else { return false }
    let keepA = was.st_atimespec, keepM = was.st_mtimespec
    guard let h = try? FileHandle(forWritingTo: u) else { return false }
    h.seek(toFileOffset: 0)
    h.write(Data(text.utf8))
    try? h.close()
    var times = [keepA, keepM]
    guard utimensat(AT_FDCWD, u.path, &times, 0) == 0 else { return false }
    var back = stat()
    return stat(u.path, &back) == 0
        && back.st_mtimespec.tv_sec == keepM.tv_sec
        && back.st_mtimespec.tv_nsec == keepM.tv_nsec
}

/// Wait by turning the run loop rather than by sleeping on it. A watch hands
/// its news to main, which is what syncWatches does with it, so a test that
/// slept would leave every stir queued behind itself and then report that
/// nothing happened. It also means every count below is read on the same thread
/// it was written on.
func turn(_ seconds: TimeInterval) {
    let until = Date().addingTimeInterval(seconds)
    while Date() < until {
        RunLoop.main.run(mode: .default, before: Date().addingTimeInterval(0.02))
    }
}

/// A tab on a real file with the app's own watch armed on it, wired the way
/// syncWatches wires one: on to main, and then \`tab.stirred = true\`. The
/// coalesced look is the only part left out, because there is no AppDelegate
/// here to take it.
func watched(_ u: URL, _ text: String, _ count: @escaping () -> Void) -> DocTab {
    let tab = DocTab(id: 1, url: u)
    tab.digest = DocTab.digest(of: text)
    tab.watch = DocWatch(url: u) { [weak tab] in
        DispatchQueue.main.async {
            tab?.stirred = true
            count()
        }
    }
    turn(0.3)
    tab.stirred = false
    return tab
}

/// checkFileOnDisk's own question, asked of the tab's own mark.
func markMoved(_ tab: DocTab, _ u: URL) -> Bool {
    guard let now = fileMark(u), let known = tab.mark else { return true }
    return now != known
}
/// And reread's, asked of the tab's own digest.
func fileDiffers(_ tab: DocTab, _ u: URL) -> Bool {
    guard let text = try? String(contentsOf: u, encoding: .utf8) else { return false }
    return tab.digest != DocTab.digest(of: text)
}

let sameLengthA = "the quick brown fox jumps over the lazy dog AAAA\\n"
let sameLengthB = "the quick brown fox jumps over the lazy dog BBBB\\n"
let sameLengthC = "the quick brown fox jumps over the lazy dog CCCC\\n"

switch args[1] {

// Take a coordinated write and sit on it for args[3] seconds, so the other
// process has something real to contend with. Prints "held" once the claim is
// actually taken, which is what the test waits for rather than sleeping and
// hoping — and, on the way out, what is on disk at the moment it lets go.
// That last line is the whole point: if anybody wrote here while this held the
// file, these bytes are not the ones it put there.
case "hold":
    let seconds = Double(args[3]) ?? 1.0
    let heldSem = DispatchSemaphore(value: 0)
    Coordinated.write(url, { u in
        try? "held".write(to: u, atomically: true, encoding: .utf8)
        print("held")
        fflush(stdout)
        Thread.sleep(forTimeInterval: seconds)
        print("released\\t" + ((try? String(contentsOf: u, encoding: .utf8)) ?? "?"))
        fflush(stdout)
    }, then: { _ in heldSem.signal() })
    pump(heldSem)

// One coordinated write, reporting whether the claim was granted, how many
// times the body ran, how long the whole thing took, and — the number the old
// fallback got wrong — how long the CALLER was held up before it could get on
// with something else. Exactly once is the contract, whichever way it went.
case "write":
    var runs = 0
    var granted = false
    let start = Date()
    let sem = DispatchSemaphore(value: 0)
    Coordinated.write(url, { u in
        runs += 1
        try? args[3].write(to: u, atomically: true, encoding: .utf8)
    }, then: { error in
        granted = error == nil
        sem.signal()
    })
    let issued = Int(Date().timeIntervalSince(start) * 1000)
    pump(sem)
    print("\\(granted ? "coordinated" : "uncoordinated")\\t\\(runs)\\t\\(Int(Date().timeIntervalSince(start) * 1000))\\t\\(issued)")

// One coordinated read. Asynchronous now, like the write, so what is worth
// reporting is what came back, whether the caller was held while it waited, and
// that the answer arrived on main. A read that could not be settled hands back
// nothing at all and says why, which is the whole point of it.
case "read":
    var saw = ""
    var why = "nil"
    var readOnMain = false
    let start = Date()
    let sem = DispatchSemaphore(value: 0)
    Coordinated.read(url, presenter: nil, { u -> String? in
        try? String(contentsOf: u, encoding: .utf8)
    }, then: { text, error in
        readOnMain = Thread.isMainThread
        saw = text ?? ""
        why = error?.localizedDescription ?? "nil"
        sem.signal()
    })
    let issued = Int(Date().timeIntervalSince(start) * 1000)
    pump(sem)
    print("\\(why == "nil" ? "read" : "refused")\\t\\(issued)"
          + "\\t\\(readOnMain ? "main" : "off-main")\\t\\(saw)\\t\\(why)")

// The shape this whole round exists for. Somebody takes a PROPER coordinated
// write and rewrites the document in place, slowly — a big file being put down,
// a sync client materialising one. A read is taken while that is happening.
//
// Measured before this: the read's bounded wait timed out, its fallback read
// the file uncoordinated, and 240 lines of a 401-line document came back as the
// whole file, after holding the caller for 2004ms to get them. Both halves are
// asserted here, because both were wrong. args[3] is how long the holder takes.
case "readheld":
    let complete = (1...400).map { "line \\($0)\\n" }.joined() + "END\\n"
    try? complete.write(to: url, atomically: true, encoding: .utf8)
    let pace = (Double(args[3]) ?? 2.0) / 10.0
    let heldDone = DispatchSemaphore(value: 0)
    DispatchQueue.global().async {
        let c = NSFileCoordinator(); var e: NSError?
        c.coordinate(writingItemAt: url, options: .forReplacing, error: &e) { u in
            FileManager.default.createFile(atPath: u.path, contents: Data())
            guard let h = try? FileHandle(forWritingTo: u) else { return }
            for i in 1...400 {
                h.write("line \\(i)\\n".data(using: .utf8)!)
                if i % 40 == 0 { Thread.sleep(forTimeInterval: pace) }
            }
            h.write("END\\n".data(using: .utf8)!)
            try? h.close()
        }
        heldDone.signal()
    }
    Thread.sleep(forTimeInterval: 0.15)
    var held = ""
    let heldStart = Date()
    let heldSem = DispatchSemaphore(value: 0)
    Coordinated.read(url, presenter: nil, { u -> String? in
        try? String(contentsOf: u, encoding: .utf8)
    }, then: { text, _ in held = text ?? ""; heldSem.signal() })
    let heldIssued = Int(Date().timeIntervalSince(heldStart) * 1000)
    pump(heldSem)
    heldDone.wait()
    print("\\(held.split(separator: "\\n").count)\\t\\(held.contains("END"))\\t\\(heldIssued)")

// The half coordination cannot reach: a writer that is not in it at all —
// git, cp, rsync --inplace — rewriting the document in place a chunk at a time.
// Nothing can make that writer wait, so the read has to be able to tell that
// what it pulled out of the file is only part of it. args[3] is the writer's
// pause between chunks in milliseconds, which is the axis this is judged on.
case "readtorn":
    let seed = (1...400).map { "line \\($0)\\n" }.joined() + "END\\n"
    try? seed.write(to: url, atomically: true, encoding: .utf8)
    let gap = (Double(args[3]) ?? 20) / 1000.0
    let tornDone = DispatchSemaphore(value: 0)
    DispatchQueue.global().async {
        FileManager.default.createFile(atPath: url.path, contents: Data())
        guard let h = try? FileHandle(forWritingTo: url) else { tornDone.signal(); return }
        for i in 1...400 {
            h.write("line \\(i)\\n".data(using: .utf8)!)
            if i % 40 == 0 { Thread.sleep(forTimeInterval: gap) }
        }
        h.write("END\\n".data(using: .utf8)!)
        try? h.close()
        tornDone.signal()
    }
    Thread.sleep(forTimeInterval: gap * 3)
    var torn = ""
    var tornWhy = "nil"
    let tornSem = DispatchSemaphore(value: 0)
    Coordinated.read(url, presenter: nil, { u -> String? in
        try? String(contentsOf: u, encoding: .utf8)
    }, then: { text, error in
        torn = text ?? ""
        tornWhy = error?.localizedDescription ?? "nil"
        tornSem.signal()
    })
    pump(tornSem)
    tornDone.wait()
    let verdict = torn.isEmpty ? "nothing" : (torn.contains("END") ? "whole" : "partial")
    print("\\(verdict)\\t\\(torn.split(separator: "\\n").count)\\t\\(tornWhy)")

// The shape every save now uses: the disk half wherever the coordinator puts
// it, the answer handed back on main. Nothing blocks a thread any more, so
// what is worth proving is that the answer still arrives — on main, once, with
// the text really on disk — while main is busy turning, which is the condition
// the app is actually in and exactly what a blocking write would break.
case "writeasync":
    var runs = 0
    var onMain = false
    var landed = false
    let sem = DispatchSemaphore(value: 0)
    Coordinated.write(url, { u in
        runs += 1
        try? args[3].write(to: u, atomically: true, encoding: .utf8)
    }, then: { error in
        onMain = Thread.isMainThread
        landed = error == nil
        sem.signal()
    })
    pump(sem)
    print("\\(landed ? "coordinated" : "uncoordinated")\\t\\(runs)\\t\\(onMain ? "main" : "off-main")")

// A whole save through the app's own writeToDisk — the encoding decision, the
// coordination, the staging file and the metadata carried across it — so the
// test can stat the file afterwards and see what a save costs the writer.
case "save":
    let sem = DispatchSemaphore(value: 0)
    var said = ""
    Disk.writeToDisk(args[3], to: url, encoding: .utf8,
                     intent: intentNamed(args[4]), presenter: nil) { outcome, landed in
        switch outcome {
        case .wrote(let promoted): said = (promoted ? "promoted" : "wrote") + "\\t" + landed.lastPathComponent
        case .failed(let why):     said = "failed\\t" + why
        case .vanished(let why):   said = "vanished\\t" + why
        }
        sem.signal()
    }
    pump(sem)
    print(said)

// A rename, which is two coordinations taken together. Asynchronous like the
// write, so what is worth reporting is that the caller was not held while it
// waited and that the answer came back.
case "move":
    let dest = URL(fileURLWithPath: args[3])
    var runs = 0
    var granted = false
    let start = Date()
    let sem = DispatchSemaphore(value: 0)
    Coordinated.move(from: url, to: dest, { a, b in
        runs += 1
        do { try FileManager.default.moveItem(at: a, to: b); return nil } catch { return error }
    }, then: { error in
        granted = error == nil
        sem.signal()
    })
    let issued = Int(Date().timeIntervalSince(start) * 1000)
    pump(sem)
    print("\\(granted ? "coordinated" : "uncoordinated")\\t\\(runs)\\t\\(issued)")

// A rename issued while one of this process's own writes is still in the air
// on the old name — the shape that used to end with two files. Both go to the
// same document, so both have to be in one process; the file they contend for
// is held by another. args[3] is the new name, args[4] the text the pending
// write carries, args[5] which of the two is asked for first.
//
// Reported: the name the write's body actually ran against, and what each of
// the two had to say. The point of the second order is that a write asked for
// while a rename is already waiting must follow the document rather than
// recreate the name it left.
case "renamerace":
    let dest = URL(fileURLWithPath: args[3])
    let text = args[4]
    var landedOn = "never"
    var wroteSaid = "nil", movedSaid = "nil"
    let w = DispatchSemaphore(value: 0), m = DispatchSemaphore(value: 0)
    let issueWrite = {
        Coordinated.write(url, { u in
            landedOn = u.lastPathComponent
            try? text.write(to: u, atomically: true, encoding: .utf8)
        }, then: { e in wroteSaid = e?.localizedDescription ?? "nil"; w.signal() })
    }
    let issueMove = {
        Coordinated.move(from: url, to: dest, { a, b in
            do { try FileManager.default.moveItem(at: a, to: b); return nil } catch { return error }
        }, then: { e in movedSaid = e?.localizedDescription ?? "nil"; m.signal() })
    }
    let started = Date()
    if args[5] == "move-first" { issueMove(); Thread.sleep(forTimeInterval: 0.3); issueWrite() }
    else                       { issueWrite(); Thread.sleep(forTimeInterval: 0.3); issueMove() }
    // Neither call may have held this thread: 300ms is the sleep above and
    // nothing else, however long the two of them go on waiting for the file.
    let issued = Int(Date().timeIntervalSince(started) * 1000)
    pump(w); pump(m)
    print("\\(landedOn)\\t\\(wroteSaid)\\t\\(movedSaid)\\t\\(issued)")

// The same document moved out from under a pending write by something that
// does not coordinate — mv, git mv, an editor that renames without asking.
// No coordinator can follow that, so the write has nowhere to redirect to and
// must refuse rather than recreate the name the document left.
case "writeuncoordmove":
    let dest = URL(fileURLWithPath: args[3])
    var runs = 0
    var said = "nil"
    let sem = DispatchSemaphore(value: 0)
    Coordinated.write(url, { u in
        runs += 1
        try? args[4].write(to: u, atomically: true, encoding: .utf8)
    }, then: { e in said = e?.localizedDescription ?? "nil"; sem.signal() })
    Thread.sleep(forTimeInterval: 0.3)
    try? FileManager.default.moveItem(at: url, to: dest)
    pump(sem)
    print("\\(runs)\\t\\(said)")

// The tick after that one. The document is moved away FIRST, and only then does
// the next autosave issue its write — at the path the app still believes in,
// with nothing at it, nothing in flight, and no race left to lose. This is the
// shape that recreated the old name three milliseconds after a bare mv, and the
// one a stat taken when the write was issued has nothing to say about.
// args[3] is where the document went, args[4] the text, args[5] the intent.
case "writeretry":
    let dest = URL(fileURLWithPath: args[3])
    try? FileManager.default.moveItem(at: url, to: dest)
    var runs = 0
    var said = "nil"
    let sem = DispatchSemaphore(value: 0)
    Coordinated.write(url, intent: intentNamed(args[5]), { u in
        runs += 1
        try? args[4].write(to: u, atomically: true, encoding: .utf8)
    }, then: { e in said = e?.localizedDescription ?? "nil"; sem.signal() })
    pump(sem)
    print("\\(runs)\\t\\(said)")

// The judgement that separates "this file has been deleted" from "a stat lost a
// race", driven with dates rather than with a filesystem, because the whole
// point of it is the cases a filesystem will not reproduce on demand.
case "goneforgood":
    let now = Date()
    let verdict: (Int, Double) -> String = { looks, secondsAgo in
        goneForGood(looks: looks, since: now.addingTimeInterval(-secondsAgo), now: now)
            ? "gone" : "wait"
    }
    print([
        goneForGood(looks: 99, since: nil, now: now) ? "gone" : "wait",
        verdict(1, 60),        // one look, however long ago it was
        verdict(2, 0),         // two looks in the same instant
        verdict(2, 0.001),     // two looks one measured replace window apart
        verdict(99, 0),        // any number of looks in the same instant
        verdict(2, 0.3)        // two looks, a quarter of a second apart
    ].joined(separator: "\\t"))

// The poll's own loop, at speed, against a real filesystem rather than against
// dates — because the case it has to survive is one no set of dates can stand
// in for. args[3] is "churn", a writer that removes the file and writes it
// again as fast as it can, or "deleted", a file that is simply gone.
//
// Reported: how many times the loop concluded the document had gone, how long
// into the run the first of those was, and the longest unbroken run of absence
// it actually saw. That last number is the one that matters — the line is drawn
// at kAbsentBeforeGone, and a churning writer has to stay well under it.
case "pollrace":
    var looks = 0
    var since: Date?
    var verdicts = 0
    var firstAt = -1.0
    var longestGap = 0.0
    var stopChurn = false
    let churnDone = DispatchSemaphore(value: 0)
    if args[3] == "churn" {
        DispatchQueue.global(qos: .userInitiated).async {
            let bytes = Data("rewritten\\n".utf8)
            while !stopChurn {
                try? FileManager.default.removeItem(at: url)
                try? bytes.write(to: url)
            }
            churnDone.signal()
        }
    } else {
        try? FileManager.default.removeItem(at: url)
        churnDone.signal()
    }
    let began = Date()
    while Date().timeIntervalSince(began) < 1.5 {
        if fileMark(url) == nil {
            since = since ?? Date()
            looks += 1
            longestGap = max(longestGap, Date().timeIntervalSince(since!))
            if goneForGood(looks: looks, since: since) {
                verdicts += 1
                if firstAt < 0 { firstAt = Date().timeIntervalSince(began) }
            }
        } else {
            looks = 0
            since = nil
        }
        Thread.sleep(forTimeInterval: 0.005)
    }
    stopChurn = true
    churnDone.wait()
    print("\\(verdicts)\\t\\(Int(firstAt * 1000))\\t\\(Int(longestGap * 1000))")

// The real DocPresenter, registered on a real file, while that file is moved to
// the Trash. Which of its callbacks fires is the whole question: a deletion
// would be told to the app as one, and a move would be followed — into the
// Trash, where the autosave would then keep the document up to date in the one
// folder on the machine that exists to be emptied.
//
// Reported: what the presenter heard, where it says the document went, and
// whether isInTrash calls that a place to follow it to.
case "trashed":
    let trashApp = AppDelegate()
    let trashWatcher = DocPresenter(url: url, owner: trashApp)
    NSFileCoordinator.addFilePresenter(trashWatcher)
    Thread.sleep(forTimeInterval: 0.3)
    var landedIn: NSURL?
    do { try FileManager.default.trashItem(at: url, resultingItemURL: &landedIn) }
    catch { print("trashItem-failed\\t\\(error.localizedDescription)"); exit(0) }
    let waited = DispatchSemaphore(value: 0)
    DispatchQueue.global().asyncAfter(deadline: .now() + 2.0) { waited.signal() }
    pump(waited)
    NSFileCoordinator.removeFilePresenter(trashWatcher)
    let went = trashApp.movedTo ?? "nowhere"
    // Tidied up: this is a real Trash, and a test may not leave things in it.
    if let t = landedIn as URL? { try? FileManager.default.removeItem(at: t) }
    print("\\(trashApp.deletions)\\t\\(went)\\t\\(isInTrash(trashWatcher.currentURL))")

// The real DocPresenter, registered on a real file, while something takes a
// coordinated delete of it. What has to hold: the app is told, it is told
// through documentDeleted rather than through the flush — writing what is
// unsaved into a file somebody is deleting would recreate it — and the process
// doing the deleting is not left waiting on us.
case "presenterdelete":
    let app = AppDelegate()
    let presenter = DocPresenter(url: url, owner: app)
    NSFileCoordinator.addFilePresenter(presenter)
    Thread.sleep(forTimeInterval: 0.2)
    var heldUp = 0
    let deleted = DispatchSemaphore(value: 0)
    // Off main, because the presenter answers on main and main has to be free
    // to turn — which is also the arrangement the app is really in.
    DispatchQueue.global(qos: .userInitiated).async {
        let c = NSFileCoordinator()
        var err: NSError?
        let started = Date()
        c.coordinate(writingItemAt: url, options: .forDeleting, error: &err) { u in
            try? FileManager.default.removeItem(at: u)
        }
        heldUp = Int(Date().timeIntervalSince(started) * 1000)
        deleted.signal()
    }
    pump(deleted)
    // The presenter hands the news to main, so main has to turn once more for
    // it — and then keep turning past kCoordinationTimeout, which is when the
    // watchdog that guards the same completion handler goes off. Running that
    // handler a second time is a crash rather than a warning, so getting as far
    // as the print below is itself the assertion that OnceHandler holds.
    let settled = DispatchSemaphore(value: 0)
    DispatchQueue.global().asyncAfter(deadline: .now() + kCoordinationTimeout + 0.5) { settled.signal() }
    pump(settled)
    NSFileCoordinator.removeFilePresenter(presenter)
    print("\\(app.deletions)\\t\\(app.flushes)\\t\\(heldUp)"
          + "\\t\\(FileManager.default.fileExists(atPath: url.path))\\tsurvived")

// The same presenter, and the same callback, arriving for something that is not
// a deletion at all: another editor or a sync client saving the document with an
// atomic write. args[3] picks the writing option, which is the whole question.
//
// This exists because the app was wrong about it. A coordinated write taken
// .forReplacing — which is what every atomic save declares, minimark's own
// included — reaches a presenter as accommodatePresentedItemDeletion, before the
// write, exactly as a real deletion does. Believing that marked the document
// gone on every outside save. What is reported is what the presenter heard and,
// crucially, whether there is still a file at the path afterwards, since that is
// the only thing that tells the two apart.
case "presenterreplace":
    let rApp = AppDelegate()
    let rPresenter = DocPresenter(url: url, owner: rApp)
    NSFileCoordinator.addFilePresenter(rPresenter)
    Thread.sleep(forTimeInterval: 0.2)
    let wrote = DispatchSemaphore(value: 0)
    DispatchQueue.global(qos: .userInitiated).async {
        let c = NSFileCoordinator()
        var err: NSError?
        let options: NSFileCoordinator.WritingOptions = args[3] == "replacing" ? .forReplacing : []
        c.coordinate(writingItemAt: url, options: options, error: &err) { u in
            try? "SAVED BY SOMEBODY ELSE".write(to: u, atomically: true, encoding: .utf8)
        }
        wrote.signal()
    }
    pump(wrote)
    let rSettled = DispatchSemaphore(value: 0)
    DispatchQueue.global().asyncAfter(deadline: .now() + 1.5) { rSettled.signal() }
    pump(rSettled)
    NSFileCoordinator.removeFilePresenter(rPresenter)
    print("\\(rApp.deletions)\\t\\(rApp.changes)\\t\\(FileManager.default.fileExists(atPath: url.path))")

// The version store — which every volume has, not only iCloud — going about its
// business under an open document, with the real DocPresenter and a spy that
// implements the three NSFileVersion callbacks registered on the same file.
//
// Nothing here is coordinated, deliberately. Adding a version is not a write,
// and wrapping one in a coordinated write would put that write's own callbacks
// in the tally and make every number below mean something else. Measured: the
// notifications arrive either way. args[3] is a file to take the new version's
// contents from.
case "presenterversion":
    let vApp = AppDelegate()
    let vPresenter = DocPresenter(url: url, owner: vApp)
    let spy = VersionSpy(url: url)
    NSFileCoordinator.addFilePresenter(vPresenter)
    NSFileCoordinator.addFilePresenter(spy)
    Thread.sleep(forTimeInterval: 0.2)
    let vBefore = (try? String(contentsOf: url, encoding: .utf8)) ?? ""
    let vDraft = URL(fileURLWithPath: args[3])
    try? "SOMEBODY ELSE'S DRAFT".write(to: vDraft, atomically: true, encoding: .utf8)
    let vAdded = (try? NSFileVersion.addOfItem(at: url, withContentsOf: vDraft)) != nil ? 1 : 0
    try? NSFileVersion.removeOtherVersionsOfItem(at: url)
    let vSettled = DispatchSemaphore(value: 0)
    DispatchQueue.global().asyncAfter(deadline: .now() + 1.5) { vSettled.signal() }
    pump(vSettled)
    NSFileCoordinator.removeFilePresenter(vPresenter)
    NSFileCoordinator.removeFilePresenter(spy)
    let vAfter = (try? String(contentsOf: url, encoding: .utf8)) ?? ""
    print("\\(vApp.deletions)\\t\\(vApp.flushes)\\t\\(vApp.changes)\\t\\(vAdded)"
          + "\\t\\(spy.gained)\\t\\(spy.lost)\\t\\(spy.lostWithNilURL)\\t\\(vBefore == vAfter)")


// The gap itself: different bytes, identical mark. Reported as whether the
// restore was honest, whether the mark saw anything, whether the watch did, and
// whether the file really does say something new.
// A storm of stirs. args[3] is how many documents were rewritten at once; what
// is reported is how many passes over the tabs that turned into.
case "watchstorm":
    let stormApp = AppDelegate()
    for _ in 0..<(Int(args[3]) ?? 200) { stormApp.askForALook() }
    turn(kWatchSettle + 0.4)
    // And a second storm after the first has been taken, to show the guard
    // clears rather than latching.
    let firstStorm = stormApp.changes
    for _ in 0..<(Int(args[3]) ?? 200) { stormApp.askForALook() }
    turn(kWatchSettle + 0.4)
    print("\\(firstStorm)\\t\\(stormApp.changes)")

case "watchblind":
    try? sameLengthA.write(to: url, atomically: true, encoding: .utf8)
    var blindStirs = 0
    let blindTab = watched(url, sameLengthA) { blindStirs += 1 }
    let blindHonest = rewriteKeepingTime(url, sameLengthB)
    turn(0.8)
    print("\\(blindHonest)\\t\\(markMoved(blindTab, url))\\t\\(blindTab.stirred)"
          + "\\t\\(fileDiffers(blindTab, url))\\t\\(blindStirs)")
    blindTab.watch?.stop()

// The descriptor follows the inode, not the path. Every atomic replace — ours
// included — leaves the old one watching a file nobody can reach, so a watch
// that does not re-arm silently stops working after the first save, which looks
// exactly like no bug at all to a test that only changes the file once.
case "watchrearm":
    try? sameLengthA.write(to: url, atomically: true, encoding: .utf8)
    var rearmStirs = 0
    let rearmTab = watched(url, sameLengthA) { rearmStirs += 1 }
    // An outsider's atomic replace: new inode, and not a content signal.
    try? Data(sameLengthB.utf8).write(to: url, options: .atomic)
    turn(0.6)
    let stirsFromReplace = rearmStirs
    rearmTab.stirred = false
    rearmTab.mark = fileMark(url)
    rearmTab.digest = DocTab.digest(of: sameLengthB)
    // And now a SECOND change of the shape only the watch can see.
    let rearmHonest = rewriteKeepingTime(url, sameLengthC)
    turn(0.8)
    print("\\(stirsFromReplace)\\t\\(rearmHonest)\\t\\(markMoved(rearmTab, url))"
          + "\\t\\(rearmTab.stirred)\\t\\(fileDiffers(rearmTab, url))")
    rearmTab.watch?.stop()

// The reload loop. If a save of ours came back as an outside change the app
// would reload its own writing over the writer. args[3] is how many saves to
// make, through the app's real writeToDisk, staging and metadata and all.
case "watchours":
    try? sameLengthA.write(to: url, atomically: true, encoding: .utf8)
    var ourStirs = 0
    let ourTab = watched(url, sameLengthA) { ourStirs += 1 }
    var landed = 0
    for i in 1...(Int(args[3]) ?? 5) {
        let text = "our own save number \\(i)\\n"
        let sem = DispatchSemaphore(value: 0)
        Disk.writeToDisk(text, to: url, encoding: .utf8, intent: .update, presenter: nil) { outcome, at in
            if case .wrote = outcome { landed += 1 }
            // stampFile's half: what the app records about its own write.
            ourTab.mark = fileMark(at)
            ourTab.digest = DocTab.digest(of: text)
            ourTab.stirred = false
            sem.signal()
        }
        pump(sem)
    }
    turn(0.8)
    let stirsFromOurs = ourStirs
    let markAfterOurs = markMoved(ourTab, url)
    let digestAfterOurs = fileDiffers(ourTab, url)
    // Zero stirs would also be what a dead watch looks like, so the watch has
    // to be shown still working after all of them.
    ourStirs = 0
    let ourHonest = rewriteKeepingTime(url, "somebody else entirely, afterwards\\n")
    turn(0.8)
    print("\\(landed)\\t\\(stirsFromOurs)\\t\\(markAfterOurs)\\t\\(digestAfterOurs)"
          + "\\t\\(ourStirs > 0)\\t\\(ourHonest)")
    ourTab.watch?.stop()

// Metadata is not content. A Finder tag, a chmod and the timestamp restore
// itself all arrive as .attrib — measured — and none of them change a byte;
// round one's xattr carry-over means our own saves are in that traffic too.
// The one content change that reports .attrib alone is ftruncate, and that
// moves the size and the modification date, which is what the mark compares.
case "watchmeta":
    try? sameLengthA.write(to: url, atomically: true, encoding: .utf8)
    var metaStirs = 0
    let metaTab = watched(url, sameLengthA) { metaStirs += 1 }
    _ = "hello".withCString { setxattr(url.path, "com.apple.metadata:_kMDItemUserTags", $0, 5, 0, 0) }
    chmod(url.path, 0o644)
    var metaWas = stat()
    if stat(url.path, &metaWas) == 0 {
        var t = [metaWas.st_atimespec, metaWas.st_mtimespec]
        _ = utimensat(AT_FDCWD, url.path, &t, 0)
    }
    turn(0.8)
    let metaText = (try? String(contentsOf: url, encoding: .utf8)) ?? ""
    // ftruncate, the one that reports .attrib and nothing else, to show the
    // mark is what covers it.
    let metaBefore = fileMark(url)
    let tfd = open(url.path, O_WRONLY); ftruncate(tfd, 4); close(tfd)
    print("\\(metaStirs)\\t\\(metaText == sameLengthA)\\t\\(fileMark(url) != metaBefore)")
    metaTab.watch?.stop()

// A rewrite that says the same thing. The watch fires on a rewrite, not on a
// change, and a great deal of what rewrites a file writes the same bytes back —
// a \`cp\` of an identical copy, a sync client putting back what we just sent it.
// Reaching the reload with those would put "Reloaded from disk" in front of
// somebody typing and throw a background tab's undo away.
case "watchsame":
    try? sameLengthA.write(to: url, atomically: true, encoding: .utf8)
    var sameStirs = 0
    let sameTab = watched(url, sameLengthA) { sameStirs += 1 }
    let sameHonest = rewriteKeepingTime(url, sameLengthA)
    turn(0.8)
    print("\\(sameHonest)\\t\\(sameStirs > 0)\\t\\(sameTab.stirred)\\t\\(fileDiffers(sameTab, url))")
    sameTab.watch?.stop()

// One descriptor per open document, and it has to go back. args[3] is how many
// to arm at once, which is also the cost measurement: a strip of tabs is a
// descriptor each and one shared thread.
case "watchcost":
    let howMany = Int(args[3]) ?? 24
    func descriptors() -> Int {
        (try? FileManager.default.contentsOfDirectory(atPath: "/dev/fd").count) ?? -1
    }
    let dirURL = url.deletingLastPathComponent()
    let idle = descriptors()
    var costStirs = 0
    var costTabs: [DocTab] = []
    for i in 0..<howMany {
        let f = dirURL.appendingPathComponent("cost\\(i).md")
        try? sameLengthA.write(to: f, atomically: true, encoding: .utf8)
        costTabs.append(watched(f, sameLengthA) { costStirs += 1 })
    }
    turn(0.5)
    let armed = descriptors()
    // Wakeups while nobody touches any of them.
    costStirs = 0
    turn(2.0)
    let whileIdle = costStirs
    // And one of them written: exactly one document's watch may hear it.
    _ = rewriteKeepingTime(dirURL.appendingPathComponent("cost0.md"), sameLengthB)
    turn(0.8)
    let forOne = costStirs
    let stirredTabs = costTabs.filter { $0.stirred }.count
    for t in costTabs { t.watch?.stop() }
    turn(0.6)
    print("\\(armed - idle)\\t\\(whileIdle)\\t\\(forOne)\\t\\(stirredTabs)\\t\\(descriptors() - idle)")

default:
    print("?")
}
`;

console.log('compiling the real coordinator out of minimark.swift\n');
const swiftPath = path.join(dir, 'coord.swift');
fs.writeFileSync(swiftPath, harness);
try {
  execFileSync('swiftc', ['-O', swiftPath, '-o', bin], { stdio: 'pipe' });
} catch (e) {
  console.log('  FAIL  the extracted coordinator does not compile');
  console.log(String(e.stderr || e.stdout || e));
  process.exit(1);
}

const run = (...a) => execFileSync(bin, a, { encoding: 'utf8' }).trim();
const stat = (f, fmt) => execFileSync('stat', ['-f', fmt, f], { encoding: 'utf8' }).trim();
const xattrs = (f) => {
  const out = execFileSync('xattr', [f], { encoding: 'utf8' }).trim();
  return out ? out.split('\n').filter((n) => n !== 'com.apple.provenance').sort() : [];
};

/* Starts a holder and does not come back until it has actually taken the lock.
   Waiting on its own announcement rather than on a sleep is what keeps this
   test from being a race about a race. `found` settles with whatever was on
   disk at the moment it let go. */
function hold(file, seconds) {
  const child = spawn(bin, ['hold', file, String(seconds)], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.found = new Promise((resolve) => {
    child.stdout.on('data', (d) => {
      out += String(d);
      const line = /released\t([\s\S]*)/.exec(out);
      if (line) resolve(line[1].trim());
    });
    child.on('exit', () => resolve(null));
  });
  return new Promise((resolve) => {
    child.stdout.once('data', () => resolve(child));
  });
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {

  console.log('an uncontended file');

  const quiet = path.join(dir, 'quiet.md');
  fs.writeFileSync(quiet, 'before');
  const w = run('write', quiet, 'after').split('\t');
  ok('the write is coordinated', w[0] === 'coordinated', w.join(' '));
  ok('and the body ran exactly once', w[1] === '1', w.join(' '));
  ok('and the text is on disk', fs.readFileSync(quiet, 'utf8') === 'after');
  ok('and it did not dawdle getting there', Number(w[2]) < 500, `${w[2]}ms`);

  const r = run('read', quiet).split('\t');
  ok('the read comes back with the document', r[0] === 'read', r.join(' '));
  ok('and it read what was written', r[3] === 'after', r.join(' '));
  ok('and reports back on the main thread', r[2] === 'main', r.join(' '));
  ok('and nothing waited on a thread for it', Number(r[1]) < 250, `caller held up ${r[1]}ms`);

  console.log('\na file somebody else is writing');

  /* Held for well under the timeout, so coordination is granted late rather
     than given up on. This is the ordinary iCloud case: wait your turn. */
  const busy = path.join(dir, 'busy.md');
  fs.writeFileSync(busy, 'before');
  let holder = await hold(busy, 0.8);
  const queued = run('write', busy, 'mine').split('\t');
  ok('the write waits its turn rather than barging in', queued[0] === 'coordinated', queued.join(' '));
  ok('and still ran its body exactly once', queued[1] === '1', queued.join(' '));
  ok('and it really did wait', Number(queued[2]) > 300, `${queued[2]}ms`);
  ok('and its text is the one left on disk',
     fs.readFileSync(busy, 'utf8') === 'mine', fs.readFileSync(busy, 'utf8'));
  ok('and the writer it waited for kept its own bytes',
     (await holder.found) === 'held', `holder found ${JSON.stringify(await holder.found)}`);
  holder.kill();
  await wait(50);

  /* The same again for a read: a file being written is read after that write,
     never during it. "held" is what the holder puts there, so seeing it means
     the read landed on a finished file rather than an empty one. */
  const busyRead = path.join(dir, 'busy-read.md');
  fs.writeFileSync(busyRead, 'stale');
  holder = await hold(busyRead, 0.8);
  const late = run('read', busyRead).split('\t');
  ok('the read waits for the writer', late[0] === 'read', late.join(' '));
  ok('and sees the finished file, not the one being written',
     late[3] === 'held', late.join(' '));
  holder.kill();
  await wait(50);

  console.log('\na document being rewritten underneath the read');

  /* The bug this round exists for, and it is the same one the write path had a
     round ago. Somebody takes a proper coordinated write and puts a 401-line
     document down in place, slowly — a big file arriving, a sync client
     materialising one. The read used to wait two seconds, give up, read the
     file uncoordinated anyway, and hand back 240 of the 401 lines as the whole
     document — after freezing its caller for 2004ms to do it, on a path reached
     from opening a document and from the poll, both of them main.

     Half a document read into a tab is half a document the autosave writes back
     a second later, so the two things asserted here are the two that were
     wrong: nothing is held while the read waits, and what comes back is all of
     the file or none of it. */
  const streamed = path.join(dir, 'streamed.md');
  const rh = run('readheld', streamed, '2').split('\t');
  ok('the read waits for the writer rather than reading round it',
     rh[1] === 'true', `complete=${rh[1]}, ${rh[0]} lines`);
  ok('and comes back with the whole document, not the part that had landed',
     rh[0] === '401', `${rh[0]} of 401 lines`);
  ok('and nothing waited on a thread for any of it',
     Number(rh[2]) < 250, `caller held up ${rh[2]}ms`);

  /* And the half coordination cannot reach, because the writer is not in it:
     git, cp, `rsync --inplace`, anything that truncates a file and writes it
     again. Nothing can make that writer stand back, so the read has to notice
     on its own that the file is moving. Waiting it out and refusing are both
     right answers; handing back part of a document as though it were all of it
     is the only wrong one. */
  const inplace = path.join(dir, 'inplace.md');
  const quick = run('readtorn', inplace, '20').split('\t');
  ok('a read of a file being rewritten in place never returns part of it',
     quick[0] !== 'partial', `${quick[0]}, ${quick[1]} lines`);

  /* The same, against a writer too slow to outlast. This one has to refuse,
     and has to say why in a sentence somebody can act on. */
  const crawling = path.join(dir, 'crawling.md');
  const slow = run('readtorn', crawling, '120').split('\t');
  ok('a writer it cannot outlast is refused rather than guessed at',
     slow[0] === 'nothing', `${slow[0]}, ${slow[1]} lines`);
  ok('and the refusal says what is happening, in words a person can read',
     /being written by something else/.test(slow[2]), slow.join(' '));
  ok('and it does not claim the file failed, because nothing failed',
     !/error|could not be read/i.test(slow[2]), slow.join(' '));

  console.log('\na file nobody will give up');

  /* Held for longer than kCoordinationTimeout — the length of wait that used
     to make the app give up and write anyway. It must not. The other writer
     is still holding the file, it has been told nothing, and its bytes are
     not ours to throw away. So the save waits however long it takes, without
     a thread waiting with it, and lands after the holder rather than over it.
     What used to be here asserted "uncoordinated" and called that a feature. */
  const timeout = Number(/kCoordinationTimeout: TimeInterval = ([\d.]+)/.exec(src)[1]);
  const wedged = path.join(dir, 'wedged.md');
  fs.writeFileSync(wedged, 'before');
  holder = await hold(wedged, timeout + 2);
  const started = Date.now();
  const forced = run('write', wedged, 'saved anyway').split('\t');
  const took = Date.now() - started;
  const holderSaw = await holder.found;

  ok('the claim is waited for rather than given up on',
     forced[0] === 'coordinated', forced.join(' '));
  ok('and the body still ran exactly once', forced[1] === '1', forced.join(' '));
  ok('and the writing was saved rather than dropped',
     fs.readFileSync(wedged, 'utf8') === 'saved anyway', fs.readFileSync(wedged, 'utf8'));
  ok('and the process that was holding the file kept every byte of its own',
     holderSaw === 'held', `holder found ${JSON.stringify(holderSaw)}`);
  ok('and nothing waited on a thread for any of it',
     Number(forced[3]) < 250, `caller held up ${forced[3]}ms`);
  ok(`and it landed after the holder let go, not at the old timeout (${timeout}s)`,
     took > (timeout + 1) * 1000, `${took}ms`);
  holder.kill();
  await wait(50);

  console.log('\nthe autosave, which hands its answer back to main');

  /* The autosave runs on a keystroke's schedule, so nothing about it may wait
     on the thread somebody is typing on. What has to hold is that the answer
     still comes back — on main, once, with the text actually written — even
     when the file was held by somebody else for most of the wait. */
  const asyncFile = path.join(dir, 'async.md');
  fs.writeFileSync(asyncFile, 'before');
  holder = await hold(asyncFile, 0.8);
  const a = run('writeasync', asyncFile, 'typed while syncing').split('\t');
  ok('the background write gets its turn', a[0] === 'coordinated', a.join(' '));
  ok('and ran its body exactly once', a[1] === '1', a.join(' '));
  ok('and reports back on the main thread', a[2] === 'main', a.join(' '));
  ok('and the typing reached the disk',
     fs.readFileSync(asyncFile, 'utf8') === 'typed while syncing',
     fs.readFileSync(asyncFile, 'utf8'));
  holder.kill();
  await wait(50);

  console.log('\nwhat a save does to the file it replaces');

  /* Finder tags and Finder comments are extended attributes. The creation date
     is when the document came into being. Neither is the editor's to throw
     away, and String.write(atomically:) throws both away on every save — which
     is what this app was doing, once a second, while somebody typed. */
  const meta = path.join(dir, 'meta.md');
  fs.writeFileSync(meta, 'ORIGINAL\n');
  execFileSync('xattr', ['-w', 'com.apple.metadata:kMDItemFinderComment', 'keep-me', meta]);
  execFileSync('xattr', ['-w', 'user.custom.tag', 'preserve-this', meta]);
  fs.chmodSync(meta, 0o640);
  const bornBefore = stat(meta, '%B');
  /* So that a creation date reset to the save time is visibly different from
     the one the file was made with, rather than the same second. */
  await wait(1500);

  const saved = run('save', meta, 'NEW CONTENT AFTER SAVE\n', 'update').split('\t');
  const after = xattrs(meta);
  ok('the save reports success', saved[0] === 'wrote', saved.join(' '));
  ok('and says which file it landed in', saved[1] === 'meta.md', saved.join(' '));
  ok('and the text is the new text',
     fs.readFileSync(meta, 'utf8') === 'NEW CONTENT AFTER SAVE\n',
     JSON.stringify(fs.readFileSync(meta, 'utf8')));
  ok("and the writer's Finder comment survived it",
     after.includes('com.apple.metadata:kMDItemFinderComment'), after.join(', '));
  ok('and so did an extended attribute nothing on this machine knows about',
     after.includes('user.custom.tag'), after.join(', '));
  ok('and the values are the ones that were there',
     execFileSync('xattr', ['-p', 'user.custom.tag', meta], { encoding: 'utf8' }).trim()
       === 'preserve-this');
  ok('and the permissions are unchanged', stat(meta, '%Lp') === '640', stat(meta, '%Lp'));
  ok('and the file still says it was created when it was created',
     stat(meta, '%B') === bornBefore, `${bornBefore} -> ${stat(meta, '%B')}`);
  ok('while the modification date moved, so that was a real window',
     Number(stat(meta, '%m')) > Number(bornBefore), `${bornBefore} -> ${stat(meta, '%m')}`);
  ok('and nothing was left behind beside it',
     fs.readdirSync(dir).filter((n) => n.startsWith('.meta.md')).length === 0,
     fs.readdirSync(dir).join(' '));

  /* A path with nothing at it yet — Save As, or a wikilink making its file.
     There is no metadata to carry and no original to replace, and the write
     still has to work. */
  const fresh = path.join(dir, 'fresh.md');
  ok('a file that does not exist yet is simply written',
     run('save', fresh, 'first words', 'create').split('\t')[0] === 'wrote' &&
     fs.readFileSync(fresh, 'utf8') === 'first words');

  /* The same path, the same empty disk, the other intent. A whole save through
     writeToDisk this time, because `vanished` is an outcome the app switches on
     and does something quite different about, and it has to survive the trip
     back through the encoding decision and the staging. */
  const missing = path.join(dir, 'never-existed.md');
  const gone = run('save', missing, 'text with nowhere to go', 'update').split('\t');
  ok('a save of a document that is not on disk any more is refused',
     gone[0] === 'vanished', gone.join(' '));
  ok('and reported as gone rather than as a write that failed',
     gone[0] !== 'failed', gone.join(' '));
  ok('and says so in a sentence a person can read',
     /is not there any more/.test(gone[1] || ''), gone.join(' '));
  ok('and nothing was made at that path', !fs.existsSync(missing),
     fs.readdirSync(dir).join(' '));

  console.log('\na rename');

  const from = path.join(dir, 'from.md');
  const to = path.join(dir, 'to.md');
  fs.writeFileSync(from, 'moving');
  const m = run('move', from, to).split('\t');
  ok('the move is coordinated', m[0] === 'coordinated', m.join(' '));
  ok('and the body ran exactly once', m[1] === '1', m.join(' '));
  ok('and the file is at its new name', fs.existsSync(to) && !fs.existsSync(from));
  ok('with its text intact', fs.readFileSync(to, 'utf8') === 'moving');
  ok('and nothing waited on a thread for it', Number(m[2]) < 250, `caller held up ${m[2]}ms`);

  console.log('\na rename while a save is still in the air');

  /* The shape that used to end with two files, and the reason the rename is no
     longer on the bounded wait.

     Somebody holds the document for longer than that wait. The autosave's write
     pends on it, correctly. The writer then renames the document while that
     write is still in the air — and the rename timed out, moved a file another
     process was actively holding, and left the pending write pointed at a name
     nothing was at any more. The write recreated it. Two files, the newest text
     in the one nobody is looking at, and the app saying "saved".

     Both orders have to come out the same, because both happen: the coordinator
     grants the two in the order they were asked for, and a move it grants first
     is announced to the write still waiting behind it, which follows. */
  for (const order of ['write-first', 'move-first']) {
    const raceOld = path.join(dir, `race-${order}-old.md`);
    const raceNew = path.join(dir, `race-${order}-new.md`);
    fs.writeFileSync(raceOld, 'SEED');
    holder = await hold(raceOld, timeout + 1);
    const race = run('renamerace', raceOld, raceNew, 'newest text', order).split('\t');
    const holderKept = await holder.found;
    holder.kill();

    console.log(`  (${order})`);
    ok('the rename waits its turn rather than taking a file somebody is holding',
       race[2] === 'nil', race.join(' '));
    ok('and neither of them held a thread while it waited',
       Number(race[3]) < 550, `caller held up ${race[3]}ms`);
    ok('the writer they waited for kept every byte of its own',
       holderKept === 'held', `holder found ${JSON.stringify(holderKept)}`);
    ok('the name the document left is not recreated behind it',
       !fs.existsSync(raceOld), fs.readdirSync(dir).join(' '));
    ok('there is one file, and it is at the new name', fs.existsSync(raceNew));
    ok('and the newest text is the text in it',
       fs.readFileSync(raceNew, 'utf8') === 'newest text',
       JSON.stringify(fs.readFileSync(raceNew, 'utf8')));
    await wait(50);
  }

  console.log('\na rename nothing announced');

  /* mv, git mv, an editor that renames without coordinating. No coordinator can
     follow a move it was never told about, so there is nowhere to redirect a
     write that was pending on the old name — and writing it anyway would not
     save the document, it would recreate the name the document left. It refuses
     instead, and says so in words a person can read. */
  const goneOld = path.join(dir, 'gone-old.md');
  const goneNew = path.join(dir, 'gone-new.md');
  fs.writeFileSync(goneOld, 'SEED');
  holder = await hold(goneOld, timeout + 1);
  const v = run('writeuncoordmove', goneOld, goneNew, 'newest text').split('\t');
  holder.kill();
  ok('the write does not run its body on a path the document has left',
     v[0] === '0', v.join(' '));
  ok('and tells the caller why, rather than reporting a save that did not happen',
     /is not there any more/.test(v[1]) && /moved or deleted/.test(v[1]), v.join(' '));
  ok('so the name the document left stays gone',
     !fs.existsSync(goneOld), fs.readdirSync(dir).join(' '));
  /* One file, and the refused write is not in it. It holds what the mv carried
     across — the holder's own bytes, since a mv that coordinates with nobody
     takes the file out from under whoever had it. That is the other process's
     business and not something this write may paper over. */
  ok('and there is one file, where the document actually went',
     fs.existsSync(goneNew) && !fs.existsSync(goneOld), fs.readdirSync(dir).join(' '));
  ok('with the refused text nowhere in it',
     !fs.readFileSync(goneNew, 'utf8').includes('newest text'),
     JSON.stringify(fs.readFileSync(goneNew, 'utf8')));
  await wait(50);

  console.log('\nthe autosave tick after that one');

  /* Where the round before this stopped protecting anything. Nothing told the
     app the document had moved, so the tab still said the old path and was
     still dirty, and the next tick issued a write there — fresh, unraced, with
     nothing at the path and nothing in the air. Measured, before this: the body
     ran on the old name three milliseconds after a bare mv and there were two
     files again. Deferred, not closed.

     No contention here on purpose. There is no race to lose: the document is
     already gone before the write is asked for, which is exactly why a stat
     taken at that moment had nothing to say. */
  const tickOld = path.join(dir, 'tick-old.md');
  const tickNew = path.join(dir, 'tick-new.md');
  fs.writeFileSync(tickOld, 'SEED');
  const tick = run('writeretry', tickOld, tickNew, 'AUTOSAVE-TEXT', 'update').split('\t');
  ok('the next write is refused too, not just the one that was in flight',
     tick[0] === '0', tick.join(' '));
  ok('and the name the document left is not recreated a tick later',
     !fs.existsSync(tickOld), fs.readdirSync(dir).join(' '));
  ok('so there is still one file, where the document actually went',
     fs.existsSync(tickNew), fs.readdirSync(dir).join(' '));
  ok('holding what the mv carried across, not the refused text',
     fs.readFileSync(tickNew, 'utf8') === 'SEED',
     JSON.stringify(fs.readFileSync(tickNew, 'utf8')));

  /* And the other half of the same fact: it is the caller's purpose that
     decides, not the state of the disk. The identical situation — an empty path
     where a document used to be — is a file waiting to be made when the write
     is a Save As, and it has to go through. If this failed, the refusal above
     would be a stat in disguise and Save As would be broken by it. */
  const makeOld = path.join(dir, 'make-old.md');
  const makeNew = path.join(dir, 'make-new.md');
  fs.writeFileSync(makeOld, 'SEED');
  const make = run('writeretry', makeOld, makeNew, 'SAVED AS', 'create').split('\t');
  ok('the same empty path is written when the write is one that makes a file',
     make[0] === '1' && make[1] === 'nil', make.join(' '));
  ok('and the text is there', fs.existsSync(makeOld) &&
     fs.readFileSync(makeOld, 'utf8') === 'SAVED AS',
     fs.existsSync(makeOld) ? fs.readFileSync(makeOld, 'utf8') : '<missing>');
  await wait(50);

  console.log('\ntelling a file that has been deleted from a stat that lost a race');

  /* The judgement the poll makes, driven with dates instead of with a disk.
     Both directions are bugs: call it too early and the app stops saving a file
     that is perfectly fine, never call it and the writing goes nowhere while
     the status bar says "saved 4m ago".

     The line was measured before it was drawn. An atomic replace — every save
     this app makes, every String.write(atomically:), every replaceItemAt —
     leaves no window at all: 400 replaces sampled 63,635 times by a tight stat
     loop found the file missing 0 times, because the swap ends in a rename and
     a rename resolves to the old file or the new one, never to nothing. The one
     shape that does leave a window removes the file and writes it again, and
     that window measured 0.162ms at its longest. */
  /* A path is passed because every mode takes one; this one never looks at it. */
  const g = run('goneforgood', dir).split('\t');
  ok('a document whose file has never been missed is not gone', g[0] === 'wait', g.join(' '));
  ok('nor is one that has been missed once, however long ago', g[1] === 'wait', g.join(' '));
  ok('two looks in the same instant are one look, and not enough',
     g[2] === 'wait', g.join(' '));
  ok('nor are two a millisecond apart — that is inside a replace, not a deletion',
     g[3] === 'wait', g.join(' '));
  ok('and no number of looks in the same instant adds up to a verdict',
     g[4] === 'wait', g.join(' '));
  ok('two looks a quarter second apart, both finding nothing, is a file that has gone',
     g[5] === 'gone', g.join(' '));

  /* And the same judgement against a real filesystem, because the case it has
     to survive is one no set of dates can stand in for: a writer that really
     does make the file disappear, over and over, while the loop is looking. */
  const timeoutSecs = Number(/kAbsentBeforeGone: TimeInterval = ([\d.]+)/.exec(src)[1]);
  const churned = path.join(dir, 'churned.md');
  fs.writeFileSync(churned, 'seed');
  const pr = run('pollrace', churned, 'churn').split('\t');
  ok('a writer removing and rewriting the file is never mistaken for a deletion',
     pr[0] === '0', `${pr[0]} verdict(s) in a second and a half of churn`);
  ok('because the gap it leaves is nowhere near the line',
     Number(pr[2]) < timeoutSecs * 1000,
     `longest absence seen ${pr[2]}ms, line at ${timeoutSecs * 1000}ms`);

  const removed = path.join(dir, 'removed.md');
  fs.writeFileSync(removed, 'seed');
  const pd = run('pollrace', removed, 'deleted').split('\t');
  ok('a file that is actually gone is called gone', Number(pd[0]) > 0, pd.join(' '));
  ok('and called it about as soon as the line allows, not eventually',
     Number(pd[1]) >= timeoutSecs * 1000 && Number(pd[1]) < timeoutSecs * 1000 + 250,
     `first said so after ${pd[1]}ms, line at ${timeoutSecs * 1000}ms`);

  console.log('\na coordinated delete, which the poll should not have to wait for');

  /* The other half. `rm` reaches no presenter at all — measured, no callback of
     any kind — so the poll above is the only thing that catches it. But Finder
     moving a document to the Trash, an iCloud removal and any coordinated
     delete arrive here instead, before the file goes rather than up to a watch
     interval after it has. */
  const doomed = path.join(dir, 'doomed.md');
  fs.writeFileSync(doomed, 'about to go');
  const d = run('presenterdelete', doomed).split('\t');
  ok('the app is told its document is being deleted, once', d[0] === '1', d.join(' '));
  ok('and is NOT asked to flush into a file somebody is deleting',
     d[1] === '0', d.join(' '));
  ok('and the process doing the deleting was not left waiting on us',
     Number(d[2]) < 500, `held up ${d[2]}ms`);
  ok('and the delete went through', d[3] === 'false' && !fs.existsSync(doomed), d.join(' '));
  /* The handler is answered by the presenter and again, kCoordinationTimeout
     later, by the watchdog that exists in case the first one never comes.
     Running a coordination completion handler twice is a crash, not a warning,
     so the run getting this far past that timeout is the assertion. */
  ok('and the handler both the presenter and its watchdog answer ran only once',
     d[4] === 'survived', d.join(' '));

  console.log('\nand an outside save, which is not a deletion either but arrives as one');

  /* The guess that had to be measured rather than made, and it came back the
     wrong way round. accommodatePresentedItemDeletion does not mean "your
     document is being deleted". A coordinated write taken .forReplacing gets
     the same callback, before the write, and .forReplacing is what every atomic
     save declares — another editor's, a sync client's, and this app's own.

     Believing it made every outside save mark the document gone: "not saving"
     in the status bar, the autosave diverted into the crash buffer, ⌘S asking
     where to put the file, all of it taken back a poll later when the file
     turned out to be exactly where it had always been.

     So this pins the platform behaviour the fix depends on. If Apple ever stops
     sending it for a replacing write, this fails and says so — and the last two
     assertions are the discriminator itself: after a replace there is a file at
     the path, and after a deletion there is not. */
  const replaced = path.join(dir, 'replaced.md');
  fs.writeFileSync(replaced, 'mine');
  const rep = run('presenterreplace', replaced, 'replacing').split('\t');
  ok('an atomic outside save reaches the presenter as a deletion',
     rep[0] === '1', `deletions=${rep[0]} changes=${rep[1]} exists=${rep[2]}`);
  ok('and the file is still there afterwards, which is what says it was not one',
     rep[2] === 'true' && fs.existsSync(replaced), rep.join(' '));
  ok('and the text is the other writer’s',
     fs.readFileSync(replaced, 'utf8') === 'SAVED BY SOMEBODY ELSE',
     JSON.stringify(fs.readFileSync(replaced, 'utf8')));

  /* And the control: a coordinated write with no options is not announced as a
     deletion at all, which is what makes the one above a property of
     .forReplacing rather than of coordinated writing. */
  const plainly = path.join(dir, 'plainly.md');
  fs.writeFileSync(plainly, 'mine');
  const pw = run('presenterreplace', plainly, 'plain').split('\t');
  ok('a coordinated write with no options is not announced as a deletion',
     pw[0] === '0', `deletions=${pw[0]} changes=${pw[1]} exists=${pw[2]}`);
  ok('but it is announced as a change, so the app hears about it either way',
     Number(pw[1]) > 0, `changes=${pw[1]}`);

  console.log('\nand a document put in the Trash, which is not a deletion at all');

  /* The guess worth measuring rather than making. Moving a document to the
     Trash is the ordinary way a person deletes one, and it does not arrive as a
     deletion: trashItem is a MOVE, and a presenter that follows its document
     wherever it goes follows it into ~/.Trash and keeps autosaving there —
     the writer's work kept up to date in the one folder on the machine that
     exists to be emptied, and the file they meant to delete quietly refusing to
     stay deleted. So this is the one move that is not followed. */
  const binned = path.join(dir, 'binned.md');
  fs.writeFileSync(binned, 'about to be thrown away');
  const t = run('trashed', binned).split('\t');
  ok('trashing a document is not reported as a deletion', t[0] === '0', t.join(' '));
  ok('it is reported as a move, and the move goes to a Trash',
     /\.Trash/.test(t[1] || ''), t.join(' '));
  ok('which is a place the app knows better than to follow its document into',
     t[2] === 'true', t.join(' '));
  ok('and the old name really is empty afterwards, so the poll would see it too',
     !fs.existsSync(binned), fs.readdirSync(dir).join(' '));

  console.log('\nand the version store, which the app hears nothing from on purpose');

  /* The measurement behind the comment at the foot of DocPresenter, kept here
     so nobody has to re-derive it. Every volume has a version store — this is
     not an iCloud-only mechanism — and another process putting a version of the
     open document into it reaches a presenter that implements the callbacks.
     What it does NOT do is change the document, which is the whole reason the
     app can afford to be deaf to it: the file's bytes are identical afterwards,
     so there is nothing to reload and nothing to ask about. The one version
     operation that does change the file, a revert, arrives as
     presentedItemDidChange as well — which this class already implements and
     already wires into checkFileOnDisk. */
  const versioned = path.join(dir, 'versioned.md');
  fs.writeFileSync(versioned, 'THE DOCUMENT AS THE WRITER LEFT IT');
  const ver = run('presenterversion', versioned, path.join(dir, 'version-source.md')).split('\t');
  ok('a version really was added and removed, so the zeros below are the app’s and not the test’s',
     ver[3] === '1' && ver[4] === '1' && ver[5] === '1',
     `added=${ver[3]} gained=${ver[4]} lost=${ver[5]}`);
  ok('the app is told nothing at all when versions come and go',
     ver[0] === '0' && ver[1] === '0' && ver[2] === '0',
     `deletions=${ver[0]} flushes=${ver[1]} changes=${ver[2]}`);
  ok('because the document itself never moved — there is nothing to reload',
     ver[7] === 'true', ver.join(' '));
  ok('and every version handed to presentedItemDidLoseVersion: has a nil URL, ' +
     'which is why implementing it in Swift is a crash rather than a feature',
     ver[5] === ver[6] && Number(ver[6]) > 0, `lost=${ver[5]} nilURL=${ver[6]}`);

  console.log('\nthe change a mark taken from stat cannot see');

  /* The blind spot the kernel watch exists for. A writer that rewrites the
     bytes through the file's own inode and puts the timestamp back leaves the
     modification date, the size AND the inode exactly as they were: `touch -r`
     and everything shaped like it, a tool that snapshots the times around an
     in-place edit and puts them back. And it does not take one of those —
     measured, HFS+ and MS-DOS volumes stamp the modification date to the whole
     second, so on an external drive or a USB stick any outside write inside the
     same second as the last look is invisible to a mark as well, whatever it
     did to the file. 40 of 40 back-to-back rewrites on an HFS+ image left the
     date byte for byte identical. (`cp -p` is the obvious example and the wrong
     one: measured, it stamps the source's timestamp onto the destination rather
     than restoring the destination's own.)

     Left unseen, the tab shows stale text for as long as it is open, and the
     moment the writer types, the autosave puts that stale text back over the
     restore. Every one of these drives the app's own DocWatch on the app's own
     DocTab; the harness owns the outside writer and nothing else. */
  const blind = path.join(dir, 'blind.md');
  const wb = run('watchblind', blind).split('\t');
  ok('the timestamp restore really took, so this case is the case it claims to be',
     wb[0] === 'true', wb.join(' '));
  ok('and the mark is blind to it, exactly as it was before the watch existed',
     wb[1] === 'false', `mark moved: ${wb[1]}`);
  ok('but the kernel watch is not, and it stirs the tab that owns the file',
     wb[2] === 'true' && Number(wb[4]) > 0, `stirred=${wb[2]} events=${wb[4]}`);
  ok('and the file really does say something new, so the stir is worth acting on',
     wb[3] === 'true', wb.join(' '));

  /* The one that decides whether any of this keeps working. A descriptor
     follows the inode, not the path, and every atomic replace — this app's own
     saves included — unlinks the inode it is on. A watch that does not re-arm
     stops working after the first save and looks exactly like no bug at all to
     a test that only changes the file once. So: change it, replace it, change
     it again. */
  const rearm = path.join(dir, 'rearm.md');
  const wr = run('watchrearm', rearm).split('\t');
  ok('an atomic replace is not itself reported as a content change',
     wr[0] === '0', `stirs from the replace: ${wr[0]}`);
  ok('the second timestamp restore took as well',
     wr[1] === 'true', wr.join(' '));
  ok('the mark is blind to the second change too',
     wr[2] === 'false', `mark moved: ${wr[2]}`);
  ok('and the watch still sees it, so it re-armed on the path after the replace',
     wr[3] === 'true', `stirred=${wr[3]}`);
  ok('and what it saw is a real difference',
     wr[4] === 'true', wr.join(' '));

  /* And the way this becomes a worse bug than the one it fixes: a watch that
     reports our own saves as somebody else's change reloads our own writing
     over the writer, once a second, for as long as they type. It cannot here,
     and not because of a flag that might be set at the wrong moment —
     measured, an atomic replace never writes through the inode the descriptor
     holds, so our saves arrive as .delete and .delete means re-arm. Five real
     saves through the app's own writeToDisk. */
  const ours = path.join(dir, 'ours.md');
  const wo = run('watchours', ours, '5').split('\t');
  ok('five saves of our own really landed, through the app’s own writeToDisk',
     wo[0] === '5', `${wo[0]} of 5`);
  ok('and not one of them was reported to the app as an outside change',
     wo[1] === '0', `stirs: ${wo[1]}`);
  ok('and the mark the save recorded says nothing changed either',
     wo[2] === 'false', wo.join(' '));
  ok('and the digest agrees with what is on disk, so there is nothing to reload',
     wo[3] === 'false', wo.join(' '));
  ok('and the watch is still alive after all five — a zero above is not a dead watch',
     wo[4] === 'true' && wo[5] === 'true', `stirred after=${wo[4]} restore honest=${wo[5]}`);

  /* .attrib is not in the mask, and this is what that costs and buys. Tagging a
     file in Finder, chmod, and the timestamp restore itself all arrive as
     .attrib and none of them change a byte — and round one's xattr carry-over
     means our own saves would be in that traffic too. The one content change
     that reports .attrib and nothing else is ftruncate, and the mark covers
     that one, which is why leaving it out is a saving rather than a hole. */
  const tagged = path.join(dir, 'tagged.md');
  const wm = run('watchmeta', tagged).split('\t');
  ok('a Finder tag, a chmod and a timestamp restore do not stir the document',
     wm[0] === '0', `stirs: ${wm[0]}`);
  ok('and nothing about the file changed for them to have stirred about',
     wm[1] === 'true', wm.join(' '));
  ok('while ftruncate, the one content change that reports only .attrib, moves the mark',
     wm[2] === 'true', wm.join(' '));

  /* The watch fires on a rewrite, not on a change, and a great deal of what
     rewrites a file writes the same bytes back: a `cp` of an identical copy, a
     sync client putting back what we just sent it, `touch` on a volume where
     that rewrites. Reaching the reload with those would put "Reloaded from
     disk" in front of somebody typing and throw a background tab's undo stack
     away. The digest is what stands between the two. */
  const same = path.join(dir, 'same.md');
  const ws = run('watchsame', same).split('\t');
  ok('a rewrite with the same bytes does reach the watch',
     ws[0] === 'true' && ws[1] === 'true', ws.join(' '));
  ok('and the tab is stirred by it, because the kernel cannot know any better',
     ws[2] === 'true', ws.join(' '));
  ok('but the digest says the file has nothing new to say, so nothing is reloaded',
     ws[3] === 'false', ws.join(' '));

  /* What a strip of open documents costs, and whether it is given back. One
     descriptor each and one shared queue; the descriptors are the only
     resource, and a leaked one is the same class of bug as the presenter that
     used to be left registered on every closed tab. */
  const cost = path.join(dir, 'cost.md');
  const wc = run('watchcost', cost, '24').split('\t');
  ok('24 open documents cost 24 descriptors and nothing else',
     Number(wc[0]) >= 24 && Number(wc[0]) <= 26, `+${wc[0]} descriptors for 24 documents`);
  ok('and no wakeups at all while nobody is touching any of them',
     wc[1] === '0', `${wc[1]} in two idle seconds`);
  ok('one document written wakes the mechanism once',
     wc[2] === '1', `${wc[2]} wakeups`);
  ok('and stirs exactly the one tab whose file it was',
     wc[3] === '1', `${wc[3]} tabs stirred`);
  ok('and stopping them all gives every descriptor back',
     Number(wc[4]) <= 0, `${wc[4]} descriptors left over`);

  console.log('\nand the wiring, which nothing above can run');

  /* Everything before this drives the real DocWatch on a real DocTab, but it
     builds the pair by hand. What it cannot reach is whether the app ever makes
     one, or ever lets one go — those live in AppDelegate, and an AppDelegate
     needs an NSApplication and a WKWebView under it. A watch that is never
     armed and a descriptor that is never closed both leave every assertion
     above passing, so those three lines are checked where they are: in the
     source, crudely, the way bridge-contract.js checks the other pairing
     nothing else can run. */
  const inside = (name) => extract(name);
  ok('pushTabs reconciles the watches, so every tab that gains a path gains one',
     /syncWatches\(\)/.test(inside('    func pushTabs')),
     'syncWatches() is not called from pushTabs');
  ok('closeTab gives back what the closed tab held — the reconcilers walk `tabs` ' +
     'and will never visit it again',
     /releaseFileWatching\(/.test(inside('    func closeTab')),
     'releaseFileWatching is not called from closeTab');
  /* `tab.stirred` merely appearing in checkFileOnDisk is not enough, and this
     was found by taking it out of the guard and watching every other assertion
     here pass: the watch still fires, the tab is still marked, and the poll
     still skips it, which is the gap left exactly where it was. So what is
     checked is that the stir is a reason to LOOK — that it is in a guard. */
  ok('and checkFileOnDisk treats a stir as a reason to look, and re-arms a watch ' +
     'a replace took away',
     /(\|\|[^\n]*tab\.stirred|tab\.stirred[^\n]*\|\|)/.test(inside('    func checkFileOnDisk')) &&
     /ensureArmed\(\)/.test(inside('    func checkFileOnDisk')),
     'checkFileOnDisk does not act on tab.stirred, or never re-arms');
  ok('and the poll is still there, because a vnode source needs a descriptor and ' +
     'a network mount may give none',
     /Timer\(timeInterval: kWatchInterval/.test(inside('    func startWatching')),
     'the poll has been removed');
  /* The digest is compared above, but the comparison that matters is the one
     inside reread, and reread is AppDelegate's. Taking it out leaves every
     behavioural assertion in this file passing and puts "Reloaded from disk" in
     front of anyone whose file gets rewritten with the same bytes — measured:
     with the guard removed by hand, nothing here noticed. So the guard is
     checked where it lives, and so is the save that records what to compare
     against. */
  ok('reread compares the digest before anything can reach the reload',
     /guard\s+tab\.digest\s*!=/.test(inside('    private func reread')),
     'reread no longer short-circuits on an unchanged file');
  ok('and a save records what it wrote, so the next look has something to compare with',
     /tab\.digest = DocTab\.digest/.test(inside('    func stampFile')),
     'stampFile no longer records the digest');

  /* And what a storm of them costs. Something rewriting a whole worktree fires
     one event per open document — measured, 200 documents, 200 wakeups, no
     amplification — and every one of those turning into a pass over every tab
     would be 40,000 passes and a coordinated read per tab per pass. */
  const storm = run('watchstorm', path.join(dir, 'storm.md'), '200').split('\t');
  ok('200 stirs at once become one look at the documents, not 200',
     storm[0] === '1', `${storm[0]} looks`);
  ok('and the next 200 become one more, so the guard clears rather than latching',
     storm[1] === '2', `${storm[1]} looks in total`);

  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);

})().catch((e) => {
  console.error(e);
  fs.rmSync(dir, { recursive: true, force: true });
  process.exit(1);
});
