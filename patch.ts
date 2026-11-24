export type Part = { kind: 'context' | 'old' | 'new'; text: string; noBreak?: boolean };
export type Chunk = { parts: Part[]; line?: number; anchor?: string; eof?: boolean };
export type Format = 'unified' | 'search-replace' | 'v4a' | 'json';
export type Edit =
  | { kind: 'create'; path: string; text: string }
  | { kind: 'delete'; path: string }
  | { kind: 'replace'; path: string; oldText: string; text: string }
  | { kind: 'insert'; path: string; line: number; text: string }
  | { kind: 'patch'; path: string; to?: string; format: Exclude<Format, 'json'>; chunks: Chunk[] };

export class ParseFault extends Error {
  constructor(line: number) {
    super('error: parse ' + line);
  }
}

export function patchLines(text: string): string[] {
  if (!text) return [];
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines.map(line => line.endsWith('\r') ? line.slice(0, -1) : line);
}

export function detect(lines: string[]): Format | null {
  const first = lines.find(line => line.trim())?.trimStart();
  if (first?.trimEnd() === '*** Begin Patch') return 'v4a';
  if (first?.startsWith('[') || first?.startsWith('{')) return 'json';
  if (lines.some(line => line.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  return lines.some((line, i) => line.startsWith('diff --git ') || headerPair(lines, i)) ? 'unified' : null;
}

function headerPair(lines: string[], i: number): boolean {
  return lines[i].startsWith('--- ') && (lines[i + 1]?.startsWith('+++ ') ?? false);
}

function part(line: string): Part | null {
  if (line === '') return { kind: 'context', text: '' };
  const kind = line[0] === ' ' ? 'context' : line[0] === '-' ? 'old' : line[0] === '+' ? 'new' : null;
  return kind ? { kind, text: line.slice(1) } : null;
}

type Section = {
  oldPath?: string | null;
  newPath?: string | null;
  renameFrom?: string;
  renameTo?: string;
  gitPaths?: [string, string];
  creates?: boolean;
  deletes?: boolean;
  chunks: Chunk[];
};

function diffPath(line: string): string | null {
  const path = line.slice(4).split('\t', 1)[0].trim();
  return path === '/dev/null' ? null : path.replace(/^[ab]\//, '');
}

function sectionEdit(section: Section): Edit {
  const { chunks, gitPaths } = section;
  const oldPath = section.oldPath !== undefined ? section.oldPath : section.renameFrom ?? gitPaths?.[0] ?? '';
  const newPath = section.newPath !== undefined ? section.newPath : section.renameTo ?? gitPaths?.[1] ?? '';
  if (oldPath === null || section.creates) {
    const added = chunks.flatMap(chunk => chunk.parts.filter(line => line.kind === 'new'));
    const content = added.map(line => line.text).join('\n');
    return { kind: 'create', path: newPath ?? '', text: added.length && !added.at(-1)?.noBreak ? content + '\n' : content };
  }
  if (newPath === null || section.deletes) return { kind: 'delete', path: oldPath };
  return { kind: 'patch', path: oldPath, to: oldPath === newPath ? undefined : newPath, format: 'unified', chunks };
}

const gitHeader = (line: string) => line === 'diff --git' || line.startsWith('diff --git ');

function unified(lines: string[]): Edit[] {
  let current: Section | undefined;
  const edits: Edit[] = [];
  for (let i = 0; i < lines.length;) {
    const line = lines[i];
    if (gitHeader(line)) {
      const match = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
      if (!match) throw new ParseFault(i + 1);
      if (current) edits.push(sectionEdit(current));
      current = { gitPaths: [match[1], match[2]], chunks: [] };
      i++;
    } else if (headerPair(lines, i)) {
      if (current && (current.oldPath !== undefined || current.chunks.length)) {
        edits.push(sectionEdit(current));
        current = undefined;
      }
      current ??= { chunks: [] };
      current.oldPath = diffPath(line);
      current.newPath = diffPath(lines[i + 1]);
      i += 2;
    } else if (line.startsWith('@@')) {
      const match = /^@@ -(\d+)(?:,\d+)? \+\d+(?:,\d+)? @@/.exec(line);
      if (!match || !current) throw new ParseFault(i + 1);
      const start = Number(match[1]);
      i++;
      const parts: Part[] = [];
      let trailing = 0;
      while (i < lines.length && !gitHeader(lines[i]) && !headerPair(lines, i)) {
        const body = lines[i];
        const parsed = part(body);
        if (parsed) {
          parts.push(parsed);
          trailing = body === '' ? trailing + 1 : 0;
        } else if (body.startsWith('\\')) {
          if (parts.length) parts.at(-1)!.noBreak = true;
          trailing = 0;
        } else {
          break;
        }
        i++;
      }
      parts.length -= trailing;
      current.chunks.push({ line: start, parts });
    } else {
      if (current && current.chunks.length === 0) {
        if (line.startsWith('--- ')) throw new ParseFault(i + 2);
        if (line.startsWith('rename from ')) current.renameFrom = line.slice(12).trim();
        if (line.startsWith('rename to ')) current.renameTo = line.slice(10).trim();
        if (/^new file mode(?: |$)/.test(line)) current.creates = true;
        if (/^deleted file mode(?: |$)/.test(line)) current.deletes = true;
      }
      i++;
    }
  }
  if (current) edits.push(sectionEdit(current));
  return edits;
}

function searchReplace(lines: string[]): Edit[] {
  const edits: Edit[] = [];
  let previousEnd = -1;
  let previousPath: string | undefined;
  const markers = lines.map(line => line.trimEnd());
  for (let i = 0; i < lines.length; i++) {
    if (markers[i] !== '<<<<<<< SEARCH') continue;
    let path = previousPath;
    for (let j = i - 1; j > previousEnd; j--) {
      const name = lines[j].trim();
      if (name && !name.startsWith('```')) {
        path = name;
        break;
      }
    }
    const split = markers.indexOf('=======', i + 1);
    const end = split < 0 ? -1 : markers.indexOf('>>>>>>> REPLACE', split + 1);
    if (path === undefined || end < 0) throw new ParseFault(i + 1);
    const oldLines = lines.slice(i + 1, split);
    const newLines = lines.slice(split + 1, end);
    if (oldLines.length) {
      const parts: Part[] = [
        ...oldLines.map((text): Part => ({ kind: 'old', text })),
        ...newLines.map((text): Part => ({ kind: 'new', text })),
      ];
      edits.push({ kind: 'patch', path, format: 'search-replace', chunks: [{ parts }] });
    } else {
      edits.push({ kind: 'create', path, text: createText(newLines) });
    }
    previousPath = path;
    previousEnd = i = end;
  }
  return edits;
}

const v4aHeader = /^\*\*\* (Add|Delete|Update) File: (.*)$/;
const createText = (lines: string[]) => lines.length ? lines.join('\n') + '\n' : '';

function v4a(lines: string[]): Edit[] {
  const first = lines.findIndex(line => line.trim());
  if (first < 0 || lines[first].trim() !== '*** Begin Patch') throw new ParseFault(Math.max(first + 1, 1));
  let end = lines.length - 1;
  while (!lines[end]?.trim()) end--;
  if (lines[end].trim() !== '*** End Patch') throw new ParseFault(lines.length + 1);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < end) {
    if (!lines[i].trim()) {
      i++;
      continue;
    }
    const header = i;
    const match = v4aHeader.exec(lines[i++]);
    if (!match) throw new ParseFault(header + 1);
    const path = match[2].trim();
    let next = i;
    while (next < end && !v4aHeader.test(lines[next])) next++;
    let sectionEnd = next;
    while (sectionEnd > i && !lines[sectionEnd - 1].trim()) sectionEnd--;
    if (match[1] === 'Add') {
      const content: string[] = [];
      for (; i < sectionEnd; i++) {
        if (lines[i] && !lines[i].startsWith('+')) throw new ParseFault(i + 1);
        content.push(lines[i].slice(1));
      }
      edits.push({ kind: 'create', path, text: createText(content) });
    } else if (match[1] === 'Delete') {
      if (i < sectionEnd) throw new ParseFault(i + 1);
      edits.push({ kind: 'delete', path });
    } else {
      let to: string | undefined;
      if (i < sectionEnd && lines[i].startsWith('*** Move to: ')) to = lines[i++].slice(13).trim();
      const chunks: Chunk[] = [];
      while (i < sectionEnd) {
        let anchor: string | undefined;
        if (lines[i].startsWith('@@')) {
          anchor = lines[i++].slice(2).trim();
        } else if (chunks.length || !part(lines[i])) {
          throw new ParseFault(i + 1);
        }
        const parts: Part[] = [];
        for (; i < sectionEnd; i++) {
          const parsed = part(lines[i]);
          if (!parsed) break;
          parts.push(parsed);
        }
        const eof = i < sectionEnd && lines[i] === '*** End of File';
        if (eof) i++;
        chunks.push({ parts, anchor, eof });
      }
      if (!chunks.length && to === undefined) throw new ParseFault(header + 1);
      edits.push({ kind: 'patch', path, to, format: 'v4a', chunks });
    }
    i = next;
  }
  return edits;
}

function jsonEdit(value: unknown, line: number): Edit {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ParseFault(line);
  const v = value as Record<string, unknown>;
  const path = v.path;
  if (typeof path !== 'string') throw new ParseFault(line);
  if (v.command === 'create' && typeof v.file_text === 'string') {
    return { kind: 'create', path, text: v.file_text };
  }
  if (v.command === 'str_replace' && typeof v.old_str === 'string' && v.old_str &&
      (!Object.hasOwn(v, 'new_str') || typeof v.new_str === 'string')) {
    return { kind: 'replace', path, oldText: v.old_str, text: (v.new_str ?? '') as string };
  }
  if (v.command === 'insert' && Number.isInteger(v.insert_line) && typeof v.new_str === 'string') {
    return { kind: 'insert', path, line: v.insert_line as number, text: v.new_str };
  }
  throw new ParseFault(line);
}

function readJson(text: string, line: number): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ParseFault(line);
  }
}

function json(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex(line => line.trim());
  if (first >= 0 && lines[first].trimStart().startsWith('[')) {
    const values = readJson(text, first + 1);
    if (!Array.isArray(values)) throw new ParseFault(first + 1);
    return values.map(value => jsonEdit(value, first + 1));
  }
  return lines.flatMap((line, i) => line.trim() ? [jsonEdit(readJson(line, i + 1), i + 1)] : []);
}

export function parse(format: Format, text: string, lines = patchLines(text)): Edit[] {
  const edits = format === 'unified' ? unified(lines)
    : format === 'search-replace' ? searchReplace(lines)
      : format === 'v4a' ? v4a(lines) : json(text, lines);
  if (!edits.length) throw new ParseFault(1);
  return edits;
}
