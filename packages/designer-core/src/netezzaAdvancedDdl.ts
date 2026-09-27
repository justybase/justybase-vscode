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

export interface NetezzaExternalLayoutZone {
  usetype?: unknown;
  name?: unknown;
  type?: unknown;
  style?: unknown;
  length?: unknown;
  delimiter?: unknown;
  around?: unknown;
  nullif?: unknown;
  endian?: unknown;
  alignment?: unknown;
  modulus?: unknown;
}

function externalLayoutText(value: unknown): string {
  return value === null || value === undefined ? '' : String(value).trim();
}

function externalLayoutRawText(value: unknown): string {
  return value === null || value === undefined ? '' : String(value);
}

export function isNetezzaExternalLayoutZoneCount(value: unknown): boolean {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value > 0;
  return typeof value === 'string' && /^\d+$/u.test(value.trim()) && Number(value.trim()) > 0;
}

/** `_V_EXTERNAL.LAYOUT` is a zone count; `_V_EXTZONES` holds the zone clauses. */
export function reconstructNetezzaExternalLayout(
  catalogLayout: unknown,
  zones: readonly NetezzaExternalLayoutZone[],
): string | null {
  if (catalogLayout === null || catalogLayout === undefined) return null;
  const raw = externalLayoutText(catalogLayout);
  if (!raw || raw === '0') return null;
  if (!/^\d+$/u.test(raw)) return raw;

  const expectedCount = Number(raw);
  if (!Number.isSafeInteger(expectedCount) || expectedCount <= 0) return null;
  if (zones.length !== expectedCount) {
    throw new Error(
      `Cannot reconstruct external table LAYOUT: catalog reports ${expectedCount} zones, but _V_EXTZONES returned ${zones.length}`,
    );
  }

  return zones.map((zone, index) => {
    const useType = externalLayoutText(zone.usetype).toUpperCase();
    if (useType && useType !== 'REF' && useType !== 'FILLER') {
      throw new Error(`Cannot reconstruct external table LAYOUT: unsupported zone use type ${useType}`);
    }
    const name = externalLayoutRawText(zone.name);
    const type = externalLayoutText(zone.type);
    const style = externalLayoutText(zone.style);
    const length = externalLayoutText(zone.length);
    const delimiter = externalLayoutRawText(zone.delimiter);
    const nullIf = externalLayoutText(zone.nullif);
    if (!length) {
      throw new Error(`Cannot reconstruct external table LAYOUT: zone ${index + 1} has no length`);
    }
    for (const [field, value] of [
      ['AROUND', zone.around],
      ['ENDIAN', zone.endian],
      ['ALIGNMENT', zone.alignment],
      ['MODULUS', zone.modulus],
    ] as const) {
      if (externalLayoutText(value)) {
        throw new Error(`Cannot reconstruct external table LAYOUT: zone ${index + 1} uses unsupported ${field} metadata`);
      }
    }

    const parts = [useType, name ? quoteNetezzaIdentifier(name) : '', type, style];
    if (delimiter) {
      if (!style) {
        throw new Error(`Cannot reconstruct external table LAYOUT: zone ${index + 1} has a delimiter without a style`);
      }
      if (!style.includes("'")) parts.push(quoteSqlString(delimiter));
    }
    parts.push(length);
    if (nullIf) parts.push(/^NULLIF\b/iu.test(nullIf) ? nullIf : `NULLIF ${nullIf}`);
    return parts.filter(Boolean).join(' ');
  }).join(', ');
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
  const signatureOpen = procedure.procedureSignature.indexOf('(');
  const commentSignature = signatureOpen >= 0
    ? procedure.procedureSignature.slice(signatureOpen)
    : argumentsClause;
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
    if (signatureOpen < 0) {
      throw new Error(`Procedure signature is required to reconstruct the comment for ${procedure.procedureName}`);
    }
    lines.push(
      `COMMENT ON PROCEDURE ${qualifiedName}${commentSignature} IS ${quoteSqlString(procedure.description)};`,
    );
  }

  return lines.join('\n');
}

function externalStringOption(lines: string[], keyword: string, value: string | null): void {
  if (value !== null) lines.push(`    ${keyword} ${quoteSqlString(value)}`);
}

