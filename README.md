# Mend

[![Make.fun bounty](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)

Mend applies unified diffs, SEARCH/REPLACE blocks, V4A patches and JSON editor commands. It evaluates all edits in order before writing files. A failed edit leaves the working tree untouched, and Mend reports each failure.

## Usage

Run with Node.js 22. From the file tree you want to edit, pass a relative patch filename or pipe the patch into standard input.

```sh
node /path/to/mend/main.ts --check changes.patch
node /path/to/mend/main.ts changes.patch
```

Use `--strict` for exact line matching. Use `--format=unified`, `--format=search-replace`, `--format=v4a`, or `--format=json` to select a parser explicitly.
