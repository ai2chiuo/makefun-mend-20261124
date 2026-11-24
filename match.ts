import { patchLines, type Chunk, type Edit, type Part } from './patch.ts';

export class MatchFault extends Error {
  readonly code: 'no-match' | 'ambiguous';

  constructor(code: MatchFault['code']) {
    super(code);
    this.code = code;
  }
}

type TextLines = { lines: string[]; separator: string; trailing: boolean };

function split(text: string): TextLines {
  const firstBreak = text.indexOf('\n');
  const separator = firstBreak > 0 && text[firstBreak - 1] === '\r' ? '\r\n' : '\n';
  const trailing = text.endsWith(separator);
  const lines = text ? text.split(separator) : [];
  if (trailing) lines.pop();
  return { lines, separator, trailing };
}

function join(file: TextLines): string {
  if (!file.lines.length) return '';
  return file.lines.join(file.separator) + (file.trailing ? file.separator : '');
}

const trailingIndent = /[ \t]+$/;
const leadingIndent = /^[ \t]*/;
const trimmedIndent = /^[ \t]+|[ \t]+$/g;
const normalize = [
  (s: string) => s,
  (s: string) => s.replace(trailingIndent, ''),
  (s: string) => s.replace(trimmedIndent, ''),
];

type MatchMode = 'unique' | 'first' | 'nearest';

function locate(lines: string[], old: string[], start: number, end: number, mode: MatchMode, strict: boolean, target = 0) {
  const last = Math.min(end, lines.length - old.length);
  for (let tier = 0; tier < (strict ? 1 : normalize.length); tier++) {
    const transform = normalize[tier];
    const needle = old.map(transform);
    let best = -1;
    for (let i = start; i <= last; i++) {
      if (!needle.every((text, k) => text === transform(lines[i + k]))) continue;
      if (mode === 'first') return { index: i, tier };
      if (mode === 'unique' && best >= 0) throw new MatchFault('ambiguous');
      if (best < 0 || Math.abs(i - target) < Math.abs(best - target)) best = i;
      if (mode === 'nearest' && best === target) break;
    }
    if (best >= 0) return { index: best, tier };
  }
  throw new MatchFault('no-match');
}

function substitute(lines: string[], parts: Part[], index: number, length: number, tier: number, from = '', to = '') {
  const replacement: string[] = [];
  let input = index;
  for (const line of parts) {
    if (line.kind === 'context') replacement.push(lines[input]);
    if (line.kind !== 'new') {
      input++;
    } else {
      const text = line.text;
      replacement.push(tier === 2 && text.trim() && text.startsWith(from) ? to + text.slice(from.length) : text);
    }
  }
  return {
    lines: lines.slice(0, index).concat(replacement, lines.slice(index + length)),
    written: replacement.length,
  };
}

const getOld = (chunk: Chunk) => chunk.parts.filter(line => line.kind !== 'new').map(line => line.text);
const indent = (line: string) => leadingIndent.exec(line)![0];

function applyHunks(file: TextLines, chunks: Chunk[], strict: boolean): string {
  let offset = 0;
  for (const chunk of chunks) {
    const start = chunk.line!;
    const old = getOld(chunk);
    const { index, tier } = old.length
      ? locate(file.lines, old, 0, file.lines.length, 'nearest', strict, start - 1 + offset)
      : { index: Math.max(0, Math.min(start + offset, file.lines.length)), tier: 0 };
    if (index + old.length === file.lines.length) {
      const last = chunk.parts.findLast(line => line.kind !== 'old');
      file.trailing = !last?.noBreak;
    }
    const change = substitute(file.lines, chunk.parts, index, old.length, tier,
      old.length ? indent(old[0]) : '', old.length ? indent(file.lines[index]) : '');
    file.lines = change.lines;
    offset += change.written - old.length;
  }
  return join(file);
}

type PatchEdit = Extract<Edit, {kind: 'patch'}>;

function applyChunks(file: TextLines, edit: PatchEdit, strict: boolean): string {
  let cursor = 0;
  for (const chunk of edit.chunks) {
    if (chunk.anchor) {
      cursor = locate(file.lines, [chunk.anchor], cursor, file.lines.length, 'first', strict).index + 1;
    }
    const old = getOld(chunk);
    let index = chunk.eof ? file.lines.length : cursor;
    let tier = 0;
    if (old.length) {
      const end = file.lines.length - old.length;
      const start = chunk.eof ? Math.max(cursor, end) : cursor;
      const mode = edit.format === 'search-replace' ? 'unique' : 'first';
      ({index, tier} = locate(file.lines, old, start, end, mode, strict));
    }
    const change = substitute(file.lines, chunk.parts, index, old.length, tier,
      old.length ? indent(old[0]) : '', old.length ? indent(file.lines[index]) : '');
    file.lines = change.lines;
    cursor = index + change.written;
  }
  return join(file);
}

export function applyToText(text: string, edit: Exclude<Edit, {kind: 'create' | 'delete'}>, strict: boolean): string {
  const file = split(text);
  if (edit.kind === 'insert') {
    const { line } = edit;
    if (line < 0 || line > file.lines.length) throw new MatchFault('no-match');
    file.lines = file.lines.slice(0, line).concat(patchLines(edit.text), file.lines.slice(line));
    return join(file);
  }
  if (edit.kind === 'replace') {
    const crlf = file.separator === '\r\n';
    const convert = (value: string) => crlf ? value.replaceAll('\r\n', '\n') : value;
    const source = convert(text);
    const old = convert(edit.oldText);
    const i = source.indexOf(old);
    if (i < 0) throw new MatchFault('no-match');
    if (source.indexOf(old, i + 1) >= 0) throw new MatchFault('ambiguous');
    const changed = source.slice(0, i) + convert(edit.text) + source.slice(i + old.length);
    return crlf ? changed.replaceAll('\n', '\r\n') : changed;
  }
  return edit.format === 'unified' ? applyHunks(file, edit.chunks, strict) : applyChunks(file, edit, strict);
}
