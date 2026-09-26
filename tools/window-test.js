#!/usr/bin/env node
/* ============================================================
   minimark — more than one window

   Everything a window is moved into `Editor` in the commit before this one, so
   that there could be more than one of them. This is the part that decides
   whether more than one actually works, and it stands guard over two things
   that cost somebody their writing if they break.

   1. ONE FILE IS OPEN IN ONE PLACE, and "one place" is the app rather than a
      window. Two tabs on one path means two undo stacks, two autosaves racing
      for it, and — because the file coordination keys off tabs — a second
      presenter and a second kernel watch on a file somebody is editing. That is
      the whole of what this project spent seven rounds removing. A second window
      is a new way to reintroduce it: open the same file in both, or save two
      untitled documents under one name, and it is back.

      So the check lives on the app and every route into a document goes through
      it. Two halves are tested here. The live half, openTab(for:), is asked
      whether a file is open anywhere and answers with the window as well as the
      tab — because a tab behind another window is no use to anybody, and
      bringing it forward means bringing its window forward. The launch half is
      Session.plan, which applies the same rule to the session before a single
      document is put up: a path the session somehow names twice, in one window's
      strip or two, is seated once.

   2. A SESSION WRITTEN BY THE BUILD BEFORE THIS ONE STILL REOPENS. The keys in
      UserDefaults held one flat strip of documents for the whole app and had no
      room for a window. They now hold the same strip with a marker wherever the
      next window begins — and the first window needs no marker, so a session
      with one window in it goes out byte for byte as it always did, and a
      session that came in from any earlier build has no markers in it at all and
      reads back as the one window it describes. Through the same code: there is
      no second reader to drift.

      Every older shape is tested too, because they are all still written and a
      downgrade has to find something it understands: the paths-only keys from
      before there were tabs, and the single path from before there were several.

   This cannot be a browser test: it is Swift, and it is about UserDefaults and
   files on disk. So it compiles the app's own Session, its own Scratch store and
   its own openTab out of minimark.swift into a throwaway binary and drives them.
   Extracted rather than copied, because a copy is worthless the moment the two
   drift.

   Two things in the harness are not the app's own code, for the same reason the
   coordination harness stubs the app delegate: so that what IS under test is the
   app's. `Templates.dir` points at a temporary folder rather than at somebody's
   real unsaved work. And `Editor` here is a class with a list of tabs and a
   note of having been revealed, because the only question openTab asks a window
   is which documents it holds, and the only thing it does with the answer is
   bring one forward. A DocTab here is the same: a path and an id.

   The defaults are a suite of their own, named for this run, and it is removed
   at the end — by the harness and again here, because a test has no business
   leaving anything in ~/Library/Preferences.

   Usage:  node tools/window-test.js [swiftFile]
   ============================================================ */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const swiftFile = process.argv[2] || path.resolve(__dirname, '..', 'minimark.swift');
const src = fs.readFileSync(swiftFile, 'utf8');

let passed = 0, failed = 0;
const ok = (name, cond, detail) => {
  if (cond) { passed++; console.log(`  ok    ${name}`); }
  else { failed++; console.log(`  FAIL  ${name}${detail ? '\n        ' + detail : ''}`); }
};
const eq = (name, got, want) =>
  ok(name, JSON.stringify(got) === JSON.stringify(want),
     `got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`);

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

/* The session keys have no braces of their own, so balancing from the first of
   them runs on to the end of the next block — which is Session itself, and is
   exactly what is wanted. Asserted rather than assumed: if anything braced ever
   lands between the keys and Session this stops early, and a harness that
   quietly tested half of what it meant to would be worse than one that fails. */
const sessionBlock = extract('let kLegacyHistoryKey');
for (const needed of ['kOpenTabsKey', 'kActiveTabKey', 'kFrontWindowKey',
                      'kOpenDocsKey', 'kActiveDocKey', 'kLastDocKey',
                      'enum Session', 'static func plan']) {
  if (!sessionBlock.includes(needed)) {
    throw new Error(`the extracted session block is missing ${needed} — ` +
                    `something braced has landed between the keys and enum Session`);
  }
}

/* The cap is the app's number, read off the app's own declaration rather than
   written down again here. */
