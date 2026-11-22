// main.ts is mend, the CLI SPEC.md specifies: one command-line tool that applies the edits AI models write, in
// four formats, to a tree of text files. Node 22, the standard library alone; run it as
// `node main.ts [options] [PATCH]`.
//
// It implements all of SPEC.md: the command line (section 1), the output and exit codes (section 2), files, lines
// and paths (section 3), format detection (section 4), matching lines at three tiers (section 5), unified diffs
// (section 6), SEARCH/REPLACE blocks (section 7), V4A patches (section 8), JSON edits (section 9) and order and
// atomicity (section 10): every file is changed or nothing is.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** A file's text as lines, its own line break and whether it ends with one (SPEC section 3). */
interface FileText {
  lines: string[];
  br: string;
  final: boolean;
}

function parseText(text: string): FileText {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const fin = text.endsWith(br);
  if (fin) parts.pop();
  return { lines: parts, br, final: fin };
}

function renderText(f: FileText): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.final ? f.br : '');
}

function leadWs(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: { old: string; new: string }[] = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/* Matching lines (SPEC section 5). */

function normLine(s: string, tier: number): string {
  if (tier === 0) return s;
  if (tier === 1) return s.replace(/[ \t]+$/, '');
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

/** Every 0-based position at which `old` occurs in `file` at `tier`, from `from` on; occurrences may overlap. */
function occurrences(file: string[], old: string[], tier: number, from = 0): number[] {
  const out: number[] = [];
  if (old.length === 0) return out;
  for (let i = from; i + old.length <= file.length; i++) {
    let ok = true;
    for (let j = 0; j < old.length; j++) {
      if (normLine(file[i + j]!, tier) !== normLine(old[j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier (0, then 1, then 2; only 0 with --strict) at which `old` occurs, with its positions. */
function matchAt(file: string[], old: string[], strict: boolean, from = 0): { tier: number; occ: number[] } | null {
  const top = strict ? 0 : 2;
  for (let t = 0; t <= top; t++) {
    const occ = occurrences(file, old, t, from);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

function reindentLine(text: string, p: string, fws: string): string {
  if (text === '' || text.trim() === '') return text;
  if (text.startsWith(p)) return fws + text.slice(p.length);
  return text;
}

/** One line of N: `ctx >= 0` is a context line, the file's own matched line at O-index ctx; else an added line. */
interface NewPart {
  text: string;
  ctx: number;
  noEol: boolean;
}

/** The lines that replace the matched ones: context lines as the file's own, other lines re-indented at tier 2. */
function buildReplacement(f: FileText, pos: number, oFirst: string, parts: NewPart[], tier: number): string[] {
  const out: string[] = [];
  const fws = leadWs(f.lines[pos] ?? '');
  const pws = leadWs(oFirst);
  for (const part of parts) {
    if (part.ctx >= 0) out.push(f.lines[pos + part.ctx]!);
    else if (tier === 2) out.push(reindentLine(part.text, pws, fws));
    else out.push(part.text);
  }
  return out;
}

/* JSON edits (SPEC section 9). */

/** One JSON edit object (SPEC section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const f = parseText(before);
      if (line < 0 || line > f.lines.length) throw new Fail('no-match', p);
      f.lines.splice(line, 0, ...add);
      tree.now.set(p, renderText(f));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/* Unified diffs (SPEC section 6). */

interface UnifiedHunk {
  a: number;
  o: string[];
  n: NewPart[];
  noEol: boolean;
}

interface UnifiedSection {
  oldPath: string | null;
  newPath: string | null;
  create: boolean;
  del: boolean;
  hunks: UnifiedHunk[];
}

function stripAbPrefix(p: string): string {
  return p.startsWith('a/') || p.startsWith('b/') ? p.slice(2) : p;
}

/** The path of a `--- ` / `+++ ` header line: after the four characters, up to the first tab, spaces removed. */
function headerPath(l: string): string {
  return l.slice(4).split('\t')[0]!.trim();
}

function parseUnified(lines: string[]): UnifiedSection[] {
  const hunkRe = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
  const sections: UnifiedSection[] = [];
  const n = lines.length;
  let i = 0;
  while (i < n) {
    const line = lines[i]!;
    let sec: UnifiedSection;
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      sec = { oldPath: m[1]!, newPath: m[2]!, create: false, del: false, hunks: [] };
      i++;
    } else if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      sec = { oldPath: null, newPath: null, create: false, del: false, hunks: [] };
    } else {
      i++;
      continue;
    }
    let havePair = false;
    let haveRenameOld = false;
    let haveRenameNew = false;
    let inHeader = true;
    while (i < n) {
      const l = lines[i]!;
      if (l.startsWith('diff --git ')) break;
      if (l.startsWith('@@')) {
        const hm = hunkRe.exec(l);
        if (hm === null) throw new Exit2(`error: parse ${i + 1}`);
        inHeader = false;
        const a = Number(hm[1]);
        const body: string[] = [];
        let j = i + 1;
        while (j < n) {
          const bl = lines[j]!;
          if (bl.startsWith('diff --git ')) break;
          if (bl.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
          if (bl === '' || bl.startsWith(' ') || bl.startsWith('-') || bl.startsWith('+') || bl.startsWith('\\')) {
            body.push(bl);
            j++;
          } else break;
        }
        while (body.length > 0 && body[body.length - 1] === '') body.pop();
        const o: string[] = [];
        const np: NewPart[] = [];
        for (let k = 0; k < body.length; k++) {
          const bl = body[k]!;
          const followedByBackslash = k + 1 < body.length && body[k + 1]!.startsWith('\\');
          if (bl === '' || bl.startsWith(' ')) {
            const t = bl === '' ? '' : bl.slice(1);
            o.push(t);
            np.push({ text: t, ctx: o.length - 1, noEol: followedByBackslash });
          } else if (bl.startsWith('-')) {
            o.push(bl.slice(1));
          } else if (bl.startsWith('+')) {
            np.push({ text: bl.slice(1), ctx: -1, noEol: followedByBackslash });
          }
        }
        const noEol = np.length > 0 ? np[np.length - 1]!.noEol : false;
        sec.hunks.push({ a, o, n: np, noEol });
        i = j;
        continue;
      }
      if (l.startsWith('--- ')) {
        if ((lines[i + 1] ?? '').startsWith('+++ ')) {
          if (havePair || !inHeader) break;
          const oldRaw = headerPath(l);
          const newRaw = headerPath(lines[i + 1]!);
          sec.oldPath = oldRaw === '/dev/null' ? null : stripAbPrefix(oldRaw);
          sec.newPath = newRaw === '/dev/null' ? null : stripAbPrefix(newRaw);
          havePair = true;
          i += 2;
          continue;
        }
        if (inHeader) throw new Exit2(`error: parse ${i + 2}`);
        i++;
        continue;
      }
      if (l.startsWith('rename from ') && !havePair && !haveRenameOld) {
        const p = l.slice('rename from '.length).trim();
        sec.oldPath = p === '/dev/null' ? null : p;
        haveRenameOld = true;
        i++;
        continue;
      }
      if (l.startsWith('rename to ') && !havePair && !haveRenameNew) {
        const p = l.slice('rename to '.length).trim();
        sec.newPath = p === '/dev/null' ? null : p;
        haveRenameNew = true;
        i++;
        continue;
      }
      if (l.startsWith('new file mode')) {
        sec.create = true;
        i++;
        continue;
      }
      if (l.startsWith('deleted file mode')) {
        sec.del = true;
        i++;
        continue;
      }
      i++;
    }
    sections.push(sec);
  }
  return sections;
}

/** Apply a section's hunks in order to a file's text; throws Fail on the first hunk that fails. */
function applyUnifiedHunks(text: string, hunks: UnifiedHunk[], strict: boolean, path: string): string {
  const f = parseText(text);
  let d = 0;
  for (const h of hunks) {
    if (h.o.length === 0) {
      const pos = Math.max(0, Math.min(h.a + d, f.lines.length));
      const atEnd = h.a + d >= f.lines.length;
      const rep = h.n.map((p) => p.text);
      f.lines.splice(pos, 0, ...rep);
      if (atEnd) f.final = !h.noEol;
    } else {
      const m = matchAt(f.lines, h.o, strict);
      if (m === null) throw new Fail('no-match', path);
      const target = h.a - 1 + d;
      let best = m.occ[0]!;
      let bestDist = Math.abs(best - target);
      for (const o of m.occ) {
        const dist = Math.abs(o - target);
        if (dist < bestDist) {
          best = o;
          bestDist = dist;
        }
      }
      const atEnd = best + h.o.length >= f.lines.length;
      const rep = buildReplacement(f, best, h.o[0]!, h.n, m.tier);
      f.lines.splice(best, h.o.length, ...rep);
      if (atEnd) f.final = !h.noEol;
    }
    d += h.n.length - h.o.length;
  }
  return renderText(f);
}

function unifiedSectionEdit(s: UnifiedSection, strict: boolean): Edit {
  return (tree) => {
    const oldP = s.oldPath;
    const newP = s.newPath;
    if (oldP !== null && !safe(oldP)) throw new Fail('unsafe', oldP);
    if (newP !== null && !safe(newP)) throw new Fail('unsafe', newP);
    const create = s.create || oldP === null;
    const del = !create && (s.del || newP === null);
    if (create) {
      if (newP === null) return;
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const plus: NewPart[] = [];
      for (const h of s.hunks) for (const p of h.n) if (p.ctx < 0) plus.push(p);
      tree.now.set(newP, plus.length === 0 ? '' : plus.map((p) => p.text).join('\n') + (plus[plus.length - 1]!.noEol ? '' : '\n'));
      return;
    }
    if (del) {
      if (oldP === null) return;
      if (tree.get(oldP) === null) throw new Fail('missing', oldP);
      tree.now.set(oldP, null);
      return;
    }
    if (oldP === null || newP === null) return;
    if (oldP !== newP) {
      const cur = tree.get(oldP);
      if (cur === null) throw new Fail('missing', oldP);
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const out = applyUnifiedHunks(cur, s.hunks, strict, oldP);
      tree.now.set(newP, out);
      tree.now.set(oldP, null);
      tree.moves.push({ old: oldP, new: newP });
      return;
    }
    const cur = tree.get(oldP);
    if (cur === null) throw new Fail('missing', oldP);
    tree.now.set(oldP, applyUnifiedHunks(cur, s.hunks, strict, oldP));
  };
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections = parseUnified(lines);
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((s) => unifiedSectionEdit(s, strict));
}

/* SEARCH/REPLACE blocks (SPEC section 7). */

interface SrBlock {
  path: string;
  old: string[];
  nw: string[];
}

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const blocks: SrBlock[] = [];
  const n = lines.length;
  let i = 0;
  let lastEnd = -1;
  let prevPath: string | null = null;
  while (i < n) {
    if (lines[i]!.trimEnd() === '<<<<<<< SEARCH') {
      const searchLine = i + 1;
      let path: string | null = null;
      for (let j = i - 1; j > lastEnd; j--) {
        const l = lines[j]!;
        if (blank(l)) continue;
        if (l.trim().startsWith('```')) continue;
        path = l.trim();
        break;
      }
      if (path === null) {
        if (prevPath === null) throw new Exit2(`error: parse ${searchLine}`);
        path = prevPath;
      }
      let eq = -1;
      for (let j = i + 1; j < n; j++) {
        if (lines[j]!.trimEnd() === '=======') {
          eq = j;
          break;
        }
        if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') break;
      }
      if (eq < 0) throw new Exit2(`error: parse ${searchLine}`);
      let rep = -1;
      for (let j = eq + 1; j < n; j++) {
        if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
          rep = j;
          break;
        }
      }
      if (rep < 0) throw new Exit2(`error: parse ${searchLine}`);
      blocks.push({ path, old: lines.slice(i + 1, eq), nw: lines.slice(eq + 1, rep) });
      prevPath = path;
      lastEnd = rep;
      i = rep + 1;
    } else {
      i++;
    }
  }
  if (blocks.length === 0) throw new Exit2('error: parse 1');
  return blocks.map((b) => {
    return (tree) => {
      if (!safe(b.path)) throw new Fail('unsafe', b.path);
      if (b.old.length === 0) {
        if (tree.get(b.path) !== null) throw new Fail('exists', b.path);
        tree.now.set(b.path, b.nw.length === 0 ? '' : b.nw.join('\n') + '\n');
        return;
      }
      const cur = tree.get(b.path);
      if (cur === null) throw new Fail('missing', b.path);
      const f = parseText(cur);
      const m = matchAt(f.lines, b.old, strict);
      if (m === null) throw new Fail('no-match', b.path);
      if (m.occ.length > 1) throw new Fail('ambiguous', b.path);
      const pos = m.occ[0]!;
      const parts: NewPart[] = b.nw.map((t) => ({ text: t, ctx: -1, noEol: false }));
      const rep = buildReplacement(f, pos, b.old[0]!, parts, m.tier);
      f.lines.splice(pos, b.old.length, ...rep);
      tree.now.set(b.path, renderText(f));
    };
  });
}

/* V4A patches (SPEC section 8). */

interface V4aChunk {
  anchor: string | null;
  body: string[];
  eof: boolean;
}

interface V4aSection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  moveTo: string | null;
  lines: string[];
  chunks: V4aChunk[];
  updateLine: number;
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k--) {
    if (!blank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const body = lines.slice(first + 1, last);
  const abs = (bi: number): number => first + 2 + bi;
  const sections: V4aSection[] = [];
  let i = 0;
  while (i < body.length) {
    const line = body[i]!;
    if (blank(line)) {
      i++;
      continue;
    }
    let kind: 'add' | 'delete' | 'update';
    let path: string;
    if (line.startsWith('*** Add File: ')) {
      kind = 'add';
      path = line.slice('*** Add File: '.length).trim();
    } else if (line.startsWith('*** Delete File: ')) {
      kind = 'delete';
      path = line.slice('*** Delete File: '.length).trim();
    } else if (line.startsWith('*** Update File: ')) {
      kind = 'update';
      path = line.slice('*** Update File: '.length).trim();
    } else {
      throw new Exit2(`error: parse ${abs(i)}`);
    }
    const updateLine = abs(i);
    i++;
    const raw: number[] = [];
    while (i < body.length) {
      const l = body[i]!;
      if (l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ')) break;
      raw.push(i);
      i++;
    }
    while (raw.length > 0 && blank(body[raw[raw.length - 1]!]!)) raw.pop();
    if (kind === 'add') {
      const fileLines: string[] = [];
      for (const ri of raw) {
        const l = body[ri]!;
        if (l.startsWith('+')) fileLines.push(l.slice(1));
        else if (l === '') fileLines.push('');
        else throw new Exit2(`error: parse ${abs(ri)}`);
      }
      sections.push({ kind, path, moveTo: null, lines: fileLines, chunks: [], updateLine });
    } else if (kind === 'delete') {
      for (const ri of raw) {
        if (!blank(body[ri]!)) throw new Exit2(`error: parse ${abs(ri)}`);
      }
      sections.push({ kind, path, moveTo: null, lines: [], chunks: [], updateLine });
    } else {
      let moveTo: string | null = null;
      const chunks: V4aChunk[] = [];
      let cur: V4aChunk | null = null;
      for (let r = 0; r < raw.length; r++) {
        const ri = raw[r]!;
        const l = body[ri]!;
        if (r === 0 && l.startsWith('*** Move to: ')) {
          moveTo = l.slice('*** Move to: '.length).trim();
          continue;
        }
        if (l.startsWith('@@')) {
          const anchor = l.slice(2).trim();
          cur = { anchor: anchor === '' ? null : anchor, body: [], eof: false };
          chunks.push(cur);
          continue;
        }
        if (l === '*** End of File') {
          if (cur === null) throw new Exit2(`error: parse ${abs(ri)}`);
          cur.eof = true;
          cur = null;
          continue;
        }
        if (l === '' || l.startsWith(' ') || l.startsWith('-') || l.startsWith('+')) {
          if (cur === null) {
            if (chunks.length === 0) {
              cur = { anchor: null, body: [], eof: false };
              chunks.push(cur);
            } else {
              throw new Exit2(`error: parse ${abs(ri)}`);
            }
          }
          cur.body.push(l);
          continue;
        }
        throw new Exit2(`error: parse ${abs(ri)}`);
      }
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${updateLine}`);
      sections.push({ kind, path, moveTo, lines: [], chunks, updateLine });
    }
  }
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((s) => {
    return (tree) => {
      if (!safe(s.path)) throw new Fail('unsafe', s.path);
      if (s.moveTo !== null && !safe(s.moveTo)) throw new Fail('unsafe', s.moveTo);
      if (s.kind === 'add') {
        if (tree.get(s.path) !== null) throw new Fail('exists', s.path);
        tree.now.set(s.path, s.lines.length === 0 ? '' : s.lines.join('\n') + '\n');
        return;
      }
      if (s.kind === 'delete') {
        if (tree.get(s.path) === null) throw new Fail('missing', s.path);
        tree.now.set(s.path, null);
        return;
      }
      const cur = tree.get(s.path);
      if (cur === null) throw new Fail('missing', s.path);
      if (s.moveTo !== null && tree.get(s.moveTo) !== null) throw new Fail('exists', s.moveTo);
      const f = parseText(cur);
      let cursor = 0;
      for (const chunk of s.chunks) {
        if (chunk.anchor !== null) {
          let found = -1;
          const top = strict ? 0 : 2;
          for (let t = 0; t <= top && found < 0; t++) {
            for (let k = cursor; k < f.lines.length; k++) {
              if (normLine(f.lines[k]!, t) === normLine(chunk.anchor, t)) {
                found = k;
                break;
              }
            }
          }
          if (found < 0) throw new Fail('no-match', s.path);
          cursor = found + 1;
        }
        const o: string[] = [];
        const np: NewPart[] = [];
        for (const bl of chunk.body) {
          if (bl === '' || bl.startsWith(' ')) {
            const t = bl === '' ? '' : bl.slice(1);
            o.push(t);
            np.push({ text: t, ctx: o.length - 1, noEol: false });
          } else if (bl.startsWith('-')) {
            o.push(bl.slice(1));
          } else if (bl.startsWith('+')) {
            np.push({ text: bl.slice(1), ctx: -1, noEol: false });
          }
        }
        if (o.length === 0) {
          const pos = chunk.eof ? f.lines.length : cursor;
          const rep = np.map((p) => p.text);
          f.lines.splice(pos, 0, ...rep);
          cursor = pos + rep.length;
        } else {
          let hit: { tier: number; pos: number } | null = null;
          const top = strict ? 0 : 2;
          for (let t = 0; t <= top && hit === null; t++) {
            for (const p of occurrences(f.lines, o, t, cursor)) {
              if (!chunk.eof || p + o.length === f.lines.length) {
                hit = { tier: t, pos: p };
                break;
              }
            }
          }
          if (hit === null) throw new Fail('no-match', s.path);
          const rep = buildReplacement(f, hit.pos, o[0]!, np, hit.tier);
          f.lines.splice(hit.pos, o.length, ...rep);
          cursor = hit.pos + rep.length;
        }
      }
      const text = renderText(f);
      if (s.moveTo !== null) {
        tree.now.set(s.moveTo, text);
        tree.now.set(s.path, null);
        tree.moves.push({ old: s.path, new: s.moveTo });
      } else {
        tree.now.set(s.path, text);
      }
    };
  });
}

/* The run (SPEC sections 1, 2 and 10). */

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = unifiedEdits(lines, strict);
    else if (kind === 'search-replace') edits = searchReplaceEdits(lines, strict);
    else edits = v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const rows: { key: string; line: string }[] = [];
  const movedNew = new Set<string>();
  const movedOld = new Set<string>();
  for (const m of tree.moves) {
    const wasOld = tree.original(m.old);
    const nowOld = tree.get(m.old);
    const wasNew = tree.original(m.new);
    const nowNew = tree.get(m.new);
    if (wasOld !== null && nowOld === null && wasNew === null && nowNew !== null) {
      rows.push({ key: m.new, line: `R ${m.old} -> ${m.new}` });
      movedNew.add(m.new);
      movedOld.add(m.old);
    }
  }
  for (const p of [...tree.now.keys()]) {
    if (movedNew.has(p) || movedOld.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key, 'utf8'), Buffer.from(b.key, 'utf8')));
  if (!check) {
    for (const p of [...tree.now.keys()]) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows.map((r) => r.line), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
