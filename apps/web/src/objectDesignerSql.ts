import type {
  DatabaseDesignerCapability,
  DatabaseDesignerCapabilityKey,
  DatabaseKind,
  DesignerOperation,
} from '@justybase/contracts';
import { UnsupportedDesignerOperationError } from '@justybase/contracts';

export interface DesignerColumnInput {
  name: string;
  dataType: string;
  notNull: boolean;
  defaultExpression: string;
}

export interface DesignerRelationalIndexInput {
  name: string;
  columns: string;
  unique: boolean;
}

export interface NetezzaPhysicalDesignInput {
  distributionMethod: 'RANDOM' | 'HASH';
  distributionColumns: string;
  organizationColumns: string;
  organizationNone: boolean;
  organizationMaxRowsPerZone: string;
}

export interface ClickHouseSkippingIndexInput {
  name: string;
  expression: string;
  indexType: string;
  granularity: string;
}

export interface VerticaProjectionInput {
  name: string;
  columns: string;
  orderBy: string;
  segmentation: string;
  kSafety: string;
}

export interface SnowflakeClusteringInput {
  expressions: string;
}

export interface DesignerForeignKeyInput {
  name: string;
  columns: string;
  referencedSchema: string;
  referencedTable: string;
  referencedColumns: string;
  match: '' | 'FULL' | 'PARTIAL' | 'SIMPLE';
  onDelete: '' | 'NO ACTION' | 'RESTRICT' | 'CASCADE' | 'SET NULL' | 'SET DEFAULT';
  onUpdate: '' | 'NO ACTION' | 'RESTRICT' | 'CASCADE' | 'SET NULL' | 'SET DEFAULT';
  deferrable: boolean;
  initiallyDeferred: boolean;
  notValid: boolean;
}

export interface DesignerCheckConstraintInput {
  name: string;
  expression: string;
  notValid: boolean;
}

export interface DesignerTriggerInput {
  name: string;
  timing: 'BEFORE' | 'AFTER' | 'INSTEAD OF';
  event: 'INSERT' | 'UPDATE' | 'DELETE';
  updateColumns: string;
  level: 'ROW' | 'STATEMENT';
  whenExpression: string;
  body: string;
  objectType?: string;
}

export interface DesignerDropTriggerInput {
  name: string;
}

export interface DesignerViewInput {
  definition: string;
  replace: boolean;
}

export interface DesignerRoutineInput {
  parameters: string;
  returnType: string;
  executeAs: 'OWNER' | 'CALLER';
  body: string;
}

export interface ClickHousePartitionOperationInput {
  action: 'DROP' | 'DETACH' | 'ATTACH' | 'OPTIMIZE';
  partition: string;
}

const STRING_LIKE_DEFAULT_TYPES = new Set([
  'VARCHAR', 'NVARCHAR', 'VARCHAR2', 'CHAR', 'CHARACTER', 'NCHAR', 'TEXT',
  'DATE', 'TIME', 'TIMESTAMP', 'DATETIME', 'TIMESTAMPTZ', 'TIMESTAMP_NTZ', 'TIMESTAMP_TZ',
]);

