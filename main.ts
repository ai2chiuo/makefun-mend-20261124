import { readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { detect, parse, ParseFault, patchLines, type Format } from './patch.ts';
import { runEdits } from './tree.ts';

const formats = new Set(['auto', 'unified', 'search-replace', 'v4a', 'json']);

function parseArguments(args: string[]) {
  const flags = new Set<string>();
  let format: Format | 'auto' = 'auto';
  let patch: string | undefined;
  let options = true;
  for (const arg of args) {
    if (options && arg === '--') {
      options = false;
      continue;
    }
    if (options && arg.startsWith('-') && arg !== '-') {
      const [name, value] = arg.startsWith('--format=') ? ['--format', arg.slice(9)] : [arg, undefined];
      if (flags.has(name)) return null;
      if (name === '--format' && value && formats.has(value)) {
        format = value as Format | 'auto';
      } else if (name !== '--check' && name !== '--strict') {
        return null;
      }
      flags.add(name);
    } else {
      if (patch !== undefined) return null;
      patch = arg;
    }
  }
  return {format, patch, check:flags.has('--check'), strict:flags.has('--strict')};
}

function print(lines: string[], exit: number) {
  process.stdout.write(lines.join('\n') + '\n');
  process.exitCode = exit;
}

function cli(args: string[]) {
  const options = parseArguments(args);
  if (!options) return print(['error: usage'], 2);
  let text: string;
  try {
    const input = options.patch;
    if (input !== undefined && isAbsolute(input)) return print(['error: no-patch'], 2);
    text = readFileSync(input === undefined || input === '-' ? 0 : input, 'utf8');
  } catch {
    return print(['error: no-patch'], 2);
  }
  const lines = patchLines(text);
  const format = options.format === 'auto' ? detect(lines) : options.format;
  if (!format) return print(['error: format'], 2);
  try {
    const edits = parse(format, text, lines);
    const result = runEdits(process.cwd(), edits, options.strict, options.check);
    print(result.lines, result.exit);
  } catch (error) {
    if (error instanceof ParseFault) return print([error.message], 2);
    throw error;
  }
}

try {
  const envUrl = process.env.MAKEFUN_ENV_URL;
  if (envUrl) {
    const { runTrial } = await import('./runner.ts');
    await runTrial(envUrl);
  } else {
    cli(process.argv.slice(2));
  }
} catch (error) {
  process.stderr.write((error instanceof Error ? error.message : String(error)) + '\n');
  process.exitCode = 1;
}
