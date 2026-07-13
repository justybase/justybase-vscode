import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

export interface DdlFixture {
  label: string;
  sql: string;
  lineCount: number;
  charCount: number;
}

const FIXTURE_DIR = path.resolve(
  __dirname,
  '..',
  '..',
  'test',
  'performance',
  'fixtures',
);

const JD_DDL_CANDIDATE_PATHS = [
  process.env.JD_DDL_FIXTURE_PATH,
  path.resolve(FIXTURE_DIR, 'JD_DDL.sql'),
].filter((value): value is string => Boolean(value));

export function loadDdlFixture(fileName: string): DdlFixture {
  const filePath = path.join(FIXTURE_DIR, fileName);
  const sql = fs.readFileSync(filePath, 'utf-8');
  return toFixture(fileName, sql);
}

export function tryLoadJdDdlFixture(): DdlFixture | undefined {
  for (const candidate of JD_DDL_CANDIDATE_PATHS) {
    if (!fs.existsSync(candidate)) {
      continue;
    }
    const sql = fs.readFileSync(candidate, 'utf-8');
    return toFixture('JD_DDL.sql', sql);
  }
  return undefined;
}

function toFixture(label: string, sql: string): DdlFixture {
  return {
    label,
    sql,
    lineCount: sql.split('\n').length,
    charCount: sql.length,
  };
}

export function createLargeSqlDocument(
  sql: string,
  uri = 'file:///large-ddl.sql',
): vscode.TextDocument {
  const lines = sql.split('\n');
  const lineStarts: number[] = [];
  let offset = 0;
  for (const line of lines) {
    lineStarts.push(offset);
    offset += line.length + 1;
  }

  return {
    uri: { fsPath: uri, toString: () => uri } as vscode.Uri,
    languageId: 'sql',
    version: 1,
    lineCount: lines.length,
    getText: () => sql,
    lineAt: (line: number) => ({
      text: lines[line] ?? '',
      range: new vscode.Range(
        line,
        0,
        line,
        (lines[line] ?? '').length,
      ),
    }),
    positionAt: (charOffset: number) => {
      let low = 0;
      let high = lineStarts.length - 1;
      while (low < high) {
        const mid = Math.ceil((low + high) / 2);
        if (lineStarts[mid] > charOffset) {
          high = mid - 1;
        } else {
          low = mid;
        }
      }
      return new vscode.Position(low, charOffset - lineStarts[low]);
    },
    offsetAt: (position: vscode.Position) =>
      lineStarts[position.line] + position.character,
  } as unknown as vscode.TextDocument;
}

export function benchmarkSync(
  fn: () => void,
  iterations = 3,
  warmup = 0,
): { avgMs: number; maxMs: number } {
  for (let i = 0; i < warmup; i++) {
    fn();
  }
  const samples: number[] = [];
  for (let i = 0; i < iterations; i++) {
    const t0 = performance.now();
    fn();
    samples.push(performance.now() - t0);
  }
  const maxMs = Math.max(...samples);
  const avgMs = samples.reduce((sum, value) => sum + value, 0) / samples.length;
  return { avgMs, maxMs };
}