function requireFragment(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${label} is required.`);
  if (hasUnsafeFragmentSyntax(trimmed)) {
    throw new Error(`${label} cannot contain SQL statement separators or comments.`);
  }
  return trimmed;
}

type DesignerQuote = "'" | '"' | '`' | '[';

function hasUnsafeFragmentSyntax(value: string): boolean {
  let quote: DesignerQuote | undefined;
  let dollarQuote: string | undefined;

  for (let index = 0; index < value.length; index += 1) {
    const character = value[index] ?? '';
    const next = value[index + 1] ?? '';

    if (dollarQuote) {
      if (value.startsWith(dollarQuote, index)) {
        index += dollarQuote.length - 1;
        dollarQuote = undefined;
      }
      continue;
    }

    if (quote) {
      if (quote === '[') {
        if (character === ']' && next === ']') index += 1;
        else if (character === ']') quote = undefined;
      } else if (character === quote && next === quote) {
        index += 1;
      } else if (character === quote) {
        quote = undefined;
      }
      continue;
    }

    if (character === "'" || character === '"' || character === '`') {
      quote = character;
      continue;
    }
    if (character === '[') {
      quote = '[';
      continue;
    }
    if (character === '$') {
      const match = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/u.exec(value.slice(index));
      if (match) {
        dollarQuote = match[0];
        index += match[0].length - 1;
        continue;
      }
    }
    if (character === ';'
      || (character === '-' && next === '-')
      || (character === '/' && next === '*')
      || (character === '*' && next === '/')) {
      return true;
    }
  }
  return value.includes('\u0000');
}

function requireTriggerBody(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error('Trigger body is required.');
  if (trimmed.includes('\u0000')) throw new Error('Trigger body cannot contain a NUL character.');
  return trimmed;
}

function requireViewDefinition(value: string): string {
  const withoutTrailingTerminator = value.trim().replace(/;\s*$/u, '');
  return requireFragment(withoutTrailingTerminator, 'View query');
}

function unquoteIdentifier(value: string, databaseKind: DatabaseKind): string {
  const trimmed = value.trim();
  if (trimmed.length < 2) return trimmed;
  if ((databaseKind === 'mysql' || databaseKind === 'clickhouse')
    && trimmed.startsWith('`') && trimmed.endsWith('`')) {
    return trimmed.slice(1, -1).replace(/``/g, '`');
  }
  if (databaseKind === 'mssql' && trimmed.startsWith('[') && trimmed.endsWith(']')) {
    return trimmed.slice(1, -1).replace(/]]/g, ']');
  }
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1).replace(/""/g, '"');
  }
  return trimmed;
}

function requireIdentifier(value: string, label: string, databaseKind: DatabaseKind): string {
  return unquoteIdentifier(requireFragment(value, label), databaseKind);
}

function renderDefaultExpression(value: string, dataType: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '';

  const upper = trimmed.toUpperCase();
  const functionLike = upper.includes('()')
    || upper === 'CURRENT_DATE'
    || upper === 'CURRENT_TIME'
    || upper === 'CURRENT_TIMESTAMP'
    || upper === 'NOW'
    || upper === 'SYSDATE'
    || upper === 'NULL'
    || upper === 'CURRENT_USER'
    || upper === 'GETDATE';
  if (functionLike || trimmed.startsWith("'") || trimmed.startsWith('(')) return trimmed;

  const typeName = dataType.trim().toUpperCase().replace(/\s*\([^)]*\)\s*$/u, '');
  if (STRING_LIKE_DEFAULT_TYPES.has(typeName)) {
    return `'${trimmed.replace(/'/g, "''")}'`;
  }
  return trimmed;
}

export function quoteDesignerIdentifier(value: string, databaseKind: DatabaseKind): string {
  if (databaseKind === 'mysql' || databaseKind === 'clickhouse') {
    return `\`${value.replace(/`/g, '``')}\``;
  }
  if (databaseKind === 'mssql') {
    return `[${value.replace(/]/g, ']]')}]`;
  }
  return `"${value.replace(/"/g, '""')}"`;
}

function splitTopLevelList(value: string): string[] {
  const values: string[] = [];
  let start = 0;
  let depth = 0;
  let quote: DesignerQuote | undefined;
  let dollarQuote: string | undefined;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index] ?? '';
    const next = value[index + 1] ?? '';
    if (dollarQuote) {
      if (value.startsWith(dollarQuote, index)) {
        index += dollarQuote.length - 1;
        dollarQuote = undefined;
      }
      continue;
    }
    if (quote) {
      if (quote === '[') {
        if (character === ']' && next === ']') index += 1;
        else if (character === ']') quote = undefined;
      } else if (character === quote && next === quote) {
        index += 1;
      } else if (character === quote) {
        quote = undefined;
      }
      continue;
    }
    if (character === "'" || character === '"' || character === '`') {
      quote = character;
    } else if (character === '[') {
      quote = '[';
    } else if (character === '$') {
      const match = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/u.exec(value.slice(index));
      if (match) {
        dollarQuote = match[0];
        index += match[0].length - 1;
      }
    } else if (character === '(') {
      depth += 1;
    } else if (character === ')' && depth > 0) {
      depth -= 1;
    } else if (character === ',' && depth === 0) {
      values.push(value.slice(start, index).trim());
      start = index + 1;
    }
  }
  values.push(value.slice(start).trim());
  return values.filter(Boolean);
}

