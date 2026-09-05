import { createHash } from 'node:crypto';
import type {
  DatabaseDesignerColumn,
  DatabaseDesignerConstraint,
  DatabaseDesignerIndex,
  DatabaseDesignerTarget,
  DatabaseDesignerTrigger,
  DatabaseObjectSnapshot,
  DesignerSnapshotRequest,
  DesignerSnapshotResponse,
  QueryColumn,
} from '@justybase/contracts';
import { executeNetezzaQuery } from './netezza';
import { normalizeDuckDbCatalog } from './duckdb';
import type { StoredConnection } from './store';

export class DesignerSnapshotUnavailableError extends Error {
  public readonly code = 'DESIGNER_SNAPSHOT_UNAVAILABLE';

  public constructor(message: string) {
    super(message);
    this.name = 'DesignerSnapshotUnavailableError';
  }
}

type Row = Record<string, unknown>;

function required(value: string | undefined, field: string): string {
  const trimmed = value?.trim() ?? '';
  if (!trimmed) throw new Error(`${field} is required.`);
  return trimmed;
}

function quoteIdentifier(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function sqlLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function rowString(row: Row, key: string, fallback = ''): string {
  const value = row[key];
  return value === null || value === undefined ? fallback : String(value);
}

function rowNumber(row: Row, key: string, fallback = 0): number {
  const value = Number(row[key]);
  return Number.isFinite(value) ? value : fallback;
}

function rowBoolean(row: Row, key: string): boolean {
  const value = row[key];
  return value === true || value === 1 || value === '1' || String(value).toUpperCase() === 'TRUE';
}

async function readRows(
  profile: StoredConnection,
  database: string,
  sql: string,
  masterKey: string,
): Promise<Row[]> {
  let columns: QueryColumn[] = [];
  const values: unknown[][] = [];
  await executeNetezzaQuery(profile, sql, {
    masterKey,
    maxRows: 20_000,
    timeoutSeconds: 30,
    readOnly: true,
    database,
  }, {
    onColumns: nextColumns => { columns = nextColumns; },
    onRows: rows => { values.push(...rows); },
    onCommand: () => undefined,
  });
  const names = columns.map((column, index) => column.name.trim().toLowerCase() || `column_${index}`);
  return values.map(row => Object.fromEntries(names.map((name, index) => [name, row[index]])));
}

function splitColumnList(value: string): string[] {
  return splitTopLevelList(value).map(item => item.trim().replace(/^"(.*)"$/u, '$1').replace(/""/g, '"')).filter(Boolean);
}

function splitTopLevelList(value: string): string[] {
  const items: string[] = [];
  let start = 0;
  let depth = 0;
  let quote: "'" | '"' | '`' | '[' | undefined;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index] ?? '';
    const next = value[index + 1] ?? '';
    if (quote) {
      if (quote === '[') {
        if (character === ']') quote = undefined;
      } else if (character === quote && next === quote) {
        index += 1;
      } else if (character === quote) {
        quote = undefined;
      }
      continue;
    }
    if (character === "'" || character === '"' || character === '`') quote = character;
    else if (character === '[') quote = '[';
    else if (character === '(') depth += 1;
    else if (character === ')' && depth > 0) depth -= 1;
    else if (character === ',' && depth === 0) {
      items.push(value.slice(start, index).trim());
      start = index + 1;
    }
  }
  items.push(value.slice(start).trim());
  return items.filter(Boolean);
}

function rowStringArray(row: Row, key: string): string[] {
  const value = row[key];
  if (Array.isArray(value)) return value.map(item => String(item)).filter(Boolean);
  if (typeof value !== 'string') return [];
  const trimmed = value.trim();
  const list = trimmed.startsWith('[') && trimmed.endsWith(']')
    ? trimmed.slice(1, -1)
    : trimmed;
  return splitTopLevelList(list)
    .map(item => item.trim().replace(/^"(.*)"$/u, '$1').replace(/""/g, '"'))
    .filter(Boolean);
}

function matchingParenthesis(source: string, openingIndex: number): number {
  let depth = 0;
  let quote: "'" | '"' | '`' | undefined;
  for (let index = openingIndex; index < source.length; index += 1) {
    const character = source[index] ?? '';
    const next = source[index + 1] ?? '';
    if (quote) {
      if (character === quote && next === quote) index += 1;
      else if (character === quote) quote = undefined;
      continue;
    }
    if (character === "'" || character === '"' || character === '`') quote = character;
    else if (character === '(') depth += 1;
    else if (character === ')' && --depth === 0) return index;
  }
  return -1;
}

