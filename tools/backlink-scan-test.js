#!/usr/bin/env node
/* ============================================================
   minimark — backlink matching tests

   Given one file's text, does it link to this document, merely mention it, or
   neither. That decision is Swift and it is the whole feature: get it wrong
   and "what links here" either misses the link the writer is looking for or
   fills up with files that have nothing to do with it.

   The parts worth their own test:

     - a link written in a subfolder resolves against *that* folder, not
       against whatever document happens to be open. This is why wikiURL was
       split in two, and the thing a single-argument version got wrong;
     - the label after a pipe is not the name;
     - a mention is a whole word, so "Kestrels" does not match "Kestrel" and
       "notebook" does not match "note";
     - a file that links wins over a file that merely mentions, since a link
       is a fact and a mention is a guess.

   Like the other Swift suites this compiles the real functions out of
   minimark.swift rather than copying them.

   Usage:  node tools/backlink-scan-test.js [swiftFile]
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

/* backlinkKind reaches the resolver and nothing else on the app delegate, so
   the four of them are lifted onto a shell together. */
const harness = `
import Foundation

final class Scanner {
    var docURL: URL?

${extract('func wikiURL(_ raw: String) -> URL? {')}

${extract('func wikiURL(_ raw: String, from dir: URL) -> URL? {')}

${extract('func wikiTargets(in text: String) -> [String] {')}

${extract('func mentions(_ name: String, in text: String) -> Bool {')}

${extract('func backlinkKind(')}
}

let args = CommandLine.arguments
let s = Scanner()
switch args[1] {
case "targets":
    print(s.wikiTargets(in: args[2]).joined(separator: "|"))
case "mentions":
    print(s.mentions(args[2], in: args[3]) ? "yes" : "no")
case "kind":
    // kind <text> <name> <targetPath> <fromDir>
    print(s.backlinkKind(text: args[2], name: args[3],
                         target: URL(fileURLWithPath: args[4]),
                         from: URL(fileURLWithPath: args[5])) ?? "none")
default:
    print("?")
}
`;

const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mm-backlink-')));
const root = path.join(dir, 'root');
fs.mkdirSync(path.join(root, 'chapters'), { recursive: true });
const me = path.join(root, 'chapters', 'one.md');
fs.writeFileSync(me, '## One\n');
fs.writeFileSync(path.join(root, 'one.md'), 'a different file with the same name\n');

const swiftPath = path.join(dir, 'harness.swift');
const bin = path.join(dir, 'harness');
fs.writeFileSync(swiftPath, harness);

console.log('compiling the real matcher out of minimark.swift\n');
try {
  execFileSync('swiftc', ['-O', swiftPath, '-o', bin], { stdio: 'pipe' });
} catch (e) {
  console.log('  FAIL  the extracted matcher does not compile');
  console.log(String(e.stderr || e.stdout).split('\n').slice(0, 20).map(l => '        ' + l).join('\n'));
  process.exit(1);
}

const targets = text => execFileSync(bin, ['targets', text], { encoding: 'utf8' }).trim();
const mentions = (name, text) =>
  execFileSync(bin, ['mentions', name, text], { encoding: 'utf8' }).trim();
/* `from` is the folder the linking file sits in */
const kind = (text, from) =>
  execFileSync(bin, ['kind', text, 'one', me, from], { encoding: 'utf8' }).trim();

console.log('which names a file links to\n');

ok('a plain wikilink', targets('see [[Another note]] here') === 'Another note');
ok('several, in order', targets('[[a]] then [[b]]') === 'a|b');
ok('an embed counts as a link', targets('![[chapter-two]]') === 'chapter-two');
ok('the label after a pipe is not the name',
   targets('[[Another note|called this]]') === 'Another note', targets('[[Another note|called this]]'));
ok('a link with no name is not a link', targets('[[|only a label]]') === '',
   targets('[[|only a label]]'));
ok('an unclosed link is not a link', targets('[[never closed') === '');
ok('a newline ends it', targets('[[one\ntwo]]') === '');
ok('a subfolder path survives', targets('[[chapters/one]]') === 'chapters/one');
ok('empty brackets are nothing', targets('[[]]') === '');
ok('a single bracket is nothing', targets('[not a wikilink]') === '');

console.log('\nwhen a name counts as a mention\n');

ok('on its own', mentions('kestrel', 'the kestrel returned') === 'yes');
ok('ignoring case', mentions('Kestrel', 'a KESTREL, at dusk') === 'yes');
ok('at the very start', mentions('kestrel', 'kestrel at dusk') === 'yes');
ok('at the very end', mentions('kestrel', 'at dusk, a kestrel') === 'yes');
ok('next to punctuation', mentions('kestrel', 'the kestrel, again') === 'yes');
ok('but not as part of a longer word', mentions('kestrel', 'kestrels returned') === 'no',
   mentions('kestrel', 'kestrels returned'));
ok('nor with a letter in front', mentions('note', 'a footnote here') === 'no');
ok('nor inside a word at both ends', mentions('note', 'notebook') === 'no');
ok('a name that is nowhere is not a mention', mentions('kestrel', 'buzzards only') === 'no');
ok('a later occurrence still counts when the first is glued to a word',
   mentions('note', 'notebook, and then a note') === 'yes',
   mentions('note', 'notebook, and then a note'));

console.log('\nlink, mention, or neither\n');

const sameFolder = path.join(root, 'chapters');
ok('a link from the same folder resolves', kind('see [[one]]', sameFolder) === 'link',
   kind('see [[one]]', sameFolder));
ok('the same link from the parent folder points somewhere else',
   kind('see [[one]]', root) !== 'link', kind('see [[one]]', root));
ok('and from the parent it needs the subfolder',
   kind('see [[chapters/one]]', root) === 'link', kind('see [[chapters/one]]', root));
ok('an embed of it is a link too', kind('![[one]]', sameFolder) === 'link');
ok('a label does not stop it resolving',
   kind('[[one|the first chapter]]', sameFolder) === 'link');
ok('the name in prose is only a mention',
   kind('as covered in one, earlier', sameFolder) === 'mention',
   kind('as covered in one, earlier', sameFolder));
ok('a link outranks a mention in the same file',
   kind('one is covered in [[one]]', sameFolder) === 'link');
ok('a file with neither says neither',
   kind('nothing to do with it', sameFolder) === 'none');
ok('a link that climbs out is not a link to anything',
   kind('[[../one]]', sameFolder) !== 'link', kind('[[../one]]', sameFolder));

fs.rmSync(dir, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