function identifiers(value: string, label: string, databaseKind: DatabaseKind): string[] {
  const values = splitTopLevelList(value);
  if (values.length === 0) throw new Error(`Enter at least one ${label}.`);
  return values.map(item => requireIdentifier(item, label, databaseKind));
}

function normalizedKind(databaseKind: DatabaseKind): string {
  const value = String(databaseKind).trim().toLowerCase();
  if (value === 'postgres') return 'postgresql';
  if (value === 'sqlserver' || value === 'sql server') return 'mssql';
  if (value === 'sqlite3') return 'sqlite';
  return value;
}

function qualifiedDesignerReference(
  databaseKind: DatabaseKind,
  schema: string,
  table: string,
): string {
  const tableName = quoteDesignerIdentifier(requireIdentifier(table, 'Referenced table', databaseKind), databaseKind);
  const schemaName = schema.trim();
  return schemaName
    ? `${quoteDesignerIdentifier(requireIdentifier(schemaName, 'Referenced schema', databaseKind), databaseKind)}.${tableName}`
    : tableName;
}

const FOREIGN_KEY_ACTIONS = new Set([
  'NO ACTION',
  'RESTRICT',
  'CASCADE',
  'SET NULL',
  'SET DEFAULT',
]);

function optionalForeignKeyAction(value: string, label: string): string {
  const action = value.trim().toUpperCase();
  if (!action) return '';
  if (!FOREIGN_KEY_ACTIONS.has(action)) throw new Error(`${label} is not a supported referential action.`);
  return action;
}

function validateConstraintOptions(
  databaseKind: DatabaseKind,
  input: Pick<DesignerForeignKeyInput, 'match' | 'deferrable' | 'initiallyDeferred' | 'notValid'>,
): void {
  const kind = normalizedKind(databaseKind);
  if (input.match && !['FULL', 'PARTIAL', 'SIMPLE'].includes(input.match)) {
    throw new Error('MATCH must be FULL, PARTIAL, or SIMPLE.');
  }
  if (input.notValid && kind !== 'postgresql') {
    throw new Error('NOT VALID is supported only by PostgreSQL foreign keys.');
  }
  if ((input.deferrable || input.initiallyDeferred) && !['postgresql', 'oracle', 'db2'].includes(kind)) {
    throw new Error('Deferrable foreign keys are not supported by this dialect.');
  }
  if (input.initiallyDeferred && !input.deferrable) {
    throw new Error('INITIALLY DEFERRED requires DEFERRABLE.');
  }
}

function optionalPositiveInteger(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '';
  if (!/^\d+$/.test(trimmed) || Number(trimmed) <= 0) {
    throw new Error(`${label} must be a positive integer.`);
  }
  return trimmed;
}

function assertOperation(
  capability: DatabaseDesignerCapability | undefined,
  capabilityKey: DatabaseDesignerCapabilityKey,
  operation: DesignerOperation,
  allowAlternative = false,
): void {
  if (!capability || !capability.operations.includes(operation)
    || capability.level === 'unsupported'
    || capability.level === 'runtime-unavailable'
    || capability.level === 'privilege-blocked'
    || (!allowAlternative && capability.level === 'alternative')) {
    throw new UnsupportedDesignerOperationError(
      capabilityKey,
      operation,
      capability?.reason ?? `The ${capabilityKey} operation is not available for this target.`,
    );
  }
}

