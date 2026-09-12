import type { DatabaseKind, MetadataColumn } from '@justybase/contracts';
import {
  formatIdentifierForSql,
  formatQualifiedObjectName,
} from '@justybase/dialect-utils';

export interface MetadataTableDdlInput {
  database?: string;
  schema?: string;
  tableName: string;
  databaseKind: DatabaseKind;
  columns: readonly MetadataColumn[];
}

export interface MetadataViewDdlInput {
  database?: string;
  schema?: string;
  viewName: string;
  databaseKind: DatabaseKind;
  /** Either a catalog CREATE VIEW statement or the SELECT/query body. */
  sourceSql: string;
}

export interface ReconstructedDdlResult {
  ddl: string;
  warnings: string[];
}

const GENERIC_METADATA_WARNING =
  'Reconstructed from generic metadata; defaults, nullability, foreign keys, indexes, comments, and storage options are not included.';

function requireIdentifier(value: string | undefined, label: string): string {
  const trimmed = value?.trim() ?? '';
  if (!trimmed) throw new Error(`${label} is required to generate DDL.`);
  return trimmed;
}

function hasCreateViewEnvelope(sourceSql: string): boolean {
  return /^CREATE\s+(?:(?:OR\s+REPLACE|OR\s+ALTER)\s+)?(?:TEMP(?:ORARY)?\s+)?VIEW\b/iu.test(sourceSql.trim());
}

/**
 * Builds a deliberately conservative CREATE TABLE statement from the common
 * metadata contract. It is used only when a dialect runtime cannot provide a
 * native catalog DDL statement; it never invents a missing column type.
 */
export function buildReconstructedTableDdl(input: MetadataTableDdlInput): ReconstructedDdlResult {
  const tableName = requireIdentifier(input.tableName, 'Table name');
  if (input.columns.length === 0) throw new Error(`No columns were returned for ${tableName}.`);

  const allowTypelessColumns = input.databaseKind === 'sqlite';
  const primaryKeyColumns: string[] = [];
  const definitions = input.columns.map((column, index) => {
    const columnName = requireIdentifier(column.name, `Column ${index + 1} name`);
    const type = column.type?.trim() ?? '';
    if (!type && !allowTypelessColumns) {
      throw new Error(`Column ${columnName} has no declared type.`);
    }
    if (column.isPk) primaryKeyColumns.push(formatIdentifierForSql(columnName, input.databaseKind));
    return [
      `    ${formatIdentifierForSql(columnName, input.databaseKind)}`,
      type,
    ].filter(Boolean).join(' ');
  });

  if (primaryKeyColumns.length > 0) {
    definitions.push(`    PRIMARY KEY (${primaryKeyColumns.join(', ')})`);
  }

  const qualifiedName = formatQualifiedObjectName(
    input.database,
    input.schema,
    tableName,
    input.databaseKind,
  );
  const warnings = [GENERIC_METADATA_WARNING];
  if (input.columns.some(column => !column.type?.trim())) {
    warnings.push('One or more columns have no declared type; typeless columns are preserved only because SQLite permits them.');
  }

  return {
    ddl: `CREATE TABLE ${qualifiedName}\n(\n${definitions.join(',\n')}\n);`,
    warnings,
  };
}

/**
 * Keeps a catalog CREATE VIEW statement intact. When a runtime exposes only
 * the query body, this adds the dialect-aware object name and marks the result
 * as reconstructed for the caller.
 */
export function buildReconstructedViewDdl(input: MetadataViewDdlInput): ReconstructedDdlResult {
  const viewName = requireIdentifier(input.viewName, 'View name');
  const sourceSql = input.sourceSql.trim();
  if (!sourceSql) throw new Error(`No source SQL was returned for ${viewName}.`);
  if (hasCreateViewEnvelope(sourceSql)) {
    return { ddl: sourceSql, warnings: [GENERIC_METADATA_WARNING] };
  }

  const qualifiedName = formatQualifiedObjectName(
    input.database,
    input.schema,
    viewName,
    input.databaseKind,
  );
  const queryBody = sourceSql.replace(/;\s*$/u, '').trim();
  if (!queryBody) throw new Error(`No query body was returned for ${viewName}.`);
  return {
    ddl: `CREATE VIEW ${qualifiedName} AS\n${queryBody};`,
    warnings: [
      GENERIC_METADATA_WARNING,
      'The view was reconstructed from query text; catalog-level options may be omitted.',
    ],
  };
}
