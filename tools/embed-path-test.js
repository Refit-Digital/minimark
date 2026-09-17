#!/usr/bin/env node
/* ============================================================
   minimark — embed and wikilink path tests

   wikiURL is the one function in the app that turns a string a *document*
   wrote into a path the app will open or read. Embeds widened it: a name may
   now descend into a subfolder, because a manuscript keeps its chapters in
   one. Everything it must still refuse is therefore worth a test each, and
   the refusals are the point of this file.

   It may not climb (`..` anywhere, not only at the front), may not start
   anywhere but the document's own folder (no leading `/`, no `~`), may not
   reach a dotfile at any depth, and may not leave the folder by following a
   symlink out of it — which is the one the widening newly makes worth
   planting, and the one `standardizedFileURL` alone does not catch.

   Like the encoding and unsaved tests this is Swift and about real files, so
   it compiles the real resolver out of minimark.swift and runs paths through
   it. Extracted rather than copied, because a copy is worthless the moment
   the two drift.

   Usage:  node tools/embed-path-test.js [swiftFile]
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
   stale copy. */
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

/* wikiURL reads one thing off the app delegate and touches nothing else, so
   it is lifted onto a shell that has exactly that one thing. */
const harness = `
import Foundation

final class Resolver {
    var docURL: URL?

${extract('func wikiURL(')}
}

let args = CommandLine.arguments
let r = Resolver()
r.docURL = args[1].isEmpty ? nil : URL(fileURLWithPath: args[1])
print(r.wikiURL(args[2])?.path ?? "<nil>")
`;

const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mm-embed-')));
const root = path.join(dir, 'root');
const outside = path.join(dir, 'outside');
fs.mkdirSync(path.join(root, 'chapters'), { recursive: true });
fs.mkdirSync(path.join(root, '.git'), { recursive: true });
fs.mkdirSync(outside, { recursive: true });

const doc = path.join(root, 'book.md');
fs.writeFileSync(doc, '# Book\n');
fs.writeFileSync(path.join(root, 'chapters', 'one.md'), '## One\n');
fs.writeFileSync(path.join(root, '.secret.md'), 'hidden\n');
fs.writeFileSync(path.join(root, '.git', 'config'), '[core]\n');
fs.writeFileSync(path.join(outside, 'secrets.md'), 'not yours\n');

/* The escape the widening makes worth trying: a folder inside the document's
   own tree that is really somewhere else. */
fs.symlinkSync(outside, path.join(root, 'elsewhere'));
fs.symlinkSync(path.join(outside, 'secrets.md'), path.join(root, 'shortcut.md'));

const swiftPath = path.join(dir, 'harness.swift');
const bin = path.join(dir, 'harness');
fs.writeFileSync(swiftPath, harness);

console.log('compiling the real resolver out of minimark.swift\n');
try {
  execFileSync('swiftc', ['-O', swiftPath, '-o', bin], { stdio: 'pipe' });
} catch (e) {
  console.log('  FAIL  the extracted resolver does not compile');
  console.log(String(e.stderr || e.stdout).split('\n').slice(0, 20).map(l => '        ' + l).join('\n'));
  process.exit(1);
}

const resolve = name => execFileSync(bin, [doc, name], { encoding: 'utf8' }).trim();
const rel = p => (p === '<nil>' ? p : path.relative(root, p));

console.log('what a name is allowed to reach\n');

ok('a bare name is the file beside the document', rel(resolve('chapter')) === 'chapter.md',
   resolve('chapter'));
ok('.md is added only when there is no extension', rel(resolve('notes.txt')) === 'notes.txt',
   resolve('notes.txt'));
ok('a name may descend into a subfolder',
   rel(resolve('chapters/one')) === path.join('chapters', 'one.md'), resolve('chapters/one'));
ok('with its extension written out', rel(resolve('chapters/one.md')) === path.join('chapters', 'one.md'),
   resolve('chapters/one.md'));
ok('a file that is not there yet still resolves, so a link can create it',
   rel(resolve('chapters/two')) === path.join('chapters', 'two.md'), resolve('chapters/two'));
ok('a space in a name is a space', rel(resolve('Another note')) === 'Another note.md',
   resolve('Another note'));

console.log('\nwhat it is refused\n');

ok('it may not climb out', resolve('../secrets') === '<nil>', resolve('../secrets'));
ok('nor climb from inside a subfolder',
   resolve('chapters/../../outside/secrets') === '<nil>', resolve('chapters/../../outside/secrets'));
ok('nor use .. anywhere at all', resolve('chapters/../one') === '<nil>',
   resolve('chapters/../one'));
ok('nor start at the root of the disk', resolve('/etc/passwd') === '<nil>', resolve('/etc/passwd'));
ok('nor at the home folder', resolve('~/Documents/secrets') === '<nil>',
   resolve('~/Documents/secrets'));
ok('nor name a dotfile', resolve('.secret') === '<nil>', resolve('.secret'));
ok('nor a dotfile deeper down', resolve('.git/config') === '<nil>', resolve('.git/config'));
ok('nor use a colon as a separator', resolve('chapters:one') === '<nil>', resolve('chapters:one'));
ok('nor a backslash', resolve('chapters\\one') === '<nil>', resolve('chapters\\one'));
ok('an empty name is not a name', resolve('') === '<nil>', resolve(''));
ok('nor is a name that is only spaces', resolve('   ') === '<nil>', resolve('   '));
ok('nor a bare dot', resolve('.') === '<nil>', resolve('.'));

console.log('\nsymlinks, which is what widening the rule newly makes worth trying\n');

ok('a symlinked folder pointing out of the tree is refused',
   resolve('elsewhere/secrets') === '<nil>', resolve('elsewhere/secrets'));
ok('and so is a symlinked file pointing out of it',
   resolve('shortcut.md') === '<nil>', resolve('shortcut.md'));

console.log('\nbounds\n');

ok('a name deeper than sixteen components is refused',
   resolve(Array(20).fill('a').join('/')) === '<nil>');
ok('a component longer than 255 characters is refused',
   resolve('x'.repeat(300)) === '<nil>');
ok('but a reasonable depth is fine',
   rel(resolve('a/b/c/one')) === path.join('a', 'b', 'c', 'one.md'), resolve('a/b/c/one'));

console.log('\nwith nowhere to be relative to\n');

const unsaved = execFileSync(bin, ['', 'chapter'], { encoding: 'utf8' }).trim();
ok('an unsaved document has no folder, so it resolves nothing', unsaved === '<nil>', unsaved);

fs.rmSync(dir, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