export function buildAddColumnSql(
  targetSql: string,
  databaseKind: DatabaseKind,
  input: DesignerColumnInput,
  capability?: DatabaseDesignerCapability,
): string {
  assertOperation(capability, 'alterTable', 'alter');
  const name = requireIdentifier(input.name, 'Column name', databaseKind);
  const dataType = requireFragment(input.dataType, 'Column data type');
  const defaultExpression = renderDefaultExpression(input.defaultExpression, dataType);
  if (defaultExpression) requireFragment(defaultExpression, 'Default expression');
  return `ALTER TABLE ${targetSql} ADD COLUMN ${quoteDesignerIdentifier(name, databaseKind)} ${dataType}${defaultExpression ? ` DEFAULT ${defaultExpression}` : ''}${input.notNull ? ' NOT NULL' : ''};`;
}

export function buildRelationalIndexSql(
  targetSql: string,
  databaseKind: DatabaseKind,
  input: DesignerRelationalIndexInput,
  capability?: DatabaseDesignerCapability,
): string {
  assertOperation(capability, 'indexes', 'create');
  const name = requireIdentifier(input.name, 'Index name', databaseKind);
  const columns = identifiers(input.columns, 'index column', databaseKind);
  return `CREATE ${input.unique ? 'UNIQUE ' : ''}INDEX ${quoteDesignerIdentifier(name, databaseKind)} ON ${targetSql} (${columns.map(column => quoteDesignerIdentifier(column, databaseKind)).join(', ')});`;
}

export function buildDropIndexSql(
  targetSql: string,
  databaseKind: DatabaseKind,
  indexName: string,
  capability?: DatabaseDesignerCapability,
): string {
  assertOperation(capability, 'indexes', 'drop');
  const name = quoteDesignerIdentifier(requireIdentifier(indexName, 'Index name', databaseKind), databaseKind);
  const kind = normalizedKind(databaseKind);
  if (kind === 'mysql' || kind === 'mssql') return `DROP INDEX ${name} ON ${targetSql};`;
  return `DROP INDEX ${name};`;
}

export function buildForeignKeySql(
  targetSql: string,
  databaseKind: DatabaseKind,
  input: DesignerForeignKeyInput,
  capability?: DatabaseDesignerCapability,
): string {
  assertOperation(capability, 'foreignKeys', 'create');
  validateConstraintOptions(databaseKind, input);
  const name = requireIdentifier(input.name, 'Constraint name', databaseKind);
  const columns = identifiers(input.columns, 'foreign-key column', databaseKind);
  const referencedColumns = identifiers(input.referencedColumns, 'referenced column', databaseKind);
  if (columns.length !== referencedColumns.length) {
    throw new Error('The number of local and referenced columns must match.');
  }
  const referencedTable = qualifiedDesignerReference(databaseKind, input.referencedSchema, input.referencedTable);
  const match = input.match ? ` MATCH ${input.match}` : '';
  const onDelete = optionalForeignKeyAction(input.onDelete, 'ON DELETE');
  const onUpdate = optionalForeignKeyAction(input.onUpdate, 'ON UPDATE');
  const deferrable = input.deferrable ? ' DEFERRABLE' : '';
  const initiallyDeferred = input.initiallyDeferred ? ' INITIALLY DEFERRED' : '';
  const notValid = input.notValid ? ' NOT VALID' : '';
  return `ALTER TABLE ${targetSql} ADD CONSTRAINT ${quoteDesignerIdentifier(name, databaseKind)} FOREIGN KEY (${columns.map(column => quoteDesignerIdentifier(column, databaseKind)).join(', ')}) REFERENCES ${referencedTable} (${referencedColumns.map(column => quoteDesignerIdentifier(column, databaseKind)).join(', ')})${match}${onDelete ? ` ON DELETE ${onDelete}` : ''}${onUpdate ? ` ON UPDATE ${onUpdate}` : ''}${deferrable}${initiallyDeferred}${notValid};`;
}

