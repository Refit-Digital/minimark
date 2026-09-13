#!/usr/bin/env node
/* ============================================================
   minimark — authorship tests

   iA Writer keeps who wrote what at the end of a Markdown file, in a block
   it publishes as Markdown Annotations. minimark takes that block off before
   the page sees the text and puts it back on every write, with the ranges
   carried through the edit and the hash taken again. Get it wrong and iA
   reports the file's authorship as misplaced — or, worse, a block that was
   already wrong gets a fresh hash and nobody can ever tell.

   Like the encoding tests, this compiles the real code out of minimark.swift
   and runs files through it. The expectations in authorship-fixtures.json
   were not written by hand: they are what iA Writer's own `writer` tool
   (8.0.6) wrote for the same files and the same edits, so "matches iA" here
   means byte for byte.

   Usage:  node tools/authorship-test.js [swiftFile]
   ============================================================ */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const swiftFile = process.argv[2] || path.resolve(__dirname, '..', 'minimark.swift');
const src = fs.readFileSync(swiftFile, 'utf8');
const fx = JSON.parse(fs.readFileSync(path.join(__dirname, 'authorship-fixtures.json'), 'utf8'));

let passed = 0, failed = 0;
const ok = (name, cond, detail) => {
  if (cond) { passed++; console.log(`  ok    ${name}`); }
  else { failed++; console.log(`  FAIL  ${name}${detail ? '\n        ' + detail : ''}`); }
};
const show = (s) => JSON.stringify(s);

/* The struct out of the app by name, braces balanced, so the harness cannot
   quietly test a stale copy of it. */
function extract(marker) {
  const at = src.indexOf(marker);
  if (at < 0) throw new Error(`could not find ${marker} in ${swiftFile}`);
  let depth = 0;
  for (let j = src.indexOf('{', at); j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}' && --depth === 0) return src.slice(at, j + 1);
  }
  throw new Error(`unbalanced braces after ${marker}`);
}

const harness = `
import Foundation
import CryptoKit
${extract('struct Authorship {')}

/* The shell's half: carryAuthorship, lifted out of AppDelegate as it is, on a
   DocTab with the one property it touches. */
final class DocTab { var authorship: Authorship? }
final class Shell {
${extract('    private func carryAuthorship')}
    func carry(_ text: String, for tab: DocTab?) -> (String, () -> Void) { carryAuthorship(text, for: tab) }
}

func shellChecks() -> [String: Bool] {
    let shell = Shell()
    let file = "One. A1. Two. B1. A2. Three.\\n\\n---\\nAnnotations: 0,29 SHA-256 275985ec6b9c3879871e  \\n@Ann: 5,8 17,3  \\n&Bot: 13,4  \\n...\\n"
    let original = "One. A1. Two. B1. A2. Three.\\n"
    let text = "Zero. " + original
    var r: [String: Bool] = [:]

    let tab = DocTab()
    tab.authorship = Authorship.split(file)
    let expected = tab.authorship!.carried(to: text).file
    let (onDisk, commit) = shell.carry(text, for: tab)
    r["the write carries the block, moved"] = onDisk == expected && onDisk.hasPrefix(text)
    r["the tab keeps the old block until the write lands"] = tab.authorship?.body == original
    commit()
    r["and moves on once it has"] = tab.authorship?.body == text && tab.authorship?.block != nil

    let (_, late) = shell.carry("Again. " + text, for: tab)
    tab.authorship = Authorship.split(file)            // a reload landed while the write was out
    late()
    r["a write landing after a reload does not undo the reload"] = tab.authorship?.body == original

    let plain = DocTab()
    let (bytes, nothing) = shell.carry(text, for: plain)
    nothing()
    r["a document without a block is written as it is"] = bytes == text && plain.authorship == nil
    r["and so is a write with no tab"] = shell.carry(text, for: nil).0 == text
    return r
}

let ops = try! JSONSerialization.jsonObject(with: FileHandle.standardInput.readDataToEndOfFile()) as! [[String: Any]]
var out: [Any] = []
for op in ops {
    if op["shell"] != nil { out.append(shellChecks()); continue }
    guard let kept = Authorship.split(op["file"] as! String) else { out.append(NSNull()); continue }
    guard let text = op["text"] as? String else {
        out.append(["body": kept.body, "tail": kept.tail, "maintained": kept.block != nil])
        continue
    }
    let started = Date()
    let carried = kept.carried(to: text)
    out.append(["file": carried.file, "maintained": carried.next.block != nil,
                "ms": Date().timeIntervalSince(started) * 1000])
}
FileHandle.standardOutput.write(try! JSONSerialization.data(withJSONObject: out))
`;

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'minimark-authorship-'));
const main = path.join(dir, 'main.swift');
const bin = path.join(dir, 'authorship');
fs.writeFileSync(main, harness);
console.log('compiling Authorship out of minimark.swift…');
execFileSync('swiftc', ['-O', main, '-o', bin], { stdio: 'inherit' });

