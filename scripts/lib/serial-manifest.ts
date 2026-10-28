/**
 * scripts/serial-files.tsv is the single list of *.serial.test.ts files
 * (outside test/e2e) and why each one cannot share a bun process.
 * test/scripts/serial-files.test.ts runs checkSerialManifest against the
 * repository; the function is pure so fixtures can exercise every failure.
 */

export const SERIAL_CLASSES = ['R1', 'R2', 'global-state', 'exclusive'] as const;
export type SerialClass = typeof SERIAL_CLASSES[number];
export interface SerialRow { path: string; class: SerialClass; reason: string }

const BOILERPLATE = /^(?:(?:R1|R2|global-state|exclusive)\s*:\s*)?(?:flaky|flake|serial|needs? serial|quarantined?|todo|tbd|unknown|n\/a|none|legacy|see file|timing)\.?$/i;
const MIN_REASON_CHARS = 20;
const ENV_MUTATION = /process\.env\.[A-Za-z_]\w*\s*=[^=]|process\.env\[[^\]]+\]\s*=[^=]|delete\s+process\.env[.[]|Object\.assign\s*\(\s*process\.env|Reflect\.set\s*\(\s*process\.env/;
const MODULE_MOCK = /mock\.module\s*\(/;

const ADD_ROW_FIX = (path: string) =>
  `Fix: bash scripts/check-test-isolation.sh --as-parallel ${path}; if it passes and the file touches no process-wide state, `
  + `rename it to *.test.ts; otherwise add the row "${path}<TAB><R1|R2|global-state|exclusive><TAB><why>" to scripts/serial-files.tsv.`;
const DOCS = 'Docs: docs/TESTING.md#when-to-quarantine-instead-of-fix';

export function parseSerialManifest(text: string): { rows: SerialRow[]; errors: string[] } {
  const rows: SerialRow[] = [];
  const errors: string[] = [];
  let header = false;
  text.split('\n').forEach((line, index) => {
    if (!line.trim() || line.startsWith('#')) return;
    const cells = line.split('\t');
    if (!header) {
      header = true;
      if (cells.join('\t') !== 'path\tclass\treason') errors.push(`scripts/serial-files.tsv:${index + 1}: header must be "path<TAB>class<TAB>reason".`);
      return;
    }
    if (cells.length !== 3) {
      errors.push(`scripts/serial-files.tsv:${index + 1}: expected 3 tab-separated cells, found ${cells.length}.`);
      return;
    }
    rows.push({ path: cells[0], class: cells[1] as SerialClass, reason: cells[2].trim() });
  });
  return { rows, errors };
}

/**
 * Returns one agent-actionable message per problem (empty when the manifest
 * matches the tree). `read(path)` returns a listed file's source.
 */
export function checkSerialManifest(input: {
  manifest: string;
  serialFiles: string[];
  exclusiveFiles: string[];
  read: (path: string) => string;
}): string[] {
  const { rows, errors } = parseSerialManifest(input.manifest);
  const listed = new Map<string, SerialRow>();
  for (const row of rows) {
    if (listed.has(row.path)) errors.push(`${row.path} is listed twice in scripts/serial-files.tsv.\nFix: delete the duplicate row.`);
    listed.set(row.path, row);
  }
  const onDisk = new Set(input.serialFiles);
  for (const path of input.serialFiles) {
    if (!listed.has(path)) {
      errors.push(`${path} is a serial test file with no row in scripts/serial-files.tsv.\n`
        + 'Why: every file in the serial lane needs a recorded reason, so the lane only grows deliberately.\n'
        + `${ADD_ROW_FIX(path)}\n${DOCS}`);
    }
  }
  for (const row of rows) {
    if (!onDisk.has(row.path)) {
      errors.push(`scripts/serial-files.tsv lists ${row.path}, which is not a *.serial.test.ts file outside test/e2e.\n`
        + 'Why: a stale row hides the real serial set.\n'
        + `Fix: delete the row for ${row.path} from scripts/serial-files.tsv (it was renamed or removed).\n${DOCS}`);
      continue;
    }
    if (!(SERIAL_CLASSES as readonly string[]).includes(row.class)) {
      errors.push(`${row.path}: class "${row.class}" is not one of ${SERIAL_CLASSES.join(', ')}.\nFix: set the class column in scripts/serial-files.tsv.\n${DOCS}`);
      continue;
    }
    if (row.reason.length < MIN_REASON_CHARS || BOILERPLATE.test(row.reason)) {
      errors.push(`${row.path}: reason "${row.reason}" does not say what process-wide state the file touches.\n`
        + 'Why: a boilerplate reason cannot be reviewed or retired.\n'
        + `Fix: name the env variables, mocked modules, seams or machine resources in the reason column of scripts/serial-files.tsv (at least ${MIN_REASON_CHARS} characters).\n${DOCS}`);
    }
    const source = input.read(row.path);
    if (row.class === 'R1' && !ENV_MUTATION.test(source)) {
      errors.push(`${row.path}: class R1 but the file no longer mutates process.env.\n${ADD_ROW_FIX(row.path).replace('add the row', 'update the row to')}\n${DOCS}`);
    }
    if (row.class === 'R2' && !MODULE_MOCK.test(source)) {
      errors.push(`${row.path}: class R2 but the file no longer calls mock.module.\n${ADD_ROW_FIX(row.path).replace('add the row', 'update the row to')}\n${DOCS}`);
    }
    if ((row.class === 'exclusive') !== input.exclusiveFiles.includes(row.path)) {
      errors.push(`${row.path}: class exclusive must match EXCLUSIVE_FILES in scripts/run-serial-tests.sh.\n`
        + 'Fix: list the file in both places or in neither.\n' + DOCS);
    }
  }
  return errors;
}