export function buildCheckConstraintSql(
  targetSql: string,
  databaseKind: DatabaseKind,
  input: DesignerCheckConstraintInput,
  capability?: DatabaseDesignerCapability,
): string {
  assertOperation(capability, 'checks', 'create');
  const name = requireIdentifier(input.name, 'Constraint name', databaseKind);
  const expression = requireFragment(input.expression, 'CHECK expression');
  if (input.notValid && normalizedKind(databaseKind) !== 'postgresql') {
    throw new Error('NOT VALID is supported only by PostgreSQL CHECK constraints.');
  }
  return `ALTER TABLE ${targetSql} ADD CONSTRAINT ${quoteDesignerIdentifier(name, databaseKind)} CHECK (${expression})${input.notValid ? ' NOT VALID' : ''};`;
}

export function buildTriggerSql(
  targetSql: string,
  databaseKind: DatabaseKind,
  input: DesignerTriggerInput,
  capability?: DatabaseDesignerCapability,
): string {
  assertOperation(capability, 'triggers', 'create');
  const triggerCapability = capability?.trigger;
  if (!triggerCapability) {
    throw new UnsupportedDesignerOperationError('triggers', 'create', 'Trigger syntax capabilities were not reported for this target.');
  }
  const objectKind = input.objectType?.trim().toUpperCase();
  if (input.timing === 'INSTEAD OF' && triggerCapability.insteadOfObjectKinds
    && !triggerCapability.insteadOfObjectKinds.some(allowedKind => allowedKind.toUpperCase() === objectKind)) {
    throw new Error(`INSTEAD OF triggers can target ${triggerCapability.insteadOfObjectKinds.join(' or ')} only.`);
  }
  const allowedTimings = objectKind && triggerCapability.timingsByObjectKind
    ? triggerCapability.timingsByObjectKind[objectKind] ?? []
    : triggerCapability.timings;
  if (!allowedTimings.includes(input.timing)) {
    throw new Error(`Trigger timing ${input.timing} is not supported for ${objectKind ?? 'this object'} by this dialect.`);
  }
  if (!triggerCapability.events.includes(input.event)) {
    throw new Error(`Trigger event ${input.event} is not supported by this dialect.`);
  }
  const allowedLevels = triggerCapability.levelsByTiming?.[input.timing] ?? triggerCapability.levels;
  if (!allowedLevels.includes(input.level)) {
    throw new Error(`Trigger level ${input.level} is not supported by this dialect.`);
  }
  const name = requireIdentifier(input.name, 'Trigger name', databaseKind);
  const updateColumns = input.event === 'UPDATE' && input.updateColumns.trim()
    ? identifiers(input.updateColumns, 'UPDATE OF column', databaseKind)
    : [];
  if (updateColumns.length > 0 && !triggerCapability.supportsUpdateColumns) {
    throw new Error('UPDATE OF column lists are not supported by this dialect.');
  }
  const event = updateColumns.length > 0
    ? `UPDATE OF ${updateColumns.map(column => quoteDesignerIdentifier(column, databaseKind)).join(', ')}`
    : input.event;
  const whenExpression = input.whenExpression.trim();
  if (whenExpression && !triggerCapability.supportsWhen) {
    throw new Error('WHEN predicates are not supported by this dialect.');
  }
  if (whenExpression) requireFragment(whenExpression, 'WHEN expression');
  const body = requireTriggerBody(input.body);
  const triggerName = quoteDesignerIdentifier(name, databaseKind);
  const whenClause = whenExpression ? ` WHEN (${whenExpression})` : '';
  const level = input.level === 'ROW' ? 'FOR EACH ROW' : 'FOR EACH STATEMENT';
  switch (triggerCapability.bodyStyle) {
    case 'postgresql-function': {
      const functionCall = requireFragment(body, 'Trigger function call');
      return `CREATE TRIGGER ${triggerName} ${input.timing} ${event} ON ${targetSql} ${level}${whenClause} EXECUTE FUNCTION ${functionCall};`;
    }
    case 'oracle-block':
      return `CREATE OR REPLACE TRIGGER ${triggerName} ${input.timing} ${event} ON ${targetSql}${input.level === 'ROW' ? ' FOR EACH ROW' : ''}${whenClause}\nBEGIN\n${body}\nEND;`;
    case 'mssql-batch':
      return `CREATE TRIGGER ${triggerName} ON ${targetSql} ${input.timing} ${event} AS\nBEGIN\n${body}\nEND;`;
    case 'db2-atomic':
      return `CREATE TRIGGER ${triggerName} ${input.timing} ${event} ON ${targetSql} ${level} MODE DB2SQL\nBEGIN ATOMIC\n${body}\nEND;`;
    case 'sql-block':
    default:
      return `CREATE TRIGGER ${triggerName} ${input.timing} ${event} ON ${targetSql} ${level}${whenClause}\nBEGIN\n${body}\nEND;`;
  }
}