/* One process per batch: each op is a split, or a split and a carry. */
const run = (ops) => JSON.parse(execFileSync(bin, {
  input: JSON.stringify(ops), maxBuffer: 512 * 1024 * 1024,
}).toString('utf8'));

const segmenter = new Intl.Segmenter('en', { granularity: 'grapheme' });
const graphemes = (s) => Array.from(segmenter.segment(s), (x) => x.segment);

/* ------------------------------------------------------------
   1. Against iA Writer
   ------------------------------------------------------------ */
console.log('\nagainst iA Writer’s own writer tool');

const bases = Object.entries(fx.bases);
const baseSplits = run(bases.map(([, file]) => ({ file })));
bases.forEach(([name, file], i) => {
  const s = baseSplits[i];
  ok(`reads iA’s block and vouches for it: ${name}`, s && s.maintained, show(s));
  ok(`page text has no block in it: ${name}`, s && !/\n---\r?\n(Annotations|@|&)/.test(s.body), show(s && s.body));
});
const untouched = run(bases.map(([, file], i) => ({ file, text: baseSplits[i] ? baseSplits[i].body : '' })));
bases.forEach(([name, file], i) => {
  ok(`an unedited save writes the file back byte for byte: ${name}`,
     untouched[i] && untouched[i].file === file, show(untouched[i] && untouched[i].file));
});

const edits = run(fx.edits.map((e) => ({ file: fx.bases[e.base], text: e.text })));
fx.edits.forEach((e, i) => {
  let want = e.expected;
  /* iA's writer escapes the backslash of a colon it escaped itself on the way
     in, so `<https\://…>` becomes `<https\\\://…>` and grows on every save
     after. minimark writes a key back exactly as it read it. */
  if (e.base === 'zwj') want = want.replace('<https\\\\\\://', '<https\\://');
  const got = edits[i];
  ok(`same file as iA: ${e.base} — ${e.name}`, got && got.file === want,
     `want ${show(want)}\n        got  ${show(got && got.file)}`);
});

const reread = run(fx.edits.map((e) => ({ file: e.expected })));
fx.edits.forEach((e, i) => {
  const s = reread[i];
  ok(`reads back what iA wrote: ${e.base} — ${e.name}`,
     s && s.maintained && s.body === e.text, show(s));
});

/* The example in the spec keeps 32 hex digits, not 20, and its hash leaves
   out the last newline, which the spec allows: the text is the sentence
   without it. */
const specText = 'Markdown Annotations embed authorship in text while preserving its readability and portability.';
const spec = specText + '\n\n---\nAnnotations: 0,95 SHA-256 1132bf5e376a605f5beed4b204456114  \n' +
  '@Human: 0,20 33,4 45,6 62,4  \n&AI: 20,13 37,8 51,11 66,29  \n...\n';
{
  const [s, e] = run([{ file: spec }, { file: spec, text: 'Markdown ' + specText }]);
  ok('the spec’s own example is a block this vouches for', s && s.maintained && s.body === specText, show(s));
  const digits = e && /SHA-256 ([0-9a-f]+)/.exec(e.file);
  ok('a hash is taken again to the length the file kept', digits && digits[1].length === 32, show(e && e.file));
  ok('and the ranges move with the text', e && e.file.includes('@Human: 9,20 42,4 54,6 71,4  \n&AI: 29,13 46,8 60,11 75,29  \n'),
     show(e && e.file));
}

console.log('\nthe shell');
{
  const [checks] = run([{ shell: true }]);
  for (const [name, pass] of Object.entries(checks)) ok(name, pass === true);
}

/* ------------------------------------------------------------
   2. Files that are not this
   ------------------------------------------------------------ */
console.log('\nfiles without a block are left alone');

