#!/usr/bin/env node
/* ============================================================
   minimark — encoding tests

   The bug this stands guard over: readText ended with
   String(decoding:as:UTF8.self), which never fails and substitutes U+FFFD for
   every byte it cannot make sense of. Open a Latin-1 file, type one
   character, and the autosave a second later wrote the replacement characters
   over the original. No undo on disk, and nothing said it had happened.

   This is the one part of the app where a test cannot be a browser test: the
   whole thing is Swift, and it is about bytes on disk. So it compiles the
   real decoder and writer out of minimark.swift into a throwaway command line
   binary and runs actual files through it. The source is extracted from the
   shipped file rather than copied, for the same reason the history tests
   extract theirs: a copy is worthless the moment the two drift.

   Usage:  node tools/encoding-test.js [swiftFile]
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

/* Pull the two functions out of the app by name, braces balanced, so the
   harness cannot quietly test a stale copy of them. */
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

const struct = (() => {
  const at = src.indexOf('struct TextFile {');
  let depth = 0;
  for (let j = src.indexOf('{', at); j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}' && --depth === 0) return src.slice(at, j + 1);
  }
})();

/* `static` is fine on a method and a compile error on a free function, and
   these come out of the app as methods. `private` stays: it is legal at file
   scope and it is part of what the app says about them. Nothing else changes. */
const unstatic = (name) =>
  extract(name).replace(/^(\s*)((?:private |fileprivate )?)static /m, '$1$2');

const harness = `
import Foundation
${extract('let kCoordinationTimeout')}
${extract('enum Coordinated')}
${struct}
${extract('enum WriteOutcome')}
${extract('func looksBinary')}
${extract('func decodeTextFile')}
${unstatic('private static func carryXattrs')}
${unstatic('private static func replaceContents')}
${unstatic('static func writeToDisk')}

/* The app's own write, asked the question this test asks: did the file keep
   its encoding, or did the text outgrow it? Extracted rather than restated —
   a second copy of the promotion rule would agree with the first exactly
   until the day it mattered.
   Asynchronous now, because coordination is: the app never blocks a thread
   waiting for a file somebody else is holding, so neither does this. Main
   keeps turning until the answer lands, exactly as the app's does. */
func writeBack(_ text: String, to url: URL, read f: TextFile) -> String {
    var answer = "?"
    let sem = DispatchSemaphore(value: 0)
    // .update, because every write this test makes is a save of a file it has
    // just read. What that intent means, and why the disk cannot answer it, is
    // coordination-test's business rather than this one's — and so is the
    // base the save expects to find, which is the bytes this read decoded,
    // exactly as the app records it on opening a document.
    let base = Coordinated.Base()
    base.rebase(to: f.fingerprint)
    writeToDisk(text, to: url, encoding: f.encoding, intent: .update,
                expecting: base.ticket(), presenter: nil) { outcome, _ in
        switch outcome {
        case .wrote(let promoted): answer = promoted ? "promoted" : "kept"
        case .failed(let why):     answer = "failed\\t\\(why)"
        case .vanished(let why):   answer = "vanished\\t\\(why)"
        case .conflict(let why):   answer = "conflict\\t\\(why)"
        case .superseded:          answer = "superseded"
        }
        sem.signal()
    }
    while sem.wait(timeout: .now()) == .timedOut {
        RunLoop.main.run(mode: .default, before: Date().addingTimeInterval(0.02))
    }
    return answer
}

let args = CommandLine.arguments
let url = URL(fileURLWithPath: args[2])
switch args[1] {
case "read":
    if let f = decodeTextFile(url) {
        print("ok\\t\\(f.label)\\t\\(f.text.count)")
    } else {
        print("refused")
    }
case "roundtrip":
    guard let f = decodeTextFile(url) else { print("refused"); exit(0) }
    let edited = args.count > 3 ? f.text + args[3] : f.text
    let how = writeBack(edited, to: url, read: f)
    print("\\(how)\\t\\(f.label)")
default:
    print("?")
}
`;

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-enc-'));
const swiftPath = path.join(dir, 'harness.swift');
const bin = path.join(dir, 'harness');
fs.writeFileSync(swiftPath, harness);