export function buildDropTriggerSql(
  targetSql: string,
  databaseKind: DatabaseKind,
  input: DesignerDropTriggerInput,
  capability?: DatabaseDesignerCapability,
): string {
  assertOperation(capability, 'triggers', 'drop');
  const name = quoteDesignerIdentifier(requireIdentifier(input.name, 'Trigger name', databaseKind), databaseKind);
  const kind = normalizedKind(databaseKind);
  if (kind === 'mssql' || kind === 'postgresql') return `DROP TRIGGER ${name} ON ${targetSql};`;
  return `DROP TRIGGER ${name};`;
}

export function buildViewSql(
  targetSql: string,
  input: DesignerViewInput,
  capability?: DatabaseDesignerCapability,
): string {
  assertOperation(capability, 'views', 'create');
  const definition = requireViewDefinition(input.definition);
  const viewName = requireFragment(targetSql, 'View name');
  const replaceStyle = capability?.view?.replaceStyle ?? 'create';
  if (input.replace && replaceStyle === 'create') {
    throw new Error('Replacing an existing view is not supported by this dialect.');
  }
  if (input.replace && replaceStyle === 'drop-and-create') {
    return `DROP VIEW IF EXISTS ${viewName};\nCREATE VIEW ${viewName} AS\n${definition};`;
  }
  const createVerb = input.replace
    ? replaceStyle === 'create-or-alter' ? 'CREATE OR ALTER VIEW' : 'CREATE OR REPLACE VIEW'
    : 'CREATE VIEW';
  return `${createVerb} ${viewName} AS\n${definition};`;
}

export function buildNetezzaRoutineSql(
  targetSql: string,
  input: DesignerRoutineInput,
  capability?: DatabaseDesignerCapability,
): string {
  assertOperation(capability, 'procedures', 'create');
  if (capability?.routine?.bodyStyle !== 'netezza-nzplsql') {
    throw new UnsupportedDesignerOperationError('procedures', 'create', 'Netezza NZPLSQL routine syntax is not available for this target.');
  }
  const parameters = input.parameters.trim()
    ? splitTopLevelList(input.parameters).map(parameter => requireFragment(parameter, 'Routine parameter')).join(', ')
    : '';
  const returnType = requireFragment(input.returnType, 'Routine return type');
  const body = requireTriggerBody(input.body);
  if (/\bEND_PROC\b/i.test(body)) throw new Error('Routine body cannot contain the END_PROC terminator.');
  return `CREATE OR REPLACE PROCEDURE ${targetSql}(${parameters})\nRETURNS ${returnType}\nEXECUTE AS ${input.executeAs}\nLANGUAGE NZPLSQL\nAS BEGIN_PROC\nBEGIN\n${body}\nEND;\nEND_PROC;`;
}

