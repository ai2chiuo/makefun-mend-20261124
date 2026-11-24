import { closeSync, ftruncateSync, lstatSync, mkdirSync, openSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { type Edit } from './patch.ts';
import { applyToText, MatchFault } from './match.ts';

type Problem = 'unsafe' | 'missing' | 'exists' | MatchFault['code'];
type Failure = { code: Problem; path: string };
type State = { before: string | null; after: string | null };
type Move = { from: string; to: string };
type FileKind = 'missing' | 'file' | 'directory' | 'unsafe';

function status(path: string) {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

function safeName(path: string): boolean {
  if (!path || path.startsWith('/') || path.includes('\\') || path.includes('\0')) return false;
  return path.split('/').every(segment => {
    if (!segment || segment === '.' || segment === '..') return false;
    if (process.platform !== 'win32') return true;
    return !/[<>:"|?*\x00-\x1f]|[. ]$/.test(segment)
      && !/^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(segment);
  });
}

class Tree {
  readonly root: string;
  readonly files = new Map<string, State>();

  constructor(root: string) {
    this.root = root;
  }

  file(path: string): string {
    return join(this.root, ...path.split('/'));
  }

  inspect(path: string): FileKind {
    if (!safeName(path)) return 'unsafe';
    const segments = path.split('/');
    let full = this.root;
    for (const [index, segment] of segments.entries()) {
      full = join(full, segment);
      const info = status(full);
      if (!info) return 'missing';
      if (info.isSymbolicLink()) return 'unsafe';
      if (index === segments.length - 1) {
        return info.isDirectory() ? 'directory' : info.isFile() ? 'file' : 'unsafe';
      }
      if (!info.isDirectory()) {
        if (!info.isFile()) return 'unsafe';
        const parent = segments.slice(0, index + 1).join('/');
        return this.files.get(parent)?.after === null ? 'missing' : 'unsafe';
      }
    }
    return 'missing';
  }

  get(path: string, kind: FileKind): State {
    let state = this.files.get(path);
    if (!state) {
      const before = kind === 'file' ? readFileSync(this.file(path), 'utf8') : null;
      state = {before, after:before};
      this.files.set(path, state);
    }
    return state;
  }

  targetConflict(path: string): boolean {
    const parts = path.split('/');
    const ancestors = parts.slice(0, -1).map((_, index) => parts.slice(0, index + 1).join('/'));
    for (const name of ancestors) {
      const state = this.files.get(name);
      if (state?.after != null) return true;
    }
    for (const [name, state] of this.files) {
      if (state.after !== null && name.startsWith(path + '/')) return true;
    }
    return false;
  }

  commit(changed: [string, State][]) {
    if (!changed.length) return;
    // Recheck the snapshot before touching any files. In particular, never
    // follow a symbolic link introduced since the edit plan was built.
    for (const [path, {before}] of changed) {
      const kind = this.inspect(path);
      const current = kind === 'file' ? readFileSync(this.file(path), 'utf8') : null;
      if (kind === 'unsafe' || kind === 'directory' || before !== current) {
        throw new Error('File changed while planning: ' + path);
      }
    }
    const createdDirs: string[] = [];
    const touched: [string, State][] = [];
    const makeParents = (directory: string) => {
      if (directory === this.root) return;
      const info = status(directory);
      if (info?.isDirectory()) return;
      if (info) throw new Error('Parent is not a directory: ' + directory);
      makeParents(dirname(directory));
      mkdirSync(directory);
      createdDirs.push(directory);
    };
    try {
      for (const [path, state] of changed) {
        if (state.after !== null) continue;
        unlinkSync(this.file(path));
        touched.push([path, state]);
      }
      for (const [path, state] of changed) {
        if (state.after === null) continue;
        const file = this.file(path);
        makeParents(dirname(file));
        const contents = Buffer.from(state.after);
        const descriptor = openSync(file, state.before === null ? 'wx' : 'r+');
        touched.push([path, state]);
        try {
          writeFileSync(descriptor, contents);
          ftruncateSync(descriptor, contents.length);
        } finally {
          closeSync(descriptor);
        }
      }
    } catch (error) {
      for (const [path, state] of touched.toReversed()) {
        if (state.before === null && status(this.file(path))?.isFile()) unlinkSync(this.file(path));
      }
      for (const dir of createdDirs.toReversed()) rmdirSync(dir);
      for (const [path, state] of touched) {
        if (state.before !== null) writeFileSync(this.file(path), state.before);
      }
      throw error;
    }
  }
}

function apply(tree: Tree, edit: Edit, strict: boolean, moves: Move[]): Failure | null {
  const {path} = edit;
  const to = edit.kind === 'patch' ? edit.to : undefined;
  const kind = tree.inspect(path);
  if (kind === 'unsafe') return {code:'unsafe', path};
  const target = to === undefined ? undefined : tree.inspect(to);
  if (target === 'unsafe') return {code:'unsafe', path:to!};
  const file = tree.get(path, kind);
  if (edit.kind === 'create') {
    if (file.after !== null || kind === 'directory' || tree.targetConflict(path)) return {code:'exists', path};
    file.after = edit.text;
    return null;
  }
  if (file.after === null) return {code:'missing', path};
  if (edit.kind === 'delete') {
    file.after = null;
    return null;
  }
  const destination = to !== undefined ? tree.get(to, target!) : undefined;
  if (destination && (destination.after !== null || target === 'directory' || tree.targetConflict(to!))) {
    return {code:'exists', path:to!};
  }
  try {
    const after = applyToText(file.after, edit, strict);
    if (destination) {
      destination.after = after;
      file.after = null;
      moves.push({from:path, to:to!});
    } else {
      file.after = after;
    }
  } catch (error) {
    if (error instanceof MatchFault) return {code:error.code, path};
    throw error;
  }
  return null;
}

export function runEdits(root: string, edits: Edit[], strict: boolean, check: boolean) {
  const tree = new Tree(root);
  const moves: Move[] = [];
  const failures: Failure[] = [];
  for (const edit of edits) {
    const failure = apply(tree, edit, strict, moves);
    if (failure) failures.push(failure);
  }
  if (failures.length) {
    return {
      exit: 1,
      lines: [...failures.map(({code, path}) => `error: ${code} ${path}`), `failed: ${failures.length} of ${edits.length} edits`],
    };
  }
  const changed = [...tree.files].filter(([, state]) => state.before !== state.after);
  const report = new Map(changed.map(([path, state]) => [
    path, (state.before === null ? 'A ' : state.after === null ? 'D ' : 'M ') + path,
  ]));
  for (const {from, to} of moves) {
    if (report.get(from)?.startsWith('D ') && report.get(to)?.startsWith('A ')) {
      report.delete(from);
      report.set(to, `R ${from} -> ${to}`);
    }
  }
  if (!check) tree.commit(changed);
  const ordered = [...report].sort(([a], [b]) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  const count = ordered.length;
  return {exit:0, lines:[...ordered.map(([, line]) => line), `ok: ${count} ${count === 1 ? 'file' : 'files'}`]};
}