const capMatch = src.match(/let kMaxRestoredTabs\s*=\s*(\d+)/);
if (!capMatch) throw new Error('could not find kMaxRestoredTabs in ' + swiftFile);
const CAP = Number(capMatch[1]);

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-window-'));
const support = path.join(dir, 'support');
const docs = path.join(dir, 'docs');
fs.mkdirSync(support);
fs.mkdirSync(docs);
const bin = path.join(dir, 'window');
const suite = 'minimark.window-test.' + process.pid;

const harness = `
import Foundation

/* Scratch reaches its folder through Templates.dir, which is the real
   Application Support. This is the only reason the stub exists: so the test
   writes into a temporary directory instead of over somebody's actual unsaved
   work. */
enum Templates {
    static var dir: URL? {
        guard let root = ProcessInfo.processInfo.environment["MM_TEST_SUPPORT"] else { return nil }
        let dir = URL(fileURLWithPath: root, isDirectory: true)
        if !FileManager.default.fileExists(atPath: dir.path) {
            try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        }
        return dir
    }
}

${extract('enum Scratch {')}
${sessionBlock}

/* A tab, as far as the question under test is concerned: a path and an id.
   Everything else a DocTab is — its base, its presenter, its watch, its
   authorship block — is what makes it too big to lift in here, and none of it is
   asked about by the lookup being tested. */
final class DocTab {
    let id: Int
    var url: URL?
    init(id: Int, url: URL?) { self.id = id; self.url = url }
}

/* And a window: the documents it holds, and a note of having been brought
   forward, which is what "already open — here it is" has to do. */
final class Editor {
    var tabs: [DocTab] = []
    var revealed: Int?
    func reveal(_ id: Int) { revealed = id }
}

/* Everything the lookup is, lifted whole. \`front\` is the one thing faked: in
   the app it is the key window, and here it is the first one, because what is
   being tested is the order the lists come out in rather than what AppKit thinks
   is in front. */
final class AppDelegate {
    var editors: [Editor] = []
    var opening: Set<String> = []
    var front: Editor? { editors.first }
${extract('    var allTabs: [DocTab]')}
${extract('    var allTabsAndWindows: [(Editor, DocTab)]')}
${extract('    var frontFirstTabs: [(Editor, DocTab)]')}
${extract('    func editor(of tab: DocTab)')}
${extract('    func openTab(for url: URL)')}
}

// ---------------------------------------------------------------- driving it

let args = CommandLine.arguments
let defaults = UserDefaults(suiteName: args[1])!

func emit(_ any: Any) {
    let data = try! JSONSerialization.data(withJSONObject: any,
                                           options: [.sortedKeys, .fragmentsAllowed])
    print(String(data: data, encoding: .utf8)!)
}

func json(_ s: String) -> Any {
    try! JSONSerialization.jsonObject(with: Data(s.utf8), options: [.fragmentsAllowed])
}

func seatsOut(_ plan: Session.Plan) -> [String: Any] {
    let windows: [[[String: String]]] = plan.windows.map { seats in
        seats.map { seat in
            switch seat {
            case .file(let url):            return ["file": url.path]
            case .buffer(let id, let text): return ["buffer": id, "text": text]
            }
        }
    }
    return ["windows": windows, "fronts": plan.fronts, "frontWindow": plan.frontWindow]
}

/// The three keys as they actually sit in the defaults, with nothing
/// interpreted: this is what an older build would find.
func rawOut() -> [String: Any] {
    ["openTabs": defaults.stringArray(forKey: kOpenTabsKey) ?? [],
     "activeTabIndex": defaults.integer(forKey: kActiveTabKey),
     "frontWindowIndex": defaults.integer(forKey: kFrontWindowKey)]
}

switch args[2] {

case "write":
    let spec = json(args[3]) as! [String: Any]
    let windows = (spec["windows"] as! [[String]])
    let fronts = (spec["fronts"] as? [Int]) ?? []
    let frontWindow = (spec["frontWindow"] as? Int) ?? 0
    Session.write(windows, fronts: fronts, frontWindow: frontWindow, to: defaults)
    emit(rawOut())

/// A session put in by hand, the way an older build left one.
case "set":
    for (key, value) in json(args[3]) as! [String: Any] {
        if value is NSNull { defaults.removeObject(forKey: key) }
        else { defaults.set(value, forKey: key) }
    }
    emit(rawOut())

case "raw":
    emit(rawOut())

case "groups":
    let g = Session.groups(in: defaults)
    emit(["windows": g.windows, "fronts": g.fronts, "frontWindow": g.frontWindow])

case "plan":
    emit(seatsOut(Session.plan(in: defaults, cap: Int(args[3])!)))

/// One crash-insurance buffer on disk, as the autosave leaves one.
case "buffer":
    emit(Scratch.write(args[4], id: args[3]))

/// The app's own lookup, over windows built to order. Each window is a list of
/// paths, "" for a document that has never been saved.
case "opentab":
    let app = AppDelegate()
    var next = 1
    for paths in json(args[3]) as! [[String]] {
        let editor = Editor()
        for p in paths {
            editor.tabs.append(DocTab(id: next, url: p.isEmpty ? nil : URL(fileURLWithPath: p)))
            next += 1
        }
        app.editors.append(editor)
    }
    guard let (editor, tab) = app.openTab(for: URL(fileURLWithPath: args[4])) else {
        emit(["found": false])
        break
    }
    // What openDocument does with the answer, so that the answer is shown
    // reaching a window rather than only being returned.
    editor.reveal(tab.id)
    emit(["found": true,
          "window": app.editors.firstIndex { $0 === editor }!,
          "tab": tab.id,
          "revealed": editor.revealed ?? -1,
          // And that no OTHER window was disturbed, which is the other half of
          // "brings that window forward" being a sentence about one window.
          "revealedElsewhere": app.editors.filter { $0 !== editor && $0.revealed != nil }.count])

/// The order the poll walks, which is the front window's documents first.
case "order":
    let app = AppDelegate()
    var next = 1
    for paths in json(args[3]) as! [[String]] {
        let editor = Editor()
        for p in paths {
            editor.tabs.append(DocTab(id: next, url: p.isEmpty ? nil : URL(fileURLWithPath: p)))
            next += 1
        }
        app.editors.append(editor)
    }
    let rows: [[Int]] = app.frontFirstTabs.map { pair in
        [app.editors.firstIndex { $0 === pair.0 } ?? -1, pair.1.id]
    }
    emit(rows)

case "clean":
    defaults.removePersistentDomain(forName: args[1])
    defaults.synchronize()
    emit(true)

default:
    FileHandle.standardError.write(Data("unknown command \\(args[2])\\n".utf8))
    exit(2)
}
`;

