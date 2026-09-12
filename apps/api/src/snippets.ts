import * as fs from 'fs';
import * as path from 'path';
import { tryNormalizeDatabaseKind, type DatabaseKind } from '@justybase/contracts';

export interface WebSnippet {
  prefix: string[];
  body: string[];
  description?: string;
}

interface SnippetFileEntry {
  prefix?: string | string[];
  body?: string | string[];
  description?: string;
}

interface SnippetFile {
  [name: string]: SnippetFileEntry;
}

const SNIPPET_ROOTS = [
  path.resolve(__dirname, '../../dialects'),
  path.resolve(__dirname, '../../../dialects'),
];

const DIALECT_DIRECTORY_BY_KIND: Readonly<Record<string, string>> = {
  netezza: 'netezza',
  postgresql: 'postgresql',
  db2: 'db2',
  clickhouse: 'clickhouse',
  oracle: 'oracle',
  mssql: 'mssql',
  duckdb: 'duckdb',
  sqlite: 'sqlite',
  file: 'duckdb',
};

const COMMON_SNIPPETS: WebSnippet[] = [
  { prefix: ['sqlselect'], body: ['SELECT ${1:column1}, ${2:column2}', 'FROM ${3:schema}.${4:table}', 'WHERE ${5:condition};'], description: 'Portable SELECT statement' },
  { prefix: ['sqlcte'], body: ['WITH ${1:name} AS (', '  SELECT ${2:*}', '  FROM ${3:schema}.${4:table}', ')', 'SELECT ${5:*}', 'FROM ${1:name};'], description: 'Portable common table expression' },
  { prefix: ['sqltable'], body: ['CREATE TABLE ${1:schema}.${2:table_name} (', '  ${3:id} INTEGER NOT NULL,', '  ${4:created_at} TIMESTAMP,', '  PRIMARY KEY (${3:id})', ');'], description: 'Portable CREATE TABLE definition' },
  { prefix: ['sqlview'], body: ['CREATE OR REPLACE VIEW ${1:schema}.${2:view_name} AS', 'SELECT ${3:*}', 'FROM ${4:schema}.${5:table};'], description: 'Portable CREATE VIEW definition' },
  { prefix: ['sqljoin'], body: ['SELECT ${1:a}.*', 'FROM ${2:schema}.${3:left_table} AS ${4:a}', 'JOIN ${5:schema}.${6:right_table} AS ${7:b}', '  ON ${4:a}.${8:id} = ${7:b}.${8:id};'], description: 'Portable joined query' },
];

function resolveSnippetFile(databaseKind: DatabaseKind = 'netezza'): string | null {
  const normalized = tryNormalizeDatabaseKind(databaseKind) ?? 'netezza';
  const directory = DIALECT_DIRECTORY_BY_KIND[normalized];
  if (!directory) return null;
  const fileName = `${directory}.code-snippets`;
  for (const root of SNIPPET_ROOTS) {
    const candidate = path.join(root, directory, 'snippets', fileName);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function readSnippetFile(file: string | null): WebSnippet[] {
  if (!file) return [];
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const contents = JSON.parse(raw) as SnippetFile;
    return Object.values(contents).map(entry => ({
      prefix: Array.isArray(entry.prefix) ? entry.prefix : entry.prefix ? [entry.prefix] : [],
      body: Array.isArray(entry.body) ? entry.body : entry.body ? [entry.body] : [],
      description: entry.description,
    })).filter(snippet => snippet.prefix.length > 0 && snippet.body.length > 0);
  } catch {
    return [];
  }
}

/** Returns the snippets for the active authoring dialect. */
export function loadSqlSnippets(databaseKind: DatabaseKind = 'netezza'): WebSnippet[] {
  const normalized = tryNormalizeDatabaseKind(databaseKind) ?? 'netezza';
  const dialect = readSnippetFile(resolveSnippetFile(normalized));
  return normalized === 'netezza' ? dialect : [...COMMON_SNIPPETS, ...dialect];
}

/** Compatibility name retained for existing Netezza integrations. */
export function loadNetezzaSnippets(): WebSnippet[] {
  return loadSqlSnippets('netezza');
}