function externalLayoutOption(lines: string[], value: string | null): void {
  const layout = value?.trim();
  if (!layout) return;
  // LAYOUT is a fixed-width zone definition, not a quoted string value.
  const zoneDefinitions = layout.startsWith('(') && layout.endsWith(')')
    ? layout
    : `(${layout})`;
  lines.push(`    LAYOUT ${zoneDefinitions}`);
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
  if (external.compressionMode) lines.push(`    COMPRESS ${external.compressionMode}`);
  else externalBooleanOption(lines, 'COMPRESS', external.compress);
  externalBooleanOption(lines, 'INCLUDEHEADER', external.includeHeader);
  externalBooleanOption(lines, 'LFINSTRING', external.lfInString);
  externalStringOption(lines, 'DATESTYLE', external.dateStyle);
  externalStringOption(lines, 'DATEDELIM', external.dateDelim);
  externalStringOption(lines, 'TIMEDELIM', external.timeDelim);
  externalStringOption(lines, 'BOOLSTYLE', external.boolStyle);
  externalStringOption(lines, 'FORMAT', external.format);
  externalNumericOption(lines, 'SOCKETBUFSIZE', external.socketBufSize);
  // RECORDDELIM is a literal byte sequence; Netezza does not decode `\\n` escapes.
  externalStringOption(lines, 'RECORDDELIM', external.recordDelim);
  externalNumericOption(lines, 'MAXROWS', external.maxRows);
  externalBooleanOption(lines, 'REQUIREQUOTES', external.requireQuotes);
  externalNumericOption(lines, 'RECORDLENGTH', external.recordLength);
  externalStringOption(lines, 'DATETIMEDELIM', external.dateTimeDelim);
  externalStringOption(lines, 'REJECTFILE', external.rejectFile);
  externalLayoutOption(lines, external.layout ?? null);
  externalBooleanOption(lines, 'INCLUDEZEROSECONDS', external.includeZeroSeconds ?? null);
  externalStringOption(lines, 'MERIDIANDELIM', external.meridianDelim ?? null);
  lines.push(');');
  return lines.join('\n');
}

function quoteMultiPartReference(
  reference: string,
  referenceDatabase?: string | null,
  referenceSchema?: string | null,
): string {
  const rawParts: string[] = [];
  let current = '';
  let quoted = false;
  for (let i = 0; i < reference.length; i += 1) {
    const character = reference[i];
    if (character === '"') {
      if (quoted && reference[i + 1] === '"') {
        current += '""';
        i += 1;
      } else {
        current += character;
        quoted = !quoted;
      }
    } else if (character === '.' && !quoted) {
      rawParts.push(current);
      current = '';
    } else current += character;
  }
  rawParts.push(current);
  if (quoted) throw new Error(`Invalid synonym target: ${reference}`);
  const parts = rawParts.map((rawPart) => {
    const part = rawPart.trim();
    if (!part.startsWith('"')) {
      if (part.includes('"')) throw new Error(`Invalid synonym target: ${reference}`);
      return part;
    }
    if (part.length < 2 || !part.endsWith('"')) throw new Error(`Invalid synonym target: ${reference}`);
    let identifier = '';
    for (let index = 1; index < part.length - 1; index += 1) {
      if (part[index] === '"') {
        if (part[index + 1] !== '"' || index + 1 >= part.length - 1) {
          throw new Error(`Invalid synonym target: ${reference}`);
        }
        identifier += '"';
        index += 1;
      } else identifier += part[index];
    }
    return identifier;
  });
  const hasOmittedSchema = parts.length === 3 && parts[0] !== '' && parts[1] === '' && parts[2] !== '';
  if ((parts.some(part => !part) && !hasOmittedSchema) || parts.length > 3) {
    throw new Error(`Invalid synonym target: ${reference}`);
  }
  if (parts.length === 1 && referenceDatabase) {
    parts.unshift(referenceDatabase, referenceSchema ?? '');
  } else if (parts.length === 1 && referenceSchema) {
    parts.unshift(referenceSchema);
  } else if (parts.length === 2 && referenceDatabase) {
    parts.unshift(referenceDatabase);
  }
  return parts.map(part => {
    if (!part) return '';
    return quoteNetezzaIdentifier(part);
  }).join('.');
}

/** Builds a synonym definition while preserving a catalog-qualified target. */
export function buildNetezzaSynonymDdl(
  database: string,
  schema: string,
  synonymName: string,
  synonym: DatabaseSynonymInfo,
): string {
  const ownerSchema = quoteNetezzaIdentifier(schema);
  const synonymIdentifier = quoteNetezzaIdentifier(synonymName);
  const lines = [
    `CREATE SYNONYM ${quoteNetezzaIdentifier(database)}.${ownerSchema}.${synonymIdentifier} FOR ${quoteMultiPartReference(synonym.referenceObjectName, synonym.referenceDatabase, synonym.referenceSchema)};`,
  ];

  if (synonym.description) {
    lines.push(`COMMENT ON SYNONYM ${quoteNetezzaIdentifier(database)}.${ownerSchema}.${synonymIdentifier} IS ${quoteSqlString(synonym.description)};`);
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