const harnessPath = path.join(dir, 'window.swift');
fs.writeFileSync(harnessPath, harness);

function cleanup() {
  try { run('clean'); } catch (e) { /* the binary may not exist yet */ }
  // Belt as well as braces: a suite the harness could not remove would be a
  // file left in the user's preferences folder, which a test does not get to do.
  try {
    execFileSync('defaults', ['delete', suite], { stdio: 'ignore' });
  } catch (e) { /* already gone */ }
  // Emptying the domain leaves the plist behind as an empty shell, so the file
  // goes too. Measured: without this, every run left one in ~/Library/Preferences.
  try {
    fs.rmSync(path.join(os.homedir(), 'Library', 'Preferences', suite + '.plist'),
              { force: true });
  } catch (e) { /* ignore */ }
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
}

function run(...argv) {
  const out = execFileSync(bin, [suite, ...argv], {
    encoding: 'utf8',
    env: Object.assign({}, process.env, { MM_TEST_SUPPORT: support })
  });
  return JSON.parse(out.trim());
}

function doc(name, text) {
  const p = path.join(docs, name);
  fs.writeFileSync(p, text || ('# ' + name + '\n'));
  return p;
}

function uuid(n) {
  // Scratch.isID insists on a real UUID, because it names a file the app writes
  // to unprompted. So these are real ones, distinguishable by their last digit.
  return '0000000' + n + '-0000-4000-8000-000000000000';
}