export function buildDropConstraintSql(
  targetSql: string,
  databaseKind: DatabaseKind,
  constraintName: string,
  constraintKind: 'foreignKey' | 'check' | 'primaryKey' | 'unique',
  capability?: DatabaseDesignerCapability,
): string {
  const capabilityKey: DatabaseDesignerCapabilityKey = constraintKind === 'foreignKey'
    ? 'foreignKeys'
    : constraintKind === 'check' ? 'checks' : 'alterTable';
  assertOperation(capability, capabilityKey, 'drop');
  const name = quoteDesignerIdentifier(requireIdentifier(constraintName, 'Constraint name', databaseKind), databaseKind);
  const kind = normalizedKind(databaseKind);
  if (kind === 'mysql' && constraintKind === 'foreignKey') {
    return `ALTER TABLE ${targetSql} DROP FOREIGN KEY ${name};`;
  }
  if (kind === 'mysql' && constraintKind === 'check') {
    return `ALTER TABLE ${targetSql} DROP CHECK ${name};`;
  }
  return `ALTER TABLE ${targetSql} DROP CONSTRAINT ${name};`;
}

export function buildNetezzaPhysicalDesignSql(
  targetSql: string,
  input: NetezzaPhysicalDesignInput,
  capability?: DatabaseDesignerCapability,
): string {
  assertOperation(capability, 'partitions', 'alter', true);
  const statements = [buildNetezzaDistributionSql(targetSql, input, capability)];
  const hasOrganizationChange = input.organizationNone
    || input.organizationColumns.trim().length > 0
    || input.organizationMaxRowsPerZone.trim().length > 0;
  if (hasOrganizationChange) statements.push(renderNetezzaOrganizationSql(targetSql, input));
  return statements.join('\n');
}

export function buildNetezzaDistributionSql(
  targetSql: string,
  input: Pick<NetezzaPhysicalDesignInput, 'distributionMethod' | 'distributionColumns'>,
  capability?: DatabaseDesignerCapability,
): string {
  assertOperation(capability, 'partitions', 'alter', true);
  const statements: string[] = [];
  if (input.distributionMethod === 'RANDOM') {
    statements.push(`ALTER TABLE ${targetSql} DISTRIBUTE ON RANDOM;`);
  } else {
    const columns = identifiers(input.distributionColumns, 'distribution column', 'netezza');
    statements.push(`ALTER TABLE ${targetSql} DISTRIBUTE ON (${columns.map(column => quoteDesignerIdentifier(column, 'netezza')).join(', ')});`);
  }
  return statements.join('\n');
}

export function buildNetezzaOrganizationSql(
  targetSql: string,
  input: Pick<NetezzaPhysicalDesignInput, 'organizationColumns' | 'organizationNone' | 'organizationMaxRowsPerZone'>,
  capability?: DatabaseDesignerCapability,
): string {
  assertOperation(capability, 'indexes', 'alter', true);
  return renderNetezzaOrganizationSql(targetSql, input);
}

function renderNetezzaOrganizationSql(
  targetSql: string,
  input: Pick<NetezzaPhysicalDesignInput, 'organizationColumns' | 'organizationNone' | 'organizationMaxRowsPerZone'>,
): string {
  if (input.organizationNone) {
    return `ALTER TABLE ${targetSql} ORGANIZE ON NONE;`;
  }
  const columns = identifiers(input.organizationColumns, 'organization column', 'netezza');
  const maxRowsPerZone = optionalPositiveInteger(input.organizationMaxRowsPerZone, 'MAX_ROWS_PER_ZONE');
  return `ALTER TABLE ${targetSql} ORGANIZE ON (${columns.map(column => quoteDesignerIdentifier(column, 'netezza')).join(', ')})${maxRowsPerZone ? ` WITH (MAX_ROWS_PER_ZONE=${maxRowsPerZone})` : ''};`;
}

export function buildClickHouseSkippingIndexSql(
  targetSql: string,
  input: ClickHouseSkippingIndexInput,
  capability?: DatabaseDesignerCapability,
): string {
  assertOperation(capability, 'indexes', 'create', true);
  const name = requireIdentifier(input.name, 'Index name', 'clickhouse');
  const expression = requireFragment(input.expression, 'Index expression');
  const indexType = requireFragment(input.indexType, 'Index type');
  if (!/^[A-Za-z][A-Za-z0-9_]*(?:\([^;]*\))?$/.test(indexType)) throw new Error('Unsupported ClickHouse data-skipping index type.');
  const granularity = Number(input.granularity.trim());
  if (!Number.isInteger(granularity) || granularity <= 0) throw new Error('Index granularity must be a positive integer.');
  return `ALTER TABLE ${targetSql} ADD INDEX ${quoteDesignerIdentifier(name, 'clickhouse')} ${expression} TYPE ${indexType} GRANULARITY ${granularity};`;
}