const plain = [
  ['plain text', 'Just a note.\n'],
  ['ends in an ellipsis', 'And then...\n'],
  ['a YAML document at the end', 'Text\n\n---\ntitle: Notes\n...\n'],
  ['a block whose first line is not a hash', 'Text\n\n---\n@Ann: 0,4  \n...\n'],
  ['a hash too short to be one', 'Text\n\n---\nAnnotations: 0,5 SHA-256 abc123  \n...\n'],
  ['a hash that is not SHA-256', 'Text\n\n---\nAnnotations: 0,5 MD5 275985ec6b9c3879871e  \n...\n'],
  ['front matter and nothing else', '---\ntitle: X\n---\n\nBody.\n'],
  ['empty', ''],
];
run(plain.map(([, file]) => ({ file }))).forEach((s, i) => ok(`no block: ${plain[i][0]}`, s === null, show(s)));

/* ------------------------------------------------------------
   3. Blocks this cannot vouch for
   ------------------------------------------------------------ */
console.log('\nblocks carried as found');

const two = fx.bases.two;
const twoText = 'One. A1. Two. B1. A2. Three.\n';
const stale = two.replace('275985ec6b9c3879871e', '000000ec6b9c3879871e');
const future = two.replace('...\n', 'Session: 42  \n...\n');
const noGap = 'abc\n---\nAnnotations: 0,4 SHA-256 000000000000000000000000  \n@F: 0,3  \n...\n';
{
  const [s1, e1, s2, e2, s3, e3] = run([
    { file: stale }, { file: stale, text: 'Zero. ' + twoText },
    { file: future }, { file: future, text: 'Zero. ' + twoText },
    { file: noGap }, { file: noGap, text: 'abcd' },
  ]);
  ok('a stale hash still hides the block from the page', s1 && s1.body === twoText && !s1.maintained, show(s1));
  ok('a stale hash is not taken again', e1 && e1.file === 'Zero. ' + twoText + stale.slice(twoText.length),
     show(e1 && e1.file));
  ok('an annotation of an unpublished kind is carried as found',
     s2 && !s2.maintained && e2 && e2.file === 'Zero. ' + twoText + future.slice(twoText.length), show(e2));
  ok('the dashes stay at the start of a line when the last newline goes',
     s3 && s3.body === 'abc\n' && e3 && e3.file === 'abcd\n---\nAnnotations: 0,4 SHA-256 000000000000000000000000  \n@F: 0,3  \n...\n',
     show(e3 && e3.file));
}

/* ------------------------------------------------------------
   4. Many edits, checked by what must stay true
   ------------------------------------------------------------ */
console.log('\nrandom edits');

function annotate(text, authors, digits = 20) {
  const n = graphemes(text).length;
  const hash = crypto.createHash('sha256').update(text, 'utf8').digest('hex').slice(0, digits);
  let out = text + (/\n$/.test(text) ? '' : '\n') + '\n---\n' + `Annotations: 0,${n} SHA-256 ${hash}  \n`;
  for (const [key, ranges] of authors) {
    out += `${key}: ${ranges.map(([s, len]) => (len === 1 ? `${s}` : `${s},${len}`)).join(' ')}  \n`;
  }
  return out + '...\n';
}

function authorsOf(file) {
  const block = file.slice(file.lastIndexOf('\n---\n') + 5);
  return block.split('\n').filter((l) => /^[@&*]/.test(l)).map((l) => {
    const at = l.indexOf(': ');
    const ranges = l.slice(at + 2).trim().split(/\s+/).filter(Boolean).map((t) => {
      const [s, len] = t.split(',').map(Number);
      return [s, len === undefined ? 1 : len];
    });
    return [l.slice(0, at), ranges];
  });
}

const attributed = (text, ranges) => {
  const g = graphemes(text);
  return ranges.map(([s, len]) => g.slice(s, s + len).join('')).join('');
};
const isSubsequence = (small, big) => {
  const a = graphemes(small);
  let j = 0;
  for (const x of graphemes(big)) if (j < a.length && a[j] === x) j++;
  return j === a.length;
};

