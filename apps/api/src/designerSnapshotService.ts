import { createHash } from 'node:crypto';
import type {
  DatabaseDesignerConstraint,
  DatabaseDesignerIndex,
  DatabaseDesignerTarget,
  DatabaseObjectSnapshot,
  DesignerSnapshotRequest,
  DesignerSnapshotResponse,
  QueryColumn,
} from '@justybase/contracts';
import {
  duckDbColumnsFromRows,
  parseDuckDbConstraints,
  parseDuckDbIndexes,
  parseSqliteCheckConstraints,
  parseSqliteTrigger,
  rowBoolean,
  rowNumber,
  rowString,
  sqliteColumnsFromRows,
  viewQueryFromSource,
  type CatalogRow,
} from '@justybase/designer-core';
import type { ApiDatabaseRuntimeRegistry } from './databaseRuntime/contracts';
import type { StoredConnection } from './store';

export class DesignerSnapshotUnavailableError extends Error {
  public readonly code = 'DESIGNER_SNAPSHOT_UNAVAILABLE';

  public constructor(message: string) {
    super(message);
    this.name = 'DesignerSnapshotUnavailableError';
  }
}

type Row = CatalogRow;

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

async function readRows(
  profile: StoredConnection,
  database: string,
  sql: string,
  runtimes: ApiDatabaseRuntimeRegistry,
): Promise<Row[]> {
  let columns: QueryColumn[] = [];
  const values: unknown[][] = [];
  await runtimes.execute(profile, sql, {
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
  runtimes: ApiDatabaseRuntimeRegistry,
): Promise<DesignerSnapshotResponse> {
  const database = request.database?.trim() || 'main';
  const schema = request.schema?.trim() || database;
  const objectName = required(request.objectName, 'objectName');
  const objectRows = await readRows(
    profile,
    database,
    `SELECT name, type, sql FROM ${quoteIdentifier(schema)}.sqlite_master WHERE name = ${sqlLiteral(objectName)} AND type = 'view'`,
    runtimes,
  );
  const object = objectRows[0];
  if (!object) throw new Error(`SQLite view ${schema}.${objectName} was not found.`);

  const tableInfo = await readRows(profile, database, `PRAGMA ${quoteIdentifier(schema)}.table_info(${quoteIdentifier(objectName)})`, runtimes);
  const triggerRows = await readRows(
    profile,
    database,
    `SELECT name, sql FROM ${quoteIdentifier(schema)}.sqlite_master WHERE type = 'trigger' AND tbl_name = ${sqlLiteral(objectName)} ORDER BY name`,
    runtimes,
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
  runtimes: ApiDatabaseRuntimeRegistry,
): Promise<DesignerSnapshotResponse> {
  const database = request.database?.trim() || 'main';
  const schema = request.schema?.trim() || database;
  const objectName = required(request.objectName, 'objectName');
  const catalog = schema;
  const objectRows = await readRows(
    profile,
    database,
    `SELECT name, type, sql FROM ${quoteIdentifier(catalog)}.sqlite_master WHERE name = ${sqlLiteral(objectName)} AND type = 'table'`,
    runtimes,
  );
  const object = objectRows[0];
  if (!object) throw new Error(`SQLite table ${catalog}.${objectName} was not found.`);

  const tableInfo = await readRows(profile, database, `PRAGMA ${quoteIdentifier(catalog)}.table_info(${quoteIdentifier(objectName)})`, runtimes);
  const columns = sqliteColumnsFromRows(tableInfo);

  const indexRows = await readRows(profile, database, `PRAGMA ${quoteIdentifier(catalog)}.index_list(${quoteIdentifier(objectName)})`, runtimes);
  const indexSourceRows = await readRows(
    profile,
    database,
    `SELECT name, sql FROM ${quoteIdentifier(catalog)}.sqlite_master WHERE type = 'index' AND tbl_name = ${sqlLiteral(objectName)}`,
    runtimes,
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
    const indexInfo = await readRows(profile, database, `PRAGMA ${quoteIdentifier(catalog)}.index_info(${quoteIdentifier(name)})`, runtimes);
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

  const foreignKeyState = await readRows(profile, database, 'PRAGMA foreign_keys', runtimes);
  const foreignKeysEnabled = rowBoolean(foreignKeyState[0] ?? {}, 'foreign_keys');
  const foreignKeyRows = await readRows(profile, database, `PRAGMA ${quoteIdentifier(catalog)}.foreign_key_list(${quoteIdentifier(objectName)})`, runtimes);
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
    runtimes,
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
  runtimes: ApiDatabaseRuntimeRegistry,
): Promise<DesignerSnapshotResponse> {
  const database = runtimes.normalizeDatabase(profile, request.database?.trim() || profile.database);
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
    runtimes,
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
    runtimes,
  );
  const columns = duckDbColumnsFromRows(columnRows, false);
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
  runtimes: ApiDatabaseRuntimeRegistry,
): Promise<DesignerSnapshotResponse> {
  const database = runtimes.normalizeDatabase(profile, request.database?.trim() || profile.database);
  const schema = request.schema?.trim() || 'main';
  const objectName = required(request.objectName, 'objectName');
  const literalDatabase = sqlLiteral(database);
  const literalSchema = sqlLiteral(schema);
  const literalObject = sqlLiteral(objectName);
  const tableRows = await readRows(
    profile,
    database,
    `SELECT table_name, sql FROM duckdb_tables() WHERE database_name = ${literalDatabase} AND schema_name = ${literalSchema} AND table_name = ${literalObject}`,
    runtimes,
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
    runtimes,
  );
  const columns = duckDbColumnsFromRows(columnRows);

  const constraintRows = await readRows(
    profile,
    database,
    `SELECT constraint_type, constraint_name, expression, constraint_text, constraint_column_names, referenced_table, referenced_column_names
       FROM duckdb_constraints()
      WHERE database_name = ${literalDatabase} AND schema_name = ${literalSchema} AND table_name = ${literalObject}
      ORDER BY constraint_index`,
    runtimes,
  );
  const constraints = parseDuckDbConstraints(constraintRows, schema);

  const indexRows = await readRows(
    profile,
    database,
    `SELECT index_name, is_unique, expressions, sql
       FROM duckdb_indexes()
      WHERE database_name = ${literalDatabase} AND schema_name = ${literalSchema} AND table_name = ${literalObject}
      ORDER BY index_name`,
    runtimes,
  );
  const indexes = parseDuckDbIndexes(indexRows);

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
  runtimes: ApiDatabaseRuntimeRegistry,
): Promise<DesignerSnapshotResponse> {
  const requestedObjectType = request.objectType?.trim();
  if (requestedObjectType && !['TABLE', 'VIEW'].includes(requestedObjectType.toUpperCase())) {
    throw new DesignerSnapshotUnavailableError('The current provider snapshot adapter supports TABLE and VIEW targets only.');
  }
  if (profile.dbType === 'sqlite' && requestedObjectType?.toUpperCase() === 'VIEW') return loadSqliteViewSnapshot(profile, request, runtimes);
  if (profile.dbType === 'sqlite') return loadSqliteSnapshot(profile, request, runtimes);
  if (profile.dbType === 'duckdb' && requestedObjectType?.toUpperCase() === 'VIEW') return loadDuckDbViewSnapshot(profile, request, runtimes);
  if (profile.dbType === 'duckdb') return loadDuckDbSnapshot(profile, request, runtimes);
  if (profile.dbType !== 'sqlite' && profile.dbType !== 'duckdb') {
    throw new DesignerSnapshotUnavailableError(`Provider-backed designer snapshots are not registered for ${profile.dbType}.`);
  }
  throw new DesignerSnapshotUnavailableError('Provider-backed designer snapshots are unavailable for this target.');
}