function sqliteTableDefinitionItems(source: string): string[] {
  let quote: "'" | '"' | '`' | undefined;
  let openingIndex = -1;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index] ?? '';
    const next = source[index + 1] ?? '';
    if (quote) {
      if (character === quote && next === quote) index += 1;
      else if (character === quote) quote = undefined;
      continue;
    }
    if (character === "'" || character === '"' || character === '`') quote = character;
    else if (character === '(') {
      openingIndex = index;
      break;
    }
  }
  if (openingIndex < 0) return [];
  const closingIndex = matchingParenthesis(source, openingIndex);
  if (closingIndex < 0) return [];
  const definition = source.slice(openingIndex + 1, closingIndex);
  const items: string[] = [];
  let start = 0;
  let depth = 0;
  quote = undefined;
  for (let index = 0; index < definition.length; index += 1) {
    const character = definition[index] ?? '';
    const next = definition[index + 1] ?? '';
    if (quote) {
      if (character === quote && next === quote) index += 1;
      else if (character === quote) quote = undefined;
      continue;
    }
    if (character === "'" || character === '"' || character === '`') quote = character;
    else if (character === '(') depth += 1;
    else if (character === ')' && depth > 0) depth -= 1;
    else if (character === ',' && depth === 0) {
      items.push(definition.slice(start, index).trim());
      start = index + 1;
    }
  }
  items.push(definition.slice(start).trim());
  return items.filter(Boolean);
}