let exitCode = 0;
try {
  console.log('\nminimark window tests\n');
  console.log('  compiling the app\'s own Session, Scratch and openTab…');
  execFileSync('swiftc', ['-O', harnessPath, '-o', bin], { stdio: 'inherit' });

  const a = doc('a.md'), b = doc('b.md'), c = doc('c.md'), d = doc('d.md');

  // ------------------------------------------------------------------
  console.log('\none file is open in one place, across windows\n');

  {
    // Two windows, the file open in the second one.
    let r = run('opentab', JSON.stringify([[a, ''], [b, c]]), b);
    ok('a file open in another window is found', r.found === true,
       JSON.stringify(r));
    eq('…and the window it is in is named', r.window, 1);
    eq('…and the tab inside it, not merely the first tab there', r.tab, 3);
    eq('…and that window is the one brought forward', r.revealed, 3);
    eq('…and no other window is disturbed', r.revealedElsewhere, 0);
  }

  {
    let r = run('opentab', JSON.stringify([[a], [b]]), a);
    eq('a file open in this window is still found here', [r.window, r.tab], [0, 1]);
  }

  {
    // The same file spelled a longer way round. openDocument standardises
    // before it compares, because "/docs/./a.md" and "/docs/a.md" are one
    // document and opening the second over the first is the bug.
    const round = path.join(docs, '.', 'sub', '..', 'a.md');
    let r = run('opentab', JSON.stringify([[''], [a]]), round);
    ok('the same file spelled another way is the same document',
       r.found === true && r.window === 1, JSON.stringify(r));
  }

  {
    let r = run('opentab', JSON.stringify([[a, ''], [b]]), d);
    eq('a file open in no window is not found', r.found, false);
  }

  {
    let r = run('opentab', JSON.stringify([['', ''], ['']]), a);
    eq('windows of untitled documents hold no file', r.found, false);
  }

  {
    // The same question the session has to answer, which is the other place the
    // rule is enforced: a strip that names one file in two windows.
    run('set', JSON.stringify({
      openTabs: ['f:' + a, 'w:0', 'f:' + a, 'f:' + b],
      activeTabIndex: 0, frontWindowIndex: 0
    }));
    const plan = run('plan', String(CAP));
    eq('a session naming one file in two windows seats it once',
       plan.windows, [[{ file: a }], [{ file: b }]]);
  }

  {
    run('set', JSON.stringify({
      openTabs: ['f:' + a, 'f:' + a, 'f:' + b],
      activeTabIndex: 0, frontWindowIndex: 0
    }));
    const plan = run('plan', String(CAP));
    eq('and twice inside one window, as it always did',
       plan.windows, [[{ file: a }, { file: b }]]);
  }

  // ------------------------------------------------------------------
  console.log('\nthe session round-trips two windows\n');

  {
    const raw = run('write', JSON.stringify({
      windows: [['f:' + a, 'f:' + b], ['f:' + c]],
      fronts: [1, 0], frontWindow: 1
    }));
    eq('one strip, with a marker where the second window begins',
       raw.openTabs, ['f:' + a, 'f:' + b, 'w:0', 'f:' + c]);
    eq('the first window\'s front seat stays in the key it has always been in',
       raw.activeTabIndex, 1);
    eq('and which window was in front is recorded', raw.frontWindowIndex, 1);

    const g = run('groups');
    eq('read back, two groups in the order they went out',
       g.windows, [['f:' + a, 'f:' + b], ['f:' + c]]);
    eq('with each window\'s own front seat', g.fronts, [1, 0]);
    eq('and the front window', g.frontWindow, 1);

    const plan = run('plan', String(CAP));
    eq('and settled against the disk, two windows of documents',
       plan.windows, [[{ file: a }, { file: b }], [{ file: c }]]);
    eq('each with its front document', plan.fronts, [1, 0]);
    eq('and the window the writer was in', plan.frontWindow, 1);
  }

  {
    // Three, because two can pass by accident on an off-by-one.
    const raw = run('write', JSON.stringify({
      windows: [['f:' + a], ['f:' + b], ['f:' + c, 'f:' + d]],
      fronts: [0, 0, 1], frontWindow: 2
    }));
    eq('three windows, two markers',
       raw.openTabs, ['f:' + a, 'w:0', 'f:' + b, 'w:1', 'f:' + c, 'f:' + d]);
    const plan = run('plan', String(CAP));
    eq('and three windows come back', plan.windows.length, 3);
    eq('with the last one\'s second document in front', plan.fronts, [0, 0, 1]);
    eq('and the last window in front', plan.frontWindow, 2);
  }

  {
    // A marker is a thing an older build cannot mistake for a document. It has
    // to be skipped there rather than half-understood, and this is why: nothing
    // on disk is ever called "w:0".
    const raw = run('write', JSON.stringify({
      windows: [['f:' + a], ['f:' + b]], fronts: [0, 0], frontWindow: 0
    }));
    const marks = raw.openTabs.filter(e => e.startsWith('w:'));
    eq('the marker is exactly a window number', marks, ['w:0']);
    ok('and names nothing on disk, so an older build skips it',
       marks.every(m => !fs.existsSync(m) && !path.isAbsolute(m)));
  }

  {
    // Where a window that had nothing in it goes: nowhere. An untitled document
    // nobody has typed in is not in the session, so the window is an empty group.
    run('set', JSON.stringify({
      openTabs: ['w:0', 'f:' + a], activeTabIndex: 0, frontWindowIndex: 1
    }));
    const plan = run('plan', String(CAP));
    eq('a window the session left empty is not a window to make',
       plan.windows, [[{ file: a }]]);
    eq('and the front window follows it down', plan.frontWindow, 0);
  }

  {
    // The cap is the launch's, not each window's, which is the whole point of
    // settling the session in one pass.
    const windows = [[], []];
    for (let i = 0; i < CAP; i++) windows[0].push('f:' + doc('big-a-' + i + '.md'));
    for (let i = 0; i < 5; i++) windows[1].push('f:' + doc('big-b-' + i + '.md'));
    run('write', JSON.stringify({ windows, fronts: [0, 0], frontWindow: 0 }));
    const plan = run('plan', String(CAP));
    const total = plan.windows.reduce((n, w) => n + w.length, 0);
    eq('the cap on a launch holds across windows rather than per window',
       total, CAP);
  }

  {
    // A path that has gone since the session was written is dropped, and the
    // front seat is clamped rather than pointing past the end.
    const gone = path.join(docs, 'gone.md');
    run('set', JSON.stringify({
      openTabs: ['f:' + a, 'w:2', 'f:' + gone, 'f:' + b],
      activeTabIndex: 0, frontWindowIndex: 1
    }));
    const plan = run('plan', String(CAP));
    eq('a file that has gone is left out', plan.windows, [[{ file: a }], [{ file: b }]]);
    eq('and a front seat past the end of what came back is clamped',
       plan.fronts, [0, 0]);
  }

  // ------------------------------------------------------------------
  console.log('\nan old single-window session still restores\n');

  {
    // Exactly what the build before this one wrote: one flat strip, no marker,
    // no window key at all.
    run('set', JSON.stringify({
      openTabs: ['f:' + a, 'f:' + b, 'f:' + c],
      activeTabIndex: 2,
      frontWindowIndex: null
    }));
    const g = run('groups');
    eq('a strip with no markers is one window', g.windows.length, 1);
    eq('holding every document it named', g.windows[0], ['f:' + a, 'f:' + b, 'f:' + c]);
    eq('with the seat that was in front', g.fronts, [2]);
    eq('and no window key means the only window there was', g.frontWindow, 0);

    const plan = run('plan', String(CAP));
    eq('and it comes back as one window of three documents',
       plan.windows, [[{ file: a }, { file: b }, { file: c }]]);
    eq('front seat kept', plan.fronts, [2]);
    eq('front window is the one window', plan.frontWindow, 0);
  }

  {
    // A one-window session written by THIS build, read by this build: the same
    // array an older build would have written, which is what makes the two
    // interchangeable rather than merely tolerated.
    const raw = run('write', JSON.stringify({
      windows: [['f:' + a, 'f:' + b]], fronts: [1], frontWindow: 0
    }));
    eq('one window goes out with no marker in it', raw.openTabs, ['f:' + a, 'f:' + b]);
    eq('and its front seat in the old key', raw.activeTabIndex, 1);
  }

  {
    // Older still: before there were tabs there were only paths.
    run('set', JSON.stringify({
      openTabs: null,
      activeTabIndex: null,
      frontWindowIndex: null,
      openDocumentPaths: [a, c],
      activeDocumentIndex: 1
    }));
    const plan = run('plan', String(CAP));
    eq('the paths-only keys still reopen, as one window',
       plan.windows, [[{ file: a }, { file: c }]]);
    eq('with the document that was in front', plan.fronts, [1]);
  }

  {
    // And older again: one document, one path.
    run('set', JSON.stringify({
      openTabs: null, activeTabIndex: null, frontWindowIndex: null,
      openDocumentPaths: null, activeDocumentIndex: null,
      lastDocumentPath: b
    }));
    const plan = run('plan', String(CAP));
    eq('the single-document key still reopens, as one window',
       plan.windows, [[{ file: b }]]);
  }

  {
    run('set', JSON.stringify({
      openTabs: null, activeTabIndex: null, frontWindowIndex: null,
      openDocumentPaths: null, activeDocumentIndex: null, lastDocumentPath: null
    }));
    const plan = run('plan', String(CAP));
    eq('nothing recorded reopens nothing, which is the welcome document',
       plan.windows, []);
  }

  // ------------------------------------------------------------------
  console.log('\nunsaved buffers, with windows in the way\n');

  {
    run('buffer', uuid(1), 'the buffer in the first window\n');
    run('buffer', uuid(2), 'the buffer in the second\n');
    run('set', JSON.stringify({
      openTabs: ['f:' + a, 's:' + uuid(1), 'w:0', 's:' + uuid(2)],
      activeTabIndex: 1, frontWindowIndex: 0,
      openDocumentPaths: null, activeDocumentIndex: null, lastDocumentPath: null
    }));
    const plan = run('plan', String(CAP));
    eq('a buffer comes back in the window it was in',
       plan.windows,
       [[{ file: a }, { buffer: uuid(1), text: 'the buffer in the first window\n' }],
        [{ buffer: uuid(2), text: 'the buffer in the second\n' }]]);
  }

  {
    // A buffer on disk the session never mentions is what a crash leaves
    // behind. It is offered back at the end of the strip, and with windows the
    // end of the strip is the end of the last window.
    run('buffer', uuid(3), 'written, then the power went\n');
    run('set', JSON.stringify({
      openTabs: ['f:' + a, 's:' + uuid(1), 'w:0', 's:' + uuid(2)],
      activeTabIndex: 0, frontWindowIndex: 0
    }));
    const plan = run('plan', String(CAP));
    eq('a buffer the session never mentioned is offered back at the end',
       plan.windows[1],
       [{ buffer: uuid(2), text: 'the buffer in the second\n' },
        { buffer: uuid(3), text: 'written, then the power went\n' }]);
    eq('and the windows before it are untouched',
       plan.windows[0],
       [{ file: a }, { buffer: uuid(1), text: 'the buffer in the first window\n' }]);
  }

  {
    // A buffer named twice is one buffer, wherever the two mentions are: the
    // same rule as a path, for the same reason.
    run('set', JSON.stringify({
      openTabs: ['s:' + uuid(1), 'w:0', 's:' + uuid(1), 'f:' + a],
      activeTabIndex: 0, frontWindowIndex: 0
    }));
    const plan = run('plan', String(CAP));
    eq('a buffer named in two windows is seated once',
       plan.windows[0].concat(plan.windows[1]).filter(s => s.buffer === uuid(1)).length, 1);
  }

  // ------------------------------------------------------------------
  console.log('\none question at a time, asked where the writer is looking\n');

  {
    // The poll walks every window and stops at the first document worth asking
    // about, so the order it walks in is the order the questions get asked in.
    const order = run('order', JSON.stringify([[a, b], [c], [d]]));
    eq('every window\'s documents are walked', order.length, 4);
    eq('and the front window\'s come first', order.map(r => r[0]), [0, 0, 1, 2]);
  }

  // ------------------------------------------------------------------
  // The call sites. The lookup above is only worth having if every route into a
  // document actually asks it, and that is the half a refactor breaks quietly.
  console.log('\nevery route into a document asks the app, not a window\n');

  function body(name) { return extract(name); }

  {
    const open = body('    func openDocument(at url: URL');
    eq('openDocument asks before the read and again after it',
       (open.match(/app\.openTab\(for:/g) || []).length, 2);
    ok('and it is the app\'s pending set it claims a path in, not a window\'s',
       open.includes('app.opening.insert('));
    ok('nothing in it looks for an already-open file in this window\'s tabs alone',
       !/tabs\.first\(where:\s*\{\s*\$0\.url\?\.standardizedFileURL == url/.test(open));
  }

  {
    const as = body('    func saveAs(');
    ok('Save As refuses a name something else in the app already has open',
       as.includes('app.openTab(for:'));
  }

  {
    const plan = body('    static func plan(');
    ok('the session applies the rule across every window, not inside each',
       /var seenPaths[\s\S]*for \(w, entries\) in windows\.enumerated\(\)/.test(plan));
  }

  {
    // The rule is only worth anything if the window a document is in can be
    // brought forward, which is the half that makes "one place" a place.
    const reveal = body('    func reveal(_ id: Int)');
    ok('and revealing a document brings its window out and forward',
       reveal.includes('deminiaturize') && reveal.includes('makeKeyAndOrderFront')
       && reveal.includes('activate(id)'));
  }

  {
    // A window that closes has to stop being one of the windows, or every list
    // above is still answering for it.
    const willClose = body('    func windowWillClose(');
    ok('a closing window takes itself out of the app\'s list of windows',
       /app\.editors\.removeAll/.test(willClose));
    ok('…and lets go of what its tabs held on the filesystem\'s behalf',
       /releaseFileWatching/.test(willClose));
    ok('…and asks its page for the history only it still has',
       /fetchHistory/.test(willClose) && /history\.write/.test(willClose));
    ok('…and lets go of the page, which is a process of its own',
       /removeScriptMessageHandler/.test(willClose));
    // The last window is the app going, and the quit path does all of this
    // itself — including asking for the history, which it waits for. A window
    // that took itself out of the list first would send the quit down its
    // no-window path and the wait would never happen.
    ok('and the last window of all leaves every bit of it to the quit',
       /guard app\.editors\.count > 1 else \{ return \}/.test(willClose));

    // AppKit closes every window on the way out of a quit, one at a time. Each
    // of those closes runs this method, and the session write near the bottom
    // of it describes the windows that are LEFT — so without this guard the
    // last window to go leaves a session naming only itself, and a writer who
    // quit with two windows open gets one of them back. The regression that
    // found this was not in the session code at all; it was in the order
    // AppKit chose, which is why the guard is asserted here and by position.
    // A window that closes is released by AppKit *and* by the Editor that owns
    // it going with it, unless the window is told not to release itself. With
    // one window that only ever closed on the way out of the process this was
    // invisible; with two it is a segfault on the first close, landing in a
    // CoreAnimation commit nowhere near the close that caused it. The assertion
    // is on the window's construction rather than on a symptom, because the
    // symptom is a crash in somebody else's frame.
    {
      const build = body('    func buildWindow(');
      ok('a window the Editor owns does not also release itself when it closes',
         /w\.isReleasedWhenClosed = false/.test(build));
      ok('…and the delegate is given up before the Editor is',
         /window\?\.delegate = nil/.test(willClose)
         && willClose.search(/window\?\.delegate = nil/)
            < willClose.search(/app\.editors\.removeAll/));
    }

    ok('a quit closing a window is not the writer closing it',
       /guard !app\.terminating else \{ return \}/.test(willClose));
    const gate = willClose.search(/guard !app\.terminating else \{ return \}/);
    ok('…and that is settled before the window leaves the list',
       gate >= 0 && gate < willClose.search(/app\.editors\.removeAll/));
    ok('…and before anything rewrites the session',
       gate >= 0 && gate < willClose.search(/app\.saveSession\(\)/));
  }

  {
    // The flag those guards read has to still be set when the windows close.
    // The one terminate path that answers .terminateNow used to clear it first,
    // on the grounds that a cancelled attempt must make room for a later one —
    // but this attempt is not cancelled, it is granted, and the windows close
    // immediately after.
    const should = body('    func applicationShouldTerminate(');
    const now = (should.match(/^.*return \.terminateNow.*$/m) || [''])[0];
    ok('a granted quit leaves the flag set for the closes that follow',
       now.includes('.terminateNow') && !/terminating = false/.test(now));
    ok('…and only a cancelled one clears it',
       /if !ok \{ terminating = false/.test(body('    private func replyToTerminate(')));
  }

  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) exitCode = 1;
} catch (e) {
  console.error('\n' + (e && e.stack ? e.stack : String(e)) + '\n');
  exitCode = 1;
} finally {
  cleanup();
}

process.exit(exitCode);
