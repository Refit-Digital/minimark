#!/usr/bin/env node
/* ============================================================
   minimark — unsaved buffer and rename tests

   Two bugs this stands guard over, both of which cost somebody their work
   rather than their patience:

   1. An Untitled document was never written anywhere. scheduleAutosave
      returned early unless some tab had a URL, so everything typed before the
      first ⌘S lived in one WKWebView's memory and nowhere else. A normal quit
      asked; a crash, a force quit, a power cut or a WebContent crash did not.
      Untitled buffers now go to ~/Library/Application Support/minimark/unsaved/
      on the same one second debounce, and come back at the next launch.

   2. Rename stripped / and : and trimmed whitespace, and stopped there. A
      rename to ".notes" left the file on disk and invisible to Finder and to
      every open panel in the system, which is indistinguishable from having
      destroyed it.

   Like the encoding tests, this cannot be a browser test: it is Swift, and it
   is about files on disk. So it compiles the real Scratch store and the real
   filename sanitiser out of minimark.swift into a throwaway binary and runs
   actual files through them. Extracted rather than copied, because a copy is
   worthless the moment the two drift.

   Usage:  node tools/unsaved-test.js [swiftFile]
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

/* Scratch reaches its folder through Templates.dir, which is the real
   Application Support. The stub below is the only thing in this harness that
   is not the app's own code, and it exists so the test writes into a temporary
   directory instead of over somebody's actual unsaved work. */
const harness = `
import Foundation

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

/* sanitiseFilename is a method on the app delegate and touches nothing on it,
   so it is lifted onto a shell of its own rather than being reimplemented. */
final class Renamer {
${extract('func sanitiseFilename(')}
}

let args = CommandLine.arguments
switch args[1] {
case "write":
    print(Scratch.write(args[3], id: args[2]) ? "wrote" : "refused")
case "read":
    print(Scratch.read(args[2]) ?? "<nil>")
case "remove":
    Scratch.remove(args[2])
    print("done")
case "all":
    print(Scratch.all().joined(separator: ","))
case "path":
    print(Scratch.url(args[2])?.path ?? "<nil>")
case "rename":
    print(Renamer().sanitiseFilename(args[2], keepingExtension: args[3]) ?? "<nil>")
default:
    print("?")
}
`;

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-unsaved-'));
const support = path.join(dir, 'support');
const unsaved = path.join(support, 'unsaved');
const swiftPath = path.join(dir, 'harness.swift');
const bin = path.join(dir, 'harness');
fs.writeFileSync(swiftPath, harness);

console.log('compiling the real unsaved store out of minimark.swift\n');
try {
  execFileSync('swiftc', ['-O', swiftPath, '-o', bin], { stdio: 'pipe' });
} catch (e) {
  console.log('  FAIL  the extracted store does not compile');
  console.log(String(e.stderr || e.stdout).split('\n').slice(0, 20).map(l => '        ' + l).join('\n'));
  process.exit(1);
}

const run = (...a) => execFileSync(bin, a, {
  encoding: 'utf8',
  env: Object.assign({}, process.env, { MM_TEST_SUPPORT: support })
}).trim();

const ID = '3F2504E0-4F89-41D3-9A0C-0305E82C3301';
const ID2 = '7B8A1C22-90D5-4E6B-8F31-1E9C4A55B0D2';

console.log('an untitled buffer survives the process\n');

const page = '# Notes\n\nEverything typed before the first ⌘S.\n';
ok('a buffer is written', run('write', ID, page) === 'wrote', run('write', ID, page));
ok('and it lands in unsaved/, not loose in Application Support',
   fs.existsSync(path.join(unsaved, ID + '.md')),
   fs.existsSync(unsaved) ? fs.readdirSync(unsaved).join(', ') : 'no unsaved/ at all');
ok('and it reads back exactly as it went in', run('read', ID) === page.trim(), run('read', ID));

ok('a second buffer does not disturb the first',
   run('write', ID2, 'other') === 'wrote' && run('read', ID) === page.trim());
ok('both are offered back at launch',
   run('all').split(',').sort().join(',') === [ID, ID2].sort().join(','), run('all'));

ok('removing one takes it out of the offer',
   (run('remove', ID2), run('all')) === ID, run('all'));
ok('and removing one that is not there is not an error',
   run('remove', ID2) === 'done');

console.log('\nthe id names a file, and only a file\n');

/* The id is the app's own, but it reaches Scratch from a preference — a file
   anybody can edit — and it names a path the app writes to unprompted. */
ok('a traversal is refused rather than resolved',
   run('path', '../../../../tmp/evil') === '<nil>', run('path', '../../../../tmp/evil'));
ok('and writing through one writes nothing',
   run('write', '../../../../tmp/mm-evil', 'x') === 'refused');
ok('/tmp/mm-evil.md was not created', !fs.existsSync('/tmp/mm-evil.md'));
ok('a plain word is not a valid id either',
   run('path', 'notes') === '<nil>', run('path', 'notes'));
ok('nor is a UUID with something appended',
   run('path', ID + '/../x') === '<nil>');
ok('a real UUID resolves',
   run('path', ID).endsWith(path.join('unsaved', ID + '.md')), run('path', ID));

console.log('\nrename cannot make the file disappear\n');

ok('a leading dot is stripped rather than hiding the file',
   run('rename', '.notes', 'md') === 'notes.md', run('rename', '.notes', 'md'));
ok('and so is a run of them',
   run('rename', '...notes', 'md') === 'notes.md', run('rename', '...notes', 'md'));
ok('"..", which is the same slip and worse, comes back as nothing to do',
   run('rename', '..', 'md') === '<nil>', run('rename', '..', 'md'));
ok('a name that is only dots and spaces is nothing to do',
   run('rename', ' .  ', 'md') === '<nil>', run('rename', ' .  ', 'md'));

ok('separators are still replaced, both of them',
   run('rename', 'a/b:c', 'md') === 'a-b-c.md', run('rename', 'a/b:c', 'md'));
ok('the old extension is put back when none was typed',
   run('rename', 'drafts', 'md') === 'drafts.md');
ok('and a typed extension is left alone',
   run('rename', 'drafts.txt', 'md') === 'drafts.txt');
ok('an extensionless document stays extensionless',
   run('rename', 'drafts', '') === 'drafts');
ok('surrounding whitespace is trimmed',
   run('rename', '  drafts  ', 'md') === 'drafts.md');
/* The guarantee is not what any one of these becomes — it is that none of
   them becomes a file Finder will never show again. */
['.notes', '..notes', ' .notes ', '/.hidden', '.', '. .', '.a'].forEach(function (raw) {
  const out = run('rename', raw, 'md');
  ok(`"${raw}" cannot produce a hidden file`,
     out === '<nil>' || !out.startsWith('.'), out);
});

fs.rmSync(dir, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
