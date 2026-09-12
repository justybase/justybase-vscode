import type {
  DatabaseDdlColumnInfo,
  DatabaseExternalTableInfo,
  DatabaseProcedureInfo,
  DatabaseSynonymInfo,
} from '@justybase/contracts';
import { quoteNetezzaIdentifier } from './netezzaTableDdl';

function quoteSqlString(value: string): string {
  return `'${value.replace(/'/gu, "''")}'`;
}

/**
 * Builds the procedure definition shape used by the VS Code Netezza DDL
 * provider.  The catalog payload is intentionally passed through unchanged;
 * return-type normalization belongs to the catalog adapter because it is
 * only needed for the driver-facing ANY-length representation.
 */
export function buildNetezzaProcedureDdl(
  database: string,
  schema: string,
  procedure: DatabaseProcedureInfo,
): string {
  const argumentsText = procedure.arguments?.trim() ?? '';
  const argumentsClause = !argumentsText
    ? '()'
    : argumentsText.startsWith('(') && argumentsText.endsWith(')')
      ? argumentsText
      : `(${argumentsText})`;
  const qualifiedName = [database, schema, procedure.procedureName]
    .map(quoteNetezzaIdentifier)
    .join('.');

  const lines = [
    `CREATE OR REPLACE PROCEDURE ${qualifiedName}${argumentsClause}`,
    `RETURNS ${procedure.returns}`,
    procedure.executeAsOwner ? 'EXECUTE AS OWNER' : 'EXECUTE AS CALLER',
    'LANGUAGE NZPLSQL AS',
    'BEGIN_PROC',
    procedure.procedureSource,
    'END_PROC;',
  ];

  if (procedure.description) {
    lines.push(
      `COMMENT ON PROCEDURE ${quoteNetezzaIdentifier(procedure.procedureName)} IS ${quoteSqlString(procedure.description)};`,
    );
  }

  return lines.join('\n');
}

function externalStringOption(lines: string[], keyword: string, value: string | null): void {
  if (value !== null) lines.push(`    ${keyword} ${quoteSqlString(value)}`);
}

function externalNumericOption(lines: string[], keyword: string, value: number | string | null): void {
  if (value !== null) lines.push(`    ${keyword} ${value}`);
}

function externalBooleanOption(lines: string[], keyword: string, value: boolean | null): void {
  if (value !== null) lines.push(`    ${keyword} ${value}`);
}

/** Builds a complete external-table definition from Netezza catalog fields. */
export function buildNetezzaExternalTableDdl(
  database: string,
  schema: string,
  tableName: string,
  external: DatabaseExternalTableInfo,
  columns: readonly DatabaseDdlColumnInfo[],
): string {
  const qualifiedName = [database, schema, tableName].map(quoteNetezzaIdentifier).join('.');
  const lines = [
    `CREATE EXTERNAL TABLE ${qualifiedName}`,
    '(',
    columns.map(column => {
      let definition = `    ${quoteNetezzaIdentifier(column.name)} ${column.fullTypeName}`;
      if (column.notNull) definition += ' NOT NULL';
      return definition;
    }).join(',\n'),
    ')',
    'USING',
    '(',
  ];

  if (external.dataObject !== null) {
    lines.push(`    DATAOBJECT(${quoteSqlString(external.dataObject)})`);
  }
  externalStringOption(lines, 'DELIMITER', external.delimiter);
  externalStringOption(lines, 'ENCODING', external.encoding);
  externalStringOption(lines, 'TIMESTYLE', external.timeStyle);
  externalStringOption(lines, 'REMOTESOURCE', external.remoteSource);
  externalNumericOption(lines, 'SKIPROWS', external.skipRows);
  externalNumericOption(lines, 'MAXERRORS', external.maxErrors);
  externalStringOption(lines, 'ESCAPECHAR', external.escapeChar);
  externalStringOption(lines, 'DECIMALDELIM', external.decimalDelim);
  externalStringOption(lines, 'LOGDIR', external.logDir);
  externalStringOption(lines, 'QUOTEDVALUE', external.quotedValue);
  externalStringOption(lines, 'NULLVALUE', external.nullValue);
  externalBooleanOption(lines, 'CRINSTRING', external.crInString);
  externalBooleanOption(lines, 'TRUNCSTRING', external.truncString);
  externalBooleanOption(lines, 'CTRLCHARS', external.ctrlChars);
  externalBooleanOption(lines, 'IGNOREZERO', external.ignoreZero);
  externalBooleanOption(lines, 'TIMEEXTRAZEROS', external.timeExtraZeros);
  externalNumericOption(lines, 'Y2BASE', external.y2Base);
  externalBooleanOption(lines, 'FILLRECORD', external.fillRecord);
  externalBooleanOption(lines, 'COMPRESS', external.compress);
  externalBooleanOption(lines, 'INCLUDEHEADER', external.includeHeader);
  externalBooleanOption(lines, 'LFINSTRING', external.lfInString);
  externalStringOption(lines, 'DATESTYLE', external.dateStyle);
  externalStringOption(lines, 'DATEDELIM', external.dateDelim);
  externalStringOption(lines, 'TIMEDELIM', external.timeDelim);
  externalStringOption(lines, 'BOOLSTYLE', external.boolStyle);
  externalStringOption(lines, 'FORMAT', external.format);
  externalNumericOption(lines, 'SOCKETBUFSIZE', external.socketBufSize);
  externalStringOption(lines, 'RECORDDELIM', external.recordDelim);
  externalNumericOption(lines, 'MAXROWS', external.maxRows);
  externalBooleanOption(lines, 'REQUIREQUOTES', external.requireQuotes);
  externalNumericOption(lines, 'RECORDLENGTH', external.recordLength);
  externalStringOption(lines, 'DATETIMEDELIM', external.dateTimeDelim);
  externalStringOption(lines, 'REJECTFILE', external.rejectFile);

  lines.push(');');
  return lines.join('\n');
}

function quoteMultiPartReference(reference: string): string {
  return reference.split('.').map(quoteNetezzaIdentifier).join('.');
}

/** Builds a synonym definition while preserving a catalog-qualified target. */
export function buildNetezzaSynonymDdl(
  database: string,
  schema: string,
  synonymName: string,
  synonym: DatabaseSynonymInfo,
): string {
  const ownerSchema = quoteNetezzaIdentifier(synonym.owner || schema);
  const synonymIdentifier = quoteNetezzaIdentifier(synonymName);
  const lines = [
    `CREATE SYNONYM ${quoteNetezzaIdentifier(database)}.${ownerSchema}.${synonymIdentifier} FOR ${quoteMultiPartReference(synonym.referenceObjectName)};`,
  ];

  if (synonym.description) {
    lines.push(`COMMENT ON SYNONYM ${synonymIdentifier} IS ${quoteSqlString(synonym.description)};`);
  }

  return lines.join('\n');
}

/** Netezza's catalog representation for ANY-length character return types. */
export function fixNetezzaProcedureReturnType(returns: string): string {
  switch (returns.trim().toUpperCase()) {
    case 'CHARACTER VARYING': return 'CHARACTER VARYING(ANY)';
    case 'NATIONAL CHARACTER VARYING': return 'NATIONAL CHARACTER VARYING(ANY)';
    case 'NATIONAL CHARACTER': return 'NATIONAL CHARACTER(ANY)';
    case 'CHARACTER': return 'CHARACTER(ANY)';
    default: return returns;
  }
}