function parseSqliteCheckConstraints(source: string): DatabaseDesignerConstraint[] {
  return sqliteTableDefinitionItems(source).flatMap(item => {
    const start = /\b(?:CONSTRAINT\s+((?:"(?:[^"]|"")+"|[A-Za-z_][A-Za-z0-9_$]*))\s+)?CHECK\s*\(/i.exec(item);
    if (!start) return [];
    const openingIndex = item.indexOf(start[0]) + start[0].lastIndexOf('(');
    const closingIndex = matchingParenthesis(item, openingIndex);
    if (closingIndex < 0) return [];
    const expression = item.slice(openingIndex + 1, closingIndex).trim();
    if (!expression) return [];
    const rawName = start[1]?.trim();
    const name = rawName?.startsWith('"') && rawName.endsWith('"')
      ? rawName.slice(1, -1).replace(/""/g, '"')
      : rawName;
    return [{ kind: 'check' as const, ...(name ? { name } : {}), expression }];
  });
}

function viewQueryFromSource(source: string): string {
  const query = /\bAS\b([\s\S]*)$/i.exec(source)?.[1]?.trim() ?? '';
  return query.replace(/;\s*$/u, '').trim();
}

function sqliteColumnsFromRows(rows: Row[]): DatabaseDesignerColumn[] {
  return rows.map(row => ({
    name: rowString(row, 'name'),
    dataType: rowString(row, 'type', 'UNKNOWN'),
    ordinal: rowNumber(row, 'cid') + 1,
    nullable: !rowBoolean(row, 'notnull'),
    ...(Object.prototype.hasOwnProperty.call(row, 'dflt_value')
      ? { defaultExpression: row.dflt_value as string | null }
      : Object.prototype.hasOwnProperty.call(row, 'default_value')
      ? { defaultExpression: row.default_value as string | null }
      : {}),
  })).filter(column => column.name.length > 0);
}

function parseSqliteTrigger(name: string, source: string): DatabaseDesignerTrigger {
  const header = /\b(BEFORE|AFTER|INSTEAD\s+OF)\s+(INSERT|DELETE|UPDATE(?:\s+OF\s+.+?)?)\s+ON\s+/i.exec(source);
  const timing = header?.[1]?.toUpperCase().replace(/\s+/g, ' ') as DatabaseDesignerTrigger['timing'] | undefined;
  const eventText = header?.[2]?.trim() ?? '';
  const normalizedEventText = eventText.toUpperCase();
  const updateColumns = /^UPDATE\s+OF\s+(.+)$/i.exec(eventText)?.[1];
  const event = normalizedEventText.startsWith('UPDATE') ? 'UPDATE' : normalizedEventText.startsWith('INSERT') ? 'INSERT' : normalizedEventText.startsWith('DELETE') ? 'DELETE' : undefined;
  const whenExpression = /\bWHEN\s+([\s\S]*?)\s+BEGIN\b/i.exec(source)?.[1]?.trim();
  return {
    name,
    timing: timing ?? 'UNSPECIFIED',
    events: event ? [event] : [],
    level: 'ROW',
    ...(updateColumns ? { updateColumns: splitColumnList(updateColumns) } : {}),
    ...(whenExpression ? { whenExpression } : {}),
    body: source,
  };
}

function fingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function fingerprintTarget(target: DatabaseDesignerTarget): Pick<DatabaseDesignerTarget, 'connectionId' | 'database' | 'schema' | 'objectName' | 'objectType'> {
  return {
    connectionId: target.connectionId,
    database: target.database,
    schema: target.schema,
    objectName: target.objectName,
    objectType: target.objectType,
  };
}

async function loadSqliteViewSnapshot(
  profile: StoredConnection,
  request: DesignerSnapshotRequest,
  masterKey: string,
): Promise<DesignerSnapshotResponse> {
  const database = request.database?.trim() || 'main';
  const schema = request.schema?.trim() || database;
  const objectName = required(request.objectName, 'objectName');
  const objectRows = await readRows(
    profile,
    database,
    `SELECT name, type, sql FROM ${quoteIdentifier(schema)}.sqlite_master WHERE name = ${sqlLiteral(objectName)} AND type = 'view'`,
    masterKey,
  );
  const object = objectRows[0];
  if (!object) throw new Error(`SQLite view ${schema}.${objectName} was not found.`);

  const tableInfo = await readRows(profile, database, `PRAGMA ${quoteIdentifier(schema)}.table_info(${quoteIdentifier(objectName)})`, masterKey);
  const triggerRows = await readRows(
    profile,
    database,
    `SELECT name, sql FROM ${quoteIdentifier(schema)}.sqlite_master WHERE type = 'trigger' AND tbl_name = ${sqlLiteral(objectName)} ORDER BY name`,
    masterKey,
  );
  const sourceDdl = rowString(object, 'sql') || undefined;
  const definition = {
    kind: 'view' as const,
    query: viewQueryFromSource(sourceDdl ?? ''),
    columns: sqliteColumnsFromRows(tableInfo),
    triggers: triggerRows.map(row => parseSqliteTrigger(rowString(row, 'name'), rowString(row, 'sql'))).filter(trigger => trigger.name.length > 0),
    options: {},
  };
  const target: DatabaseDesignerTarget = {
    connectionId: profile.id,
    connectionName: profile.name,
    database,
    schema,
    objectName,
    objectType: 'VIEW',
  };
  const snapshotValue = { target: fingerprintTarget(target), objectType: 'VIEW', sourceDdl, definition };
  const snapshot: DatabaseObjectSnapshot = {
    target,
    objectType: 'VIEW',
    fingerprint: fingerprint(snapshotValue),
    loadedAt: new Date().toISOString(),
    ...(sourceDdl ? { sourceDdl } : {}),
    definition,
  };
  return { target, snapshot };
}

async function loadSqliteSnapshot(
  profile: StoredConnection,
  request: DesignerSnapshotRequest,
  masterKey: string,
): Promise<DesignerSnapshotResponse> {
  const database = request.database?.trim() || 'main';
  const schema = request.schema?.trim() || database;
  const objectName = required(request.objectName, 'objectName');
  const catalog = schema;
  const objectRows = await readRows(
    profile,
    database,
    `SELECT name, type, sql FROM ${quoteIdentifier(catalog)}.sqlite_master WHERE name = ${sqlLiteral(objectName)} AND type = 'table'`,
    masterKey,
  );
  const object = objectRows[0];
  if (!object) throw new Error(`SQLite table ${catalog}.${objectName} was not found.`);

  const tableInfo = await readRows(profile, database, `PRAGMA ${quoteIdentifier(catalog)}.table_info(${quoteIdentifier(objectName)})`, masterKey);
  const columns = sqliteColumnsFromRows(tableInfo);

  const indexRows = await readRows(profile, database, `PRAGMA ${quoteIdentifier(catalog)}.index_list(${quoteIdentifier(objectName)})`, masterKey);
  const indexSourceRows = await readRows(
    profile,
    database,
    `SELECT name, sql FROM ${quoteIdentifier(catalog)}.sqlite_master WHERE type = 'index' AND tbl_name = ${sqlLiteral(objectName)}`,
    masterKey,
  );
  const indexSources = new Map(indexSourceRows.map(row => [rowString(row, 'name'), rowString(row, 'sql')]));
  const indexes: DatabaseDesignerIndex[] = [];
  const constraints: DatabaseDesignerConstraint[] = [];
  const primaryKeyColumns = tableInfo
    .filter(row => rowNumber(row, 'pk') > 0)
    .sort((left, right) => rowNumber(left, 'pk') - rowNumber(right, 'pk'))
    .map(row => rowString(row, 'name'))
    .filter(Boolean);
  if (primaryKeyColumns.length > 0) constraints.push({ kind: 'primaryKey', columns: primaryKeyColumns });
  constraints.push(...parseSqliteCheckConstraints(rowString(object, 'sql')));
  for (const row of indexRows) {
    const name = rowString(row, 'name');
    if (!name) continue;
    const indexInfo = await readRows(profile, database, `PRAGMA ${quoteIdentifier(catalog)}.index_info(${quoteIdentifier(name)})`, masterKey);
    const indexColumns = indexInfo.map(info => ({ expression: rowString(info, 'name') })).filter(column => column.expression.length > 0);
    const unique = rowBoolean(row, 'unique');
    const sourceDdl = indexSources.get(name);
    indexes.push({ kind: 'relational', name, columns: indexColumns, unique, ...(sourceDdl ? { sourceDdl } : {}) });
    const origin = rowString(row, 'origin').toLowerCase();
    if (origin === 'pk' && !constraints.some(constraint => constraint.kind === 'primaryKey')) {
      constraints.push({ kind: 'primaryKey', name, columns: indexColumns.map(column => column.expression) });
    }
    if (origin === 'u') constraints.push({ kind: 'unique', name, columns: indexColumns.map(column => column.expression) });
  }

  const foreignKeyState = await readRows(profile, database, 'PRAGMA foreign_keys', masterKey);
  const foreignKeysEnabled = rowBoolean(foreignKeyState[0] ?? {}, 'foreign_keys');
  const foreignKeyRows = await readRows(profile, database, `PRAGMA ${quoteIdentifier(catalog)}.foreign_key_list(${quoteIdentifier(objectName)})`, masterKey);
  const groupedForeignKeys = new Map<number, Row[]>();
  for (const row of foreignKeyRows) {
    const id = rowNumber(row, 'id');
    const group = groupedForeignKeys.get(id) ?? [];
    group.push(row);
    groupedForeignKeys.set(id, group);
  }
  for (const rows of groupedForeignKeys.values()) {
    const first = rows[0];
    if (!first) continue;
    constraints.push({
      kind: 'foreignKey',
      name: `fk_${rowNumber(first, 'id')}`,
      columns: rows.map(row => rowString(row, 'from')).filter(Boolean),
      referencedSchema: catalog,
      referencedTable: rowString(first, 'table'),
      referencedColumns: rows.map(row => rowString(row, 'to')).filter(Boolean),
      onDelete: rowString(first, 'on_delete'),
      onUpdate: rowString(first, 'on_update'),
      match: rowString(first, 'match'),
      enforced: foreignKeysEnabled,
    });
  }

  const triggerRows = await readRows(
    profile,
    database,
    `SELECT name, sql FROM ${quoteIdentifier(catalog)}.sqlite_master WHERE type = 'trigger' AND tbl_name = ${sqlLiteral(objectName)} ORDER BY name`,
    masterKey,
  );
  const triggers = triggerRows.map(row => parseSqliteTrigger(rowString(row, 'name'), rowString(row, 'sql'))).filter(trigger => trigger.name.length > 0);
  const definition = {
    kind: 'table' as const,
    columns,
    constraints,
    indexes,
    partitions: [],
    triggers,
    options: {},
  };
  const sourceDdl = rowString(object, 'sql') || undefined;
  const target: DatabaseDesignerTarget = {
    connectionId: profile.id,
    connectionName: profile.name,
    database,
    schema: catalog,
    objectName,
    objectType: 'TABLE',
  };
  const snapshotValue = { target: fingerprintTarget(target), objectType: 'TABLE', sourceDdl, definition };
  const snapshot: DatabaseObjectSnapshot = {
    target,
    objectType: 'TABLE',
    fingerprint: fingerprint(snapshotValue),
    loadedAt: new Date().toISOString(),
    ...(sourceDdl ? { sourceDdl } : {}),
    definition,
  };
  return { target, snapshot };
}

async function loadDuckDbViewSnapshot(
  profile: StoredConnection,
  request: DesignerSnapshotRequest,
  masterKey: string,
): Promise<DesignerSnapshotResponse> {
  const database = normalizeDuckDbCatalog(request.database?.trim() || profile.database);
  const schema = request.schema?.trim() || 'main';
  const objectName = required(request.objectName, 'objectName');
  const literalDatabase = sqlLiteral(database);
  const literalSchema = sqlLiteral(schema);
  const literalObject = sqlLiteral(objectName);
  const viewRows = await readRows(
    profile,
    database,
    `SELECT view_name, sql
       FROM duckdb_views()
      WHERE database_name = ${literalDatabase} AND schema_name = ${literalSchema} AND view_name = ${literalObject}`,
    masterKey,
  );
  const view = viewRows[0];
  if (!view) throw new Error(`DuckDB view ${schema}.${objectName} was not found.`);
  const columnRows = await readRows(
    profile,
    database,
    `SELECT column_name, data_type, ordinal_position, is_nullable, column_default, is_identity, generation_expression
       FROM information_schema.columns
      WHERE table_catalog = ${literalDatabase} AND table_schema = ${literalSchema} AND table_name = ${literalObject}
      ORDER BY ordinal_position`,
    masterKey,
  );
  const columns = columnRows.map(row => ({
    name: rowString(row, 'column_name'),
    dataType: rowString(row, 'data_type', 'UNKNOWN'),
    ordinal: rowNumber(row, 'ordinal_position'),
    nullable: rowString(row, 'is_nullable', 'YES').toUpperCase() !== 'NO',
  })).filter(column => column.name.length > 0);
  const sourceDdl = rowString(view, 'sql') || undefined;
  const definition = {
    kind: 'view' as const,
    query: viewQueryFromSource(sourceDdl ?? ''),
    columns,
    triggers: [],
    options: {},
  };
  const target: DatabaseDesignerTarget = {
    connectionId: profile.id,
    connectionName: profile.name,
    database,
    schema,
    objectName,
    objectType: 'VIEW',
  };
  const snapshotValue = { target: fingerprintTarget(target), objectType: 'VIEW', sourceDdl, definition };
  const snapshot: DatabaseObjectSnapshot = {
    target,
    objectType: 'VIEW',
    fingerprint: fingerprint(snapshotValue),
    loadedAt: new Date().toISOString(),
    ...(sourceDdl ? { sourceDdl } : {}),
    definition,
  };
  return { target, snapshot };
}

async function loadDuckDbSnapshot(
  profile: StoredConnection,
  request: DesignerSnapshotRequest,
  masterKey: string,
): Promise<DesignerSnapshotResponse> {
  const database = normalizeDuckDbCatalog(request.database?.trim() || profile.database);
  const schema = request.schema?.trim() || 'main';
  const objectName = required(request.objectName, 'objectName');
  const literalDatabase = sqlLiteral(database);
  const literalSchema = sqlLiteral(schema);
  const literalObject = sqlLiteral(objectName);
  const tableRows = await readRows(
    profile,
    database,
    `SELECT table_name, sql FROM duckdb_tables() WHERE database_name = ${literalDatabase} AND schema_name = ${literalSchema} AND table_name = ${literalObject}`,
    masterKey,
  );
  const table = tableRows[0];
  if (!table) throw new Error(`DuckDB table ${schema}.${objectName} was not found.`);

  const columnRows = await readRows(
    profile,
    database,
    `SELECT column_name, data_type, ordinal_position, is_nullable, column_default, is_identity, generation_expression
       FROM information_schema.columns
      WHERE table_catalog = ${literalDatabase} AND table_schema = ${literalSchema} AND table_name = ${literalObject}
      ORDER BY ordinal_position`,
    masterKey,
  );
  const columns = columnRows.map(row => ({
    name: rowString(row, 'column_name'),
    dataType: rowString(row, 'data_type', 'UNKNOWN'),
    ordinal: rowNumber(row, 'ordinal_position'),
    nullable: rowString(row, 'is_nullable', 'YES').toUpperCase() !== 'NO',
    ...(Object.prototype.hasOwnProperty.call(row, 'column_default')
      ? { defaultExpression: row.column_default as string | null }
      : {}),
    ...(rowBoolean(row, 'is_identity') ? { identity: true } : {}),
    ...(rowString(row, 'generation_expression')
      ? { generatedExpression: rowString(row, 'generation_expression') }
      : {}),
  })).filter(column => column.name.length > 0);

  const constraintRows = await readRows(
    profile,
    database,
    `SELECT constraint_type, constraint_name, expression, constraint_text, constraint_column_names, referenced_table, referenced_column_names
       FROM duckdb_constraints()
      WHERE database_name = ${literalDatabase} AND schema_name = ${literalSchema} AND table_name = ${literalObject}
      ORDER BY constraint_index`,
    masterKey,
  );
  const constraints: DatabaseDesignerConstraint[] = [];
  for (const row of constraintRows) {
    const kind = rowString(row, 'constraint_type').toUpperCase();
    const name = rowString(row, 'constraint_name') || undefined;
    const constraintColumns = rowStringArray(row, 'constraint_column_names');
    if (kind === 'PRIMARY KEY' || kind === 'UNIQUE') {
      constraints.push({
        kind: kind === 'PRIMARY KEY' ? 'primaryKey' : 'unique',
        ...(name ? { name } : {}),
        columns: constraintColumns,
        enforced: true,
      });
    } else if (kind === 'CHECK') {
      const expression = rowString(row, 'expression') || rowString(row, 'constraint_text');
      if (expression) constraints.push({ kind: 'check', ...(name ? { name } : {}), expression, enforced: true });
    } else if (kind === 'FOREIGN KEY') {
      const referencedTable = rowString(row, 'referenced_table');
      if (referencedTable) {
        constraints.push({
          kind: 'foreignKey',
          ...(name ? { name } : {}),
          columns: constraintColumns,
          referencedSchema: schema,
          referencedTable,
          referencedColumns: rowStringArray(row, 'referenced_column_names'),
          enforced: true,
        });
      }
    }
  }

  const indexRows = await readRows(
    profile,
    database,
    `SELECT index_name, is_unique, expressions, sql
       FROM duckdb_indexes()
      WHERE database_name = ${literalDatabase} AND schema_name = ${literalSchema} AND table_name = ${literalObject}
      ORDER BY index_name`,
    masterKey,
  );
  const indexes: DatabaseDesignerIndex[] = indexRows.map(row => {
    const name = rowString(row, 'index_name');
    const sourceDdl = rowString(row, 'sql');
    return {
      kind: 'relational' as const,
      name,
      columns: rowStringArray(row, 'expressions').map(expression => ({ expression })),
      unique: rowBoolean(row, 'is_unique'),
      ...(sourceDdl ? { sourceDdl } : {}),
    };
  }).filter(index => index.name.length > 0);

  const definition = {
    kind: 'table' as const,
    columns,
    constraints,
    indexes,
    partitions: [],
    triggers: [],
    options: {},
  };
  const sourceDdl = rowString(table, 'sql') || undefined;
  const target: DatabaseDesignerTarget = {
    connectionId: profile.id,
    connectionName: profile.name,
    database,
    schema,
    objectName,
    objectType: 'TABLE',
  };
  const snapshotValue = { target: fingerprintTarget(target), objectType: 'TABLE', sourceDdl, definition };
  const snapshot: DatabaseObjectSnapshot = {
    target,
    objectType: 'TABLE',
    fingerprint: fingerprint(snapshotValue),
    loadedAt: new Date().toISOString(),
    ...(sourceDdl ? { sourceDdl } : {}),
    definition,
  };
  return { target, snapshot };
}

export async function getDesignerSnapshotResponse(
  profile: StoredConnection,
  request: DesignerSnapshotRequest,
  masterKey: string,
): Promise<DesignerSnapshotResponse> {
  const requestedObjectType = request.objectType?.trim();
  if (requestedObjectType && !['TABLE', 'VIEW'].includes(requestedObjectType.toUpperCase())) {
    throw new DesignerSnapshotUnavailableError('The current provider snapshot adapter supports TABLE and VIEW targets only.');
  }
  if (profile.dbType === 'sqlite' && requestedObjectType?.toUpperCase() === 'VIEW') return loadSqliteViewSnapshot(profile, request, masterKey);
  if (profile.dbType === 'sqlite') return loadSqliteSnapshot(profile, request, masterKey);
  if (profile.dbType === 'duckdb' && requestedObjectType?.toUpperCase() === 'VIEW') return loadDuckDbViewSnapshot(profile, request, masterKey);
  if (profile.dbType === 'duckdb') return loadDuckDbSnapshot(profile, request, masterKey);
  if (profile.dbType !== 'sqlite' && profile.dbType !== 'duckdb') {
    throw new DesignerSnapshotUnavailableError(`Provider-backed designer snapshots are not registered for ${profile.dbType}.`);
  }
  throw new DesignerSnapshotUnavailableError('Provider-backed designer snapshots are unavailable for this target.');
}