console.log('compiling the real decoder out of minimark.swift\n');
try {
  execFileSync('swiftc', ['-O', swiftPath, '-o', bin], { stdio: 'pipe' });
} catch (e) {
  console.log('  FAIL  the extracted decoder does not compile');
  console.log(String(e.stderr || e.stdout).split('\n').slice(0, 20).map(l => '        ' + l).join('\n'));
  process.exit(1);
}

const run = (...a) => execFileSync(bin, a, { encoding: 'utf8' }).trim();
const file = (name, buf) => {
  const p = path.join(dir, name);
  fs.writeFileSync(p, buf);
  return p;
};

console.log('reading\n');

const utf8 = file('utf8.md', Buffer.from('# Héllo\n\nA café, naïvely.\n', 'utf8'));
ok('a UTF-8 file reads as UTF-8', run('read', utf8).split('\t')[1] === 'UTF-8', run('read', utf8));

/* The file that used to be destroyed. 0xE9 is é in Latin-1 and is not valid
   UTF-8 at all. */
const latin1 = file('latin1.md', Buffer.from([0x48, 0x69, 0x20, 0x63, 0x61, 0x66, 0xE9, 0x0A]));
const l1 = run('read', latin1).split('\t');
ok('a Latin-1 file is not refused', l1[0] === 'ok', run('read', latin1));
ok('and is reported as an assumption, not a fact',
   l1[1] === 'Latin-1 (assumed)', run('read', latin1));
ok('and decodes to the right characters, not to U+FFFD',
   Number(l1[2]) === 8, run('read', latin1));

const utf16le = file('utf16.md', Buffer.concat([Buffer.from([0xFF, 0xFE]),
  Buffer.from('Hi café\n', 'utf16le')]));
ok('a UTF-16 file with a BOM is read by its BOM',
   run('read', utf16le).split('\t')[1] === 'UTF-16 LE', run('read', utf16le));

/* And the one that should never open at all. */
const png = file('picture.png', Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A,
  0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52]));
ok('a binary file is refused rather than opened', run('read', png) === 'refused', run('read', png));

const withNul = file('nul.md', Buffer.from([0x68, 0x69, 0x00, 0x74, 0x68, 0x65, 0x72, 0x65]));
ok('and so is anything with a stray NUL in it', run('read', withNul) === 'refused');

console.log('\nwriting back\n');

/* The heart of it: read, edit, save, and the bytes that were not touched are
   the bytes that were there. */
const before = fs.readFileSync(latin1);
const rt = run('roundtrip', latin1, ' ok');
ok('a Latin-1 file is written back as Latin-1', rt.split('\t')[0] === 'kept', rt);
const after = fs.readFileSync(latin1);
ok('and its existing bytes are untouched',
   after.slice(0, before.length - 1).equals(before.slice(0, before.length - 1)),
   `${before.toString('hex')} -> ${after.toString('hex')}`);
ok('specifically, the 0xE9 survived rather than becoming U+FFFD',
   after.includes(0xE9) && !after.includes(Buffer.from('�', 'utf8')),
   after.toString('hex'));

/* Typing something the old encoding cannot hold must convert the file, not
   fail and not mangle it. */
const latin2 = file('latin2.md', Buffer.from([0x63, 0x61, 0x66, 0xE9, 0x0A]));
const promoted = run('roundtrip', latin2, ' 🎉');
ok('typing a character Latin-1 cannot hold promotes the file to UTF-8',
   promoted.split('\t')[0] === 'promoted', promoted);
const promotedBytes = fs.readFileSync(latin2);
ok('and the result is valid UTF-8 with both the old text and the new',
   promotedBytes.toString('utf8').includes('café') &&
   promotedBytes.toString('utf8').includes('🎉'),
   promotedBytes.toString('utf8'));

/* "kept", not "promoted". The distinction is the whole point of the flag: it
   is what decides whether the writer is told "Saved as UTF-8 — the new text
   needed it", and a file that was UTF-8 all along has nothing to be told. The
   copy of the write path this harness used to carry returned "promoted" here,
   because it could not tell the two apart; the app always could. */
const u8 = file('plain.md', Buffer.from('just words\n', 'utf8'));
ok('a UTF-8 file stays UTF-8 and says nothing about it',
   run('roundtrip', u8, ' more').split('\t')[0] === 'kept');
ok('and the new text is on disk',
   fs.readFileSync(u8, 'utf8') === 'just words\n more');

fs.rmSync(dir, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