function rng(seed) {
  return () => {
    seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WORDS = ['the', 'draft', 'said', 'nothing', 'about', 'what', 'it', 'meant', 'café', '😀', 'naïve', '👨‍👩‍👧', 'and'];
const PIECES = [' new', 'x', '\n', '😀', 'é', ' — ', '\n\nA new paragraph.\n\n', 'draft'];
const KEYS = ['@Ann', '&Claude <claude.ai>', '*Source'];

function makeDoc(r, paragraphs) {
  const paras = [];
  for (let p = 0; p < paragraphs; p++) {
    const words = [];
    for (let i = 8 + Math.floor(r() * 30); i > 0; i--) words.push(WORDS[Math.floor(r() * WORDS.length)]);
    paras.push(words.join(' ') + '.');
  }
  const text = paras.join('\n\n') + '\n';
  const len = graphemes(text).length;
  const own = KEYS.map(() => []);
  for (let at = 0, who = 0; at < len; who = (who + 1) % 4) {
    const n = 1 + Math.floor(r() * 60);
    if (who < KEYS.length) own[who].push([at, Math.min(n, len - at)]);
    at += n;
  }
  return annotate(text, KEYS.map((k, i) => [k, own[i]]));
}

function edit(r, text, mode) {
  const g = graphemes(text);
  const at = [];
  for (let i = 1 + Math.floor(r() * 5); i > 0; i--) at.push(Math.floor(r() * (g.length + 1)));
  at.sort((x, y) => y - x);                 // from the end, so earlier positions hold still
  for (const p of at) {
    if (mode === 'insert') g.splice(p, 0, ...graphemes(PIECES[Math.floor(r() * PIECES.length)]));
    else if (mode === 'delete') g.splice(p, 1 + Math.floor(r() * 8));
    else g.splice(p, Math.floor(r() * 6), ...graphemes(PIECES[Math.floor(r() * PIECES.length)]));
  }
  return g.join('');
}

for (const mode of ['insert', 'delete', 'replace']) {
  const r = rng(mode.length * 7919);
  let bad = null, rounds = 0, invalid = 0;
  for (let doc = 0; doc < 6 && !bad; doc++) {
    let file = makeDoc(r, 12 + doc * 6);
    for (let round = 0; round < 8 && !bad; round++) {
      const [before] = run([{ file }]);
      const text = edit(r, before.body, mode);
      const [after] = run([{ file, text }]);
      const [check] = run([{ file: after.file }]);
      rounds++;
      if (!check || !check.maintained || check.body !== text) { invalid++; bad = { file, text, after, check }; break; }
      const was = new Map(authorsOf(file)), now = authorsOf(after.file);
      for (const [key, ranges] of now) {
        const old = attributed(before.body, was.get(key)), kept = attributed(text, ranges);
        const fine = mode === 'insert' ? kept === old : isSubsequence(kept, old);
        if (!fine) { bad = { key, mode, old, kept }; break; }
      }
      file = after.file;
    }
  }
  ok(`${mode}: every save leaves a block iA accepts (${rounds} saves)`, invalid === 0, bad && show(bad));
  ok(mode === 'insert'
     ? 'insert: nobody gains or loses a grapheme when nothing of theirs is deleted'
     : `${mode}: what each author keeps is only ever what they had, in order`,
     !bad || invalid > 0, bad && show(bad));
}

/* ------------------------------------------------------------
   5. A save that has to stay quick
   ------------------------------------------------------------ */
console.log('\nlarge documents');
{
  const r = rng(424242);
  const file = makeDoc(r, 2500);
  const [before] = run([{ file }]);
  const replaced = before.body.split('draft').join('manuscript');
  const moved = before.body.replace(/^(.*)\n\n([\s\S]*)$/, '$2\n$1\n');
  const [a, b] = run([{ file, text: replaced }, { file, text: moved }]);
  const [ca, cb] = run([{ file: a.file }, { file: b.file }]);
  const size = graphemes(before.body).length;
  ok(`replace-all across ${size} graphemes finishes promptly (${a.ms.toFixed(0)}ms)`, a.ms < 2000);
  ok('and leaves a block iA accepts', ca && ca.maintained && ca.body === replaced);
  const was = new Map(authorsOf(file));
  ok('and keeps most of what was attributed', authorsOf(a.file).every(([key, ranges]) => {
    const old = attributed(before.body, was.get(key)), kept = attributed(replaced, ranges);
    return isSubsequence(kept, old) && graphemes(kept).length > graphemes(old).length * 0.9;
  }));
  ok(`moving the first paragraph to the end finishes promptly (${b.ms.toFixed(0)}ms)`, b.ms < 2000);
  ok('and leaves a block iA accepts', cb && cb.maintained && cb.body === moved);
}

fs.rmSync(dir, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