export function buildClickHouseSkippingIndexDropSql(
  targetSql: string,
  indexName: string,
  capability?: DatabaseDesignerCapability,
): string {
  assertOperation(capability, 'indexes', 'drop', true);
  return `ALTER TABLE ${targetSql} DROP INDEX ${quoteDesignerIdentifier(requireIdentifier(indexName, 'Index name', 'clickhouse'), 'clickhouse')};`;
}

export function buildClickHousePartitionOperationSql(
  targetSql: string,
  input: ClickHousePartitionOperationInput,
  capability?: DatabaseDesignerCapability,
): string {
  const partition = requireFragment(input.partition, 'Partition expression/value');
  if (input.action === 'OPTIMIZE') {
    assertOperation(capability, 'partitions', 'rebuild');
    return `OPTIMIZE TABLE ${targetSql} PARTITION ${partition} FINAL;`;
  }
  const operation = input.action === 'DROP' ? 'drop' : input.action === 'ATTACH' ? 'attach' : 'detach';
  assertOperation(capability, 'partitions', operation);
  return `ALTER TABLE ${targetSql} ${input.action} PARTITION ${partition};`;
}

export function buildVerticaProjectionSql(
  targetSql: string,
  input: VerticaProjectionInput,
  capability?: DatabaseDesignerCapability,
): string {
  assertOperation(capability, 'indexes', 'create', true);
  const name = requireIdentifier(input.name, 'Projection name', 'vertica');
  const columns = identifiers(input.columns, 'projection column', 'vertica');
  const orderBy = input.orderBy.trim() ? identifiers(input.orderBy, 'sort column', 'vertica') : columns;
  const segmentation = input.segmentation.trim() ? requireFragment(input.segmentation, 'Segmentation expression') : '';
  const kSafety = input.kSafety.trim();
  if (kSafety && (!/^\d+$/.test(kSafety) || Number(kSafety) < 0)) throw new Error('K-safety must be a non-negative integer.');
  const segmentationClause = segmentation ? ` SEGMENTED BY ${segmentation} ALL NODES` : '';
  const kSafetyClause = kSafety ? ` KSAFE ${kSafety}` : '';
  return `CREATE PROJECTION ${quoteDesignerIdentifier(name, 'vertica')} AS\nSELECT ${columns.map(column => quoteDesignerIdentifier(column, 'vertica')).join(', ')}\nFROM ${targetSql}\nORDER BY (${orderBy.map(column => quoteDesignerIdentifier(column, 'vertica')).join(', ')})${segmentationClause}${kSafetyClause};`;
}

export function buildVerticaProjectionDropSql(
  projectionName: string,
  capability?: DatabaseDesignerCapability,
): string {
  assertOperation(capability, 'indexes', 'drop', true);
  return `DROP PROJECTION ${quoteDesignerIdentifier(requireIdentifier(projectionName, 'Projection name', 'vertica'), 'vertica')};`;
}

export function buildSnowflakeClusteringSql(
  targetSql: string,
  input: SnowflakeClusteringInput,
  capability?: DatabaseDesignerCapability,
): string {
  assertOperation(capability, 'indexes', 'alter', true);
  const expressions = splitTopLevelList(input.expressions).map(item => requireFragment(item, 'Clustering expression'));
  if (expressions.length === 0) throw new Error('Enter at least one clustering expression.');
  return `ALTER TABLE ${targetSql} CLUSTER BY (${expressions.join(', ')});`;
}

export function buildSnowflakeClusteringDropSql(
  targetSql: string,
  capability?: DatabaseDesignerCapability,
): string {
  assertOperation(capability, 'indexes', 'drop', true);
  return `ALTER TABLE ${targetSql} DROP CLUSTERING KEY;`;
}
