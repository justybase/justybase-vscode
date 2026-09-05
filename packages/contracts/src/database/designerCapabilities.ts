import type { DatabaseKind } from './index';

/**
 * A construct can be available in the database while still being unavailable
 * in the current runtime (for example, when the companion extension is not
 * installed) or blocked by the current connection.
 */
export type DesignerSupportLevel =
  | 'supported'
  | 'limited'
  | 'alternative'
  | 'unsupported'
  | 'runtime-unavailable'
  | 'privilege-blocked';

export type DatabaseDesignerCapabilityKey =
  | 'table'
  | 'alterTable'
  | 'indexes'
  | 'partitions'
  | 'foreignKeys'
  | 'checks'
  | 'triggers'
  | 'views'
  | 'materializedViews'
  | 'procedures'
  | 'sequences'
  | 'usersRoles';

export const DESIGNER_CAPABILITY_KEYS: readonly DatabaseDesignerCapabilityKey[] = [
  'table',
  'alterTable',
  'indexes',
  'partitions',
  'foreignKeys',
  'checks',
  'triggers',
  'views',
  'materializedViews',
  'procedures',
  'sequences',
  'usersRoles',
];

export type DesignerOperation =
  | 'read'
  | 'create'
  | 'alter'
  | 'drop'
  | 'rename'
  | 'attach'
  | 'detach'
  | 'split'
  | 'merge'
  | 'rebuild'
  | 'replace';

export const DESIGNER_OPERATIONS: readonly DesignerOperation[] = [
  'read',
  'create',
  'alter',
  'drop',
  'rename',
  'attach',
  'detach',
  'split',
  'merge',
  'rebuild',
  'replace',
];

export type DesignerCapabilityReasonCode =
  | 'supported'
  | 'limited'
  | 'alternative'
  | 'unsupported'
  | 'runtime'
  | 'version'
  | 'engine'
  | 'privilege'
  | 'read-only'
  | 'object-kind';

export interface DatabaseDesignerRequirement {
  minServerVersion?: string;
  engines?: readonly string[];
  objectKinds?: readonly string[];
  privileges?: readonly string[];
}

export type DesignerTriggerTiming = 'BEFORE' | 'AFTER' | 'INSTEAD OF';
export type DesignerTriggerEvent = 'INSERT' | 'UPDATE' | 'DELETE';
export type DesignerTriggerLevel = 'ROW' | 'STATEMENT';
export type DesignerTriggerBodyStyle =
  | 'sql-block'
  | 'postgresql-function'
  | 'oracle-block'
  | 'mssql-batch'
  | 'db2-atomic';

export type DesignerViewReplaceStyle =
  | 'create'
  | 'create-or-replace'
  | 'create-or-alter'
  | 'drop-and-create';

export interface DatabaseDesignerTriggerCapability {
  /** Syntax contract for the body editor/DDL builder, not a UI preference. */
  bodyStyle: DesignerTriggerBodyStyle;
  timings: readonly DesignerTriggerTiming[];
  events: readonly DesignerTriggerEvent[];
  levels: readonly DesignerTriggerLevel[];
  supportsWhen?: boolean;
  supportsUpdateColumns?: boolean;
  levelsByTiming?: Partial<Record<DesignerTriggerTiming, readonly DesignerTriggerLevel[]>>;
  timingsByObjectKind?: Readonly<Record<string, readonly DesignerTriggerTiming[]>>;
  /** Object kinds allowed for an INSTEAD OF trigger, when restricted. */
  insteadOfObjectKinds?: readonly string[];
}

export interface DatabaseDesignerViewCapability {
  /** How an existing view is replaced by the dialect's DDL surface. */
  replaceStyle: DesignerViewReplaceStyle;
}

export type DesignerRoutineBodyStyle = 'netezza-nzplsql';

export interface DatabaseDesignerRoutineCapability {
  bodyStyle: DesignerRoutineBodyStyle;
}

export interface DatabaseDesignerCapability {
  level: DesignerSupportLevel;
  reasonCode: DesignerCapabilityReasonCode;
  operations: readonly DesignerOperation[];
  /** Whether the database guarantees enforcement for the construct. */
  enforced?: boolean;
  /** Trigger-specific syntax surface, when the construct is a trigger. */
  trigger?: DatabaseDesignerTriggerCapability;
  /** View replacement syntax, when the construct is a view. */
  view?: DatabaseDesignerViewCapability;
  /** Routine body syntax, when the construct is a procedure/function. */
  routine?: DatabaseDesignerRoutineCapability;
  label?: string;
  reason?: string;
  alternative?: DatabaseDesignerCapabilityKey;
  nativeAlternative?: DesignerNativeFeature;
  requirements?: DatabaseDesignerRequirement;
}

/** Raised by a DDL builder when a caller bypasses capability-driven UI gating. */
export class UnsupportedDesignerOperationError extends Error {
  public readonly code = 'DESIGNER_OPERATION_UNSUPPORTED';

  public constructor(
    public readonly capabilityKey: DatabaseDesignerCapabilityKey,
    public readonly operation: DesignerOperation,
    reason?: string,
  ) {
    super(reason ?? `Designer operation '${operation}' is not supported for '${capabilityKey}'.`);
    this.name = 'UnsupportedDesignerOperationError';
  }
}

export type DesignerNativeFeature =
  | 'netezza-distribution'
  | 'netezza-organization'
  | 'clickhouse-merge-tree'
  | 'clickhouse-skipping-index'
  | 'vertica-projection'
  | 'snowflake-clustering-key'
  | 'snowflake-streams-tasks'
  | 'duckdb-macros'
  | 'access-data-macros';

export interface DatabaseDesignerCapabilities {
  /** Increment when the serialized manifest shape changes. */
  manifestVersion: 1;
  kind: DatabaseKind;
  constructs: Readonly<Record<DatabaseDesignerCapabilityKey, DatabaseDesignerCapability>>;
  nativeFeatures: readonly DesignerNativeFeature[];
}

export interface DatabaseDesignerTarget {
  connectionId?: string;
  connectionName?: string;
  database?: string;
  schema?: string;
  objectName?: string;
  objectType?: string;
}

export interface DatabaseDesignerRuntimeContext {
  databaseKind: DatabaseKind;
  serverVersion?: string;
  engine?: string;
  objectKind?: string;
  readOnly?: boolean;
  runtimeAvailable?: boolean;
  privileges?: readonly string[];
}

export interface DatabaseDesignerColumn {
  name: string;
  dataType: string;
  ordinal: number;
  nullable: boolean;
  defaultExpression?: string | null;
  comment?: string | null;
  identity?: boolean;
  generatedExpression?: string | null;
}

export type DatabaseDesignerConstraint =
  | {
      kind: 'primaryKey' | 'unique';
      name?: string;
      columns: readonly string[];
      enforced?: boolean;
      trusted?: boolean;
    }
  | {
      kind: 'check';
      name?: string;
      expression: string;
      enforced?: boolean;
      trusted?: boolean;
      notValid?: boolean;
    }
  | {
      kind: 'foreignKey';
      name?: string;
      columns: readonly string[];
      referencedSchema?: string;
      referencedTable: string;
      referencedColumns: readonly string[];
      match?: string;
      onDelete?: string;
      onUpdate?: string;
      deferrable?: boolean;
      initiallyDeferred?: boolean;
      enforced?: boolean;
      trusted?: boolean;
      notValid?: boolean;
    };

export interface DatabaseDesignerRelationalIndex {
  kind: 'relational';
  name: string;
  /** Original catalog DDL, when the provider can return it for safe rebuilds. */
  sourceDdl?: string;
  columns: readonly {
    expression: string;
    order?: 'ASC' | 'DESC';
    nulls?: 'FIRST' | 'LAST';
  }[];
  unique?: boolean;
  method?: string;
  includeColumns?: readonly string[];
  predicate?: string;
  tablespace?: string;
  clustered?: boolean;
  visible?: boolean;
}

export type DatabaseDesignerIndex =
  | DatabaseDesignerRelationalIndex
  | {
      kind: 'netezza-zone-map';
      columns: readonly string[];
      maxRowsPerZone?: number;
    }
  | {
      kind: 'clickhouse-skipping';
      name: string;
      expression: string;
      indexType: string;
      granularity: number;
    }
  | {
      kind: 'vertica-projection';
      name: string;
      projectionType?: string;
      columns: readonly string[];
      orderBy?: readonly string[];
      segmentation?: string;
      kSafety?: number;
    }
  | {
      kind: 'snowflake-clustering';
      expressions: readonly string[];
    };

export type DatabaseDesignerPartition =
  | {
      kind: 'relational';
      strategy: 'RANGE' | 'LIST' | 'HASH' | 'KEY' | 'INTERVAL';
      keyExpressions: readonly string[];
      partitions: readonly {
        name: string;
        bound: string;
        tablespace?: string;
      }[];
    }
  | {
      kind: 'clickhouse-expression' | 'vertica-expression';
      expression: string;
      segmentation?: string;
    }
  | {
      kind: 'mssql-function-scheme';
      functionName: string;
      schemeName: string;
      inputType: string;
      boundarySide: 'LEFT' | 'RIGHT';
      boundaries: readonly string[];
      filegroups: readonly string[];
    }
  | {
      kind: 'netezza-distribution';
      method: 'RANDOM' | 'HASH';
      columns: readonly string[];
    };

export interface DatabaseDesignerTrigger {
  name: string;
  timing: 'BEFORE' | 'AFTER' | 'INSTEAD OF' | 'UNSPECIFIED';
  events: readonly ('INSERT' | 'UPDATE' | 'DELETE')[];
  level: 'ROW' | 'STATEMENT' | 'UNSPECIFIED';
  updateColumns?: readonly string[];
  whenExpression?: string;
  body: string;
}

export type DatabaseDesignerNativeDefinition =
  | {
      kind: 'netezza';
      distribution?: DatabaseDesignerPartition;
      organizationColumns?: readonly string[];
    }
  | {
      kind: 'clickhouse-merge-tree';
      engine: string;
      partitionBy?: string;
      primaryKey?: string;
      orderBy: string;
      sampleBy?: string;
      ttl?: string;
      settings?: string;
    }
  | {
      kind: 'generic';
      clauses: Readonly<Record<string, string>>;
    };

export interface DatabaseTableDesignerDefinition {
  kind: 'table';
  tableType?: string;
  columns: readonly DatabaseDesignerColumn[];
  constraints: readonly DatabaseDesignerConstraint[];
  indexes: readonly DatabaseDesignerIndex[];
  partitions: readonly DatabaseDesignerPartition[];
  triggers: readonly DatabaseDesignerTrigger[];
  native?: DatabaseDesignerNativeDefinition;
  options: Readonly<Record<string, string | number | boolean | null>>;
}

export interface DatabaseViewDesignerDefinition {
  kind: 'view';
  query: string;
  columns: readonly DatabaseDesignerColumn[];
  triggers: readonly DatabaseDesignerTrigger[];
  materialized?: boolean;
  options: Readonly<Record<string, string | number | boolean | null>>;
}

export type DatabaseDesignerDefinition = DatabaseTableDesignerDefinition | DatabaseViewDesignerDefinition;

export interface DatabaseObjectSnapshot {
  target: DatabaseDesignerTarget;
  objectType: string;
  fingerprint: string;
  loadedAt: string;
  sourceDdl?: string;
  definition: DatabaseDesignerDefinition;
}

export type DatabaseDesignerRisk =
  | 'safe'
  | 'review'
  | 'destructive'
  | 'data-movement'
  | 'non-transactional';

export interface DatabaseSchemaChangeStatement {
  index: number;
  sql: string;
  operation: DesignerOperation;
  risk: DatabaseDesignerRisk;
  transactional: boolean;
  warnings: readonly string[];
  rollbackSql?: string;
}

export interface DatabaseSchemaChangePlan {
  planVersion: 1;
  planId: string;
  target: DatabaseDesignerTarget;
  baseFingerprint: string;
  statements: readonly DatabaseSchemaChangeStatement[];
  warnings: readonly string[];
  requiresExplicitConfirmation: boolean;
  canRunInTransaction: boolean;
  postconditions: readonly string[];
}

export interface DatabaseDesignerDiagnostic {
  code: string;
  severity: 'error' | 'warning' | 'information';
  message: string;
  field?: string;
}

export interface DatabaseDesignerProvider {
  getCapabilities(
    target: DatabaseDesignerTarget,
    context?: DatabaseDesignerRuntimeContext,
  ): Promise<DatabaseDesignerCapabilities>;
  loadSnapshot(
    target: DatabaseDesignerTarget,
    context?: DatabaseDesignerRuntimeContext,
  ): Promise<DatabaseObjectSnapshot>;
  validateDesign(
    snapshot: DatabaseObjectSnapshot,
    design: DatabaseDesignerDefinition,
    context?: DatabaseDesignerRuntimeContext,
  ): Promise<readonly DatabaseDesignerDiagnostic[]>;
  buildChangePlan(
    snapshot: DatabaseObjectSnapshot,
    design: DatabaseDesignerDefinition,
    context?: DatabaseDesignerRuntimeContext,
  ): Promise<DatabaseSchemaChangePlan>;
}

const ALL_READ_OPERATIONS: readonly DesignerOperation[] = ['read'];
const TABLE_OPERATIONS: readonly DesignerOperation[] = ['read', 'create'];
const ALTER_OPERATIONS: readonly DesignerOperation[] = ['read', 'alter', 'rename', 'drop'];
const FULL_OPERATIONS: readonly DesignerOperation[] = [...ALTER_OPERATIONS, 'create'];
const PARTITION_OPERATIONS: readonly DesignerOperation[] = [
  'read',
  'create',
  'alter',
  'drop',
  'attach',
  'detach',
  'split',
  'merge',
];

const ALL_TRIGGER_EVENTS: readonly DesignerTriggerEvent[] = ['INSERT', 'UPDATE', 'DELETE'];
const DB2_TRIGGER: DatabaseDesignerTriggerCapability = {
  bodyStyle: 'db2-atomic',
  timings: ['BEFORE', 'AFTER', 'INSTEAD OF'],
  events: ALL_TRIGGER_EVENTS,
  levels: ['ROW', 'STATEMENT'],
  supportsWhen: true,
  supportsUpdateColumns: true,
};
const MYSQL_TRIGGER: DatabaseDesignerTriggerCapability = {
  bodyStyle: 'sql-block',
  timings: ['BEFORE', 'AFTER'],
  events: ALL_TRIGGER_EVENTS,
  levels: ['ROW'],
  timingsByObjectKind: { TABLE: ['BEFORE', 'AFTER'] },
};
const POSTGRESQL_TRIGGER: DatabaseDesignerTriggerCapability = {
  bodyStyle: 'postgresql-function',
  timings: ['BEFORE', 'AFTER', 'INSTEAD OF'],
  events: ALL_TRIGGER_EVENTS,
  levels: ['ROW', 'STATEMENT'],
  supportsWhen: true,
  supportsUpdateColumns: true,
  levelsByTiming: { 'INSTEAD OF': ['ROW'] },
  timingsByObjectKind: { TABLE: ['BEFORE', 'AFTER'], VIEW: ['INSTEAD OF'] },
  insteadOfObjectKinds: ['VIEW'],
};
const ORACLE_TRIGGER: DatabaseDesignerTriggerCapability = {
  bodyStyle: 'oracle-block',
  timings: ['BEFORE', 'AFTER', 'INSTEAD OF'],
  events: ALL_TRIGGER_EVENTS,
  levels: ['ROW', 'STATEMENT'],
  supportsWhen: true,
  supportsUpdateColumns: true,
  levelsByTiming: { 'INSTEAD OF': ['ROW'] },
  timingsByObjectKind: { TABLE: ['BEFORE', 'AFTER'], VIEW: ['INSTEAD OF'] },
  insteadOfObjectKinds: ['VIEW'],
};
const MSSQL_TRIGGER: DatabaseDesignerTriggerCapability = {
  bodyStyle: 'mssql-batch',
  timings: ['AFTER', 'INSTEAD OF'],
  events: ALL_TRIGGER_EVENTS,
  levels: ['STATEMENT'],
  timingsByObjectKind: { TABLE: ['AFTER', 'INSTEAD OF'], VIEW: ['INSTEAD OF'] },
};
const SQLITE_TRIGGER: DatabaseDesignerTriggerCapability = {
  bodyStyle: 'sql-block',
  timings: ['BEFORE', 'AFTER', 'INSTEAD OF'],
  events: ALL_TRIGGER_EVENTS,
  levels: ['ROW'],
  supportsWhen: true,
  supportsUpdateColumns: true,
  levelsByTiming: { 'INSTEAD OF': ['ROW'] },
  timingsByObjectKind: { TABLE: ['BEFORE', 'AFTER'], VIEW: ['INSTEAD OF'] },
  insteadOfObjectKinds: ['VIEW'],
};
const CREATE_OR_REPLACE_VIEW: DatabaseDesignerViewCapability = { replaceStyle: 'create-or-replace' };
const SQLITE_VIEW: DatabaseDesignerViewCapability = { replaceStyle: 'drop-and-create' };
const MSSQL_VIEW: DatabaseDesignerViewCapability = { replaceStyle: 'create-or-alter' };
const CREATE_VIEW: DatabaseDesignerViewCapability = { replaceStyle: 'create' };
const NETEZZA_ROUTINE: DatabaseDesignerRoutineCapability = { bodyStyle: 'netezza-nzplsql' };

function capability(
  level: DesignerSupportLevel,
  reasonCode: DesignerCapabilityReasonCode,
  operations: readonly DesignerOperation[],
  options: Omit<DatabaseDesignerCapability, 'level' | 'reasonCode' | 'operations'> = {},
): DatabaseDesignerCapability {
  return { level, reasonCode, operations, ...options };
}

const supported = (operations: readonly DesignerOperation[] = FULL_OPERATIONS, options: Omit<DatabaseDesignerCapability, 'level' | 'reasonCode' | 'operations'> = {}) =>
  capability('supported', 'supported', operations, options);

const limited = (
  operations: readonly DesignerOperation[],
  reason: string,
  options: Omit<DatabaseDesignerCapability, 'level' | 'reasonCode' | 'operations' | 'reason'> = {},
) => capability('limited', 'limited', operations, { ...options, reason });

const alternative = (
  alternativeKey: DatabaseDesignerCapabilityKey,
  reason: string,
  operations: readonly DesignerOperation[] = ALL_READ_OPERATIONS,
  nativeAlternative?: DesignerNativeFeature,
) => capability('alternative', 'alternative', operations, {
  alternative: alternativeKey,
  reason,
  ...(nativeAlternative ? { nativeAlternative } : {}),
});

const unsupported = (reason: string) => capability('unsupported', 'unsupported', ALL_READ_OPERATIONS, { reason });

function createManifest(
  kind: DatabaseKind,
  constructs: Readonly<Record<DatabaseDesignerCapabilityKey, DatabaseDesignerCapability>>,
  nativeFeatures: readonly DesignerNativeFeature[] = [],
): DatabaseDesignerCapabilities {
  return { manifestVersion: 1, kind, constructs, nativeFeatures };
}

export const DATABASE_DESIGNER_CAPABILITY_MANIFESTS: Readonly<Record<string, DatabaseDesignerCapabilities>> = {
  netezza: createManifest('netezza', {
    table: supported(TABLE_OPERATIONS),
    alterTable: limited(['read', 'alter', 'rename'], 'Only the supported ALTER TABLE subset is available; broader changes use a reviewed CTAS/swap plan.'),
    indexes: alternative('alterTable', 'Netezza has no user indexes; use the native ORGANIZE ON zone-map editor.', ['read', 'create', 'alter'], 'netezza-organization'),
    partitions: alternative('alterTable', 'Netezza has no user-managed partitions; use DISTRIBUTE ON and ORGANIZE ON.', ['read', 'create', 'alter', 'replace'], 'netezza-distribution'),
    foreignKeys: unsupported('Netezza does not provide an enforced foreign-key constraint surface; use PK/UNIQUE declarations and query-time validation.'),
    checks: unsupported('Netezza does not provide the standard CHECK constraint surface.'),
    triggers: unsupported('Netezza does not provide SQL triggers.'),
    views: supported(FULL_OPERATIONS, { view: CREATE_OR_REPLACE_VIEW }),
    materializedViews: supported(FULL_OPERATIONS),
    procedures: supported(FULL_OPERATIONS, { routine: NETEZZA_ROUTINE }),
    sequences: unsupported('Use the dialect-specific identity or generated-value mechanism.'),
    usersRoles: supported(FULL_OPERATIONS),
  }, ['netezza-distribution', 'netezza-organization']),

  db2: createManifest('db2', {
    table: supported(TABLE_OPERATIONS),
    alterTable: limited(['read', 'alter', 'rename', 'create'], 'Most structural changes require a post-change REORG and are exposed only when the provider can report that requirement.'),
    indexes: supported(FULL_OPERATIONS),
    partitions: supported(PARTITION_OPERATIONS),
    foreignKeys: supported(FULL_OPERATIONS),
    checks: supported(FULL_OPERATIONS),
    triggers: supported(FULL_OPERATIONS, { trigger: DB2_TRIGGER }),
    views: supported(FULL_OPERATIONS, { view: CREATE_VIEW }),
    materializedViews: supported(FULL_OPERATIONS),
    procedures: supported(FULL_OPERATIONS),
    sequences: supported(FULL_OPERATIONS),
    usersRoles: supported(FULL_OPERATIONS),
  }),

  mysql: createManifest('mysql', {
    table: supported(TABLE_OPERATIONS),
    alterTable: supported(FULL_OPERATIONS),
    indexes: supported(FULL_OPERATIONS),
    partitions: supported(PARTITION_OPERATIONS),
    foreignKeys: supported(FULL_OPERATIONS, { requirements: { engines: ['InnoDB'], privileges: ['ALTER'] } }),
    checks: limited(FULL_OPERATIONS, 'CHECK enforcement depends on the MySQL server version.', { requirements: { minServerVersion: '8.0.16' } }),
    triggers: supported(FULL_OPERATIONS, { trigger: MYSQL_TRIGGER }),
    views: supported(FULL_OPERATIONS, { view: CREATE_OR_REPLACE_VIEW }),
    materializedViews: unsupported('MySQL has no native materialized view object.'),
    procedures: supported(FULL_OPERATIONS),
    sequences: alternative('table', 'Use AUTO_INCREMENT or an application-managed sequence table; MySQL has no native sequence object.'),
    usersRoles: supported(FULL_OPERATIONS),
  }),

  postgresql: createManifest('postgresql', {
    table: supported(TABLE_OPERATIONS),
    alterTable: supported(FULL_OPERATIONS),
    indexes: supported(FULL_OPERATIONS),
    partitions: supported(PARTITION_OPERATIONS),
    foreignKeys: supported(FULL_OPERATIONS),
    checks: supported(FULL_OPERATIONS),
    triggers: supported(FULL_OPERATIONS, { trigger: POSTGRESQL_TRIGGER }),
    views: supported(FULL_OPERATIONS, { view: CREATE_OR_REPLACE_VIEW }),
    materializedViews: supported(FULL_OPERATIONS),
    procedures: supported(FULL_OPERATIONS),
    sequences: supported(FULL_OPERATIONS),
    usersRoles: supported(FULL_OPERATIONS),
  }),

  oracle: createManifest('oracle', {
    table: supported(TABLE_OPERATIONS),
    alterTable: supported(FULL_OPERATIONS),
    indexes: supported(FULL_OPERATIONS),
    partitions: supported(PARTITION_OPERATIONS),
    foreignKeys: supported(FULL_OPERATIONS),
    checks: supported(FULL_OPERATIONS),
    triggers: supported(FULL_OPERATIONS, { trigger: ORACLE_TRIGGER }),
    views: supported(FULL_OPERATIONS, { view: CREATE_OR_REPLACE_VIEW }),
    materializedViews: supported(FULL_OPERATIONS),
    procedures: supported(FULL_OPERATIONS),
    sequences: supported(FULL_OPERATIONS),
    usersRoles: supported(FULL_OPERATIONS),
  }),

  mssql: createManifest('mssql', {
    table: supported(TABLE_OPERATIONS),
    alterTable: supported(FULL_OPERATIONS),
    indexes: supported(FULL_OPERATIONS),
    partitions: supported(PARTITION_OPERATIONS),
    foreignKeys: supported(FULL_OPERATIONS),
    checks: supported(FULL_OPERATIONS),
    triggers: supported(FULL_OPERATIONS, { trigger: MSSQL_TRIGGER }),
    views: supported(FULL_OPERATIONS, { view: MSSQL_VIEW }),
    materializedViews: alternative('views', 'Use indexed views for the SQL Server materialized-view equivalent.'),
    procedures: supported(FULL_OPERATIONS),
    sequences: supported(FULL_OPERATIONS),
    usersRoles: supported(FULL_OPERATIONS),
  }),

  sqlite: createManifest('sqlite', {
    table: supported(TABLE_OPERATIONS),
    alterTable: limited(['read', 'alter', 'rename', 'create', 'replace'], 'SQLite supports only a limited ALTER TABLE surface; unsupported changes require a reviewed table rebuild.'),
    indexes: supported(FULL_OPERATIONS),
    partitions: unsupported('SQLite has no user-managed table partitions.'),
    foreignKeys: limited(['read', 'replace'], 'SQLite declares foreign keys in CREATE TABLE; adding one to an existing table requires a table rebuild.'),
    checks: limited(['read', 'replace'], 'SQLite declares CHECK constraints in CREATE TABLE; adding one to an existing table requires a table rebuild.'),
    triggers: supported(FULL_OPERATIONS, { trigger: SQLITE_TRIGGER }),
    views: supported(FULL_OPERATIONS, { view: SQLITE_VIEW }),
    materializedViews: unsupported('SQLite has no native materialized views.'),
    procedures: unsupported('SQLite has no stored procedures or functions.'),
    sequences: alternative('table', 'Use INTEGER PRIMARY KEY or an application-managed sequence.'),
    usersRoles: unsupported('SQLite has no database users or roles.'),
  }),

  clickhouse: createManifest('clickhouse', {
    table: limited(['read'], 'ClickHouse table definitions require a MergeTree engine and native ORDER BY / PARTITION BY options.'),
    alterTable: limited(['read', 'alter', 'rename', 'create', 'drop'], 'ALTER TABLE is engine-specific and is not a relational table-alter surface.'),
    indexes: alternative('table', 'Use data-skipping indexes and MergeTree physical design instead of B-tree indexes.', ['read', 'create', 'alter', 'drop'], 'clickhouse-skipping-index'),
    partitions: limited(['read', 'create', 'alter', 'drop', 'attach', 'detach', 'rebuild'], 'Partitioning is a MergeTree PARTITION BY expression, not a generic relational partition tree.'),
    foreignKeys: unsupported('ClickHouse does not provide relational foreign-key constraints.'),
    checks: supported(FULL_OPERATIONS),
    triggers: unsupported('ClickHouse does not provide SQL triggers.'),
    views: supported(FULL_OPERATIONS, { view: CREATE_OR_REPLACE_VIEW }),
    materializedViews: supported(FULL_OPERATIONS),
    procedures: unsupported('ClickHouse does not provide stored procedures.'),
    sequences: unsupported('ClickHouse has no standard sequence object.'),
    usersRoles: supported(FULL_OPERATIONS),
  }, ['clickhouse-merge-tree', 'clickhouse-skipping-index']),

  vertica: createManifest('vertica', {
    table: supported(TABLE_OPERATIONS),
    alterTable: supported(FULL_OPERATIONS),
    indexes: alternative('table', 'Vertica uses projections instead of user indexes.', ['read', 'create', 'alter', 'drop'], 'vertica-projection'),
    partitions: limited(PARTITION_OPERATIONS, 'Vertica partitioning is an expression combined with segmentation.'),
    foreignKeys: limited(FULL_OPERATIONS, 'Foreign-key declarations are not enforced by the standard Vertica table model.', { enforced: false }),
    checks: supported(FULL_OPERATIONS),
    triggers: unsupported('Vertica does not provide SQL triggers.'),
    views: supported(FULL_OPERATIONS, { view: CREATE_OR_REPLACE_VIEW }),
    materializedViews: supported(FULL_OPERATIONS),
    procedures: supported(FULL_OPERATIONS),
    sequences: supported(FULL_OPERATIONS),
    usersRoles: supported(FULL_OPERATIONS),
  }, ['vertica-projection']),

  snowflake: createManifest('snowflake', {
    table: supported(TABLE_OPERATIONS),
    alterTable: supported(FULL_OPERATIONS),
    indexes: alternative('table', 'Snowflake uses clustering keys; micro-partitions are managed automatically.', ['read', 'create', 'alter', 'drop'], 'snowflake-clustering-key'),
    partitions: unsupported('Snowflake micro-partitions are managed automatically.'),
    foreignKeys: limited(FULL_OPERATIONS, 'Constraint enforcement depends on whether the target is a standard or hybrid table.', { enforced: false }),
    checks: limited(FULL_OPERATIONS, 'Constraint enforcement depends on the target table kind.'),
    triggers: alternative('views', 'Use Streams and Tasks for change-driven processing.', ALL_READ_OPERATIONS, 'snowflake-streams-tasks'),
    views: supported(FULL_OPERATIONS, { view: CREATE_OR_REPLACE_VIEW }),
    materializedViews: supported(FULL_OPERATIONS),
    procedures: supported(FULL_OPERATIONS),
    sequences: supported(FULL_OPERATIONS),
    usersRoles: supported(FULL_OPERATIONS),
  }, ['snowflake-clustering-key', 'snowflake-streams-tasks']),

  duckdb: createManifest('duckdb', {
    table: supported(TABLE_OPERATIONS),
    alterTable: supported(FULL_OPERATIONS),
    indexes: supported(FULL_OPERATIONS),
    partitions: unsupported('DuckDB has no generic user-managed table partition tree.'),
    foreignKeys: supported(FULL_OPERATIONS),
    checks: supported(FULL_OPERATIONS),
    triggers: unsupported('DuckDB has no SQL trigger surface.'),
    views: supported(FULL_OPERATIONS, { view: CREATE_OR_REPLACE_VIEW }),
    materializedViews: unsupported('DuckDB has no native materialized view object.'),
    procedures: alternative('views', 'Use macros for reusable parameterized SQL.', ALL_READ_OPERATIONS, 'duckdb-macros'),
    sequences: supported(FULL_OPERATIONS),
    usersRoles: unsupported('DuckDB has no server-side users or roles in the embedded model.'),
  }, ['duckdb-macros']),

  access: createManifest('access', {
    table: limited(['read'], 'Access table creation is not available in the generic SQL designer; use the Access file tools.'),
    alterTable: limited(['read', 'alter', 'create'], 'Access schema changes are limited by file locking and the MDB/ACCDB session boundary.'),
    indexes: supported(FULL_OPERATIONS),
    partitions: unsupported('Access has no user-managed table partitions.'),
    foreignKeys: supported(FULL_OPERATIONS),
    checks: limited(FULL_OPERATIONS, 'Use Access validation rules rather than assuming standard CHECK semantics.', { enforced: false }),
    triggers: alternative('table', 'Access uses data macros rather than SQL triggers.', ALL_READ_OPERATIONS, 'access-data-macros'),
    views: supported(FULL_OPERATIONS, { view: CREATE_VIEW }),
    materializedViews: unsupported('Access has no native materialized views.'),
    procedures: unsupported('Access has no portable SQL procedure designer.'),
    sequences: alternative('table', 'Use an AutoNumber column rather than a standalone sequence object.'),
    usersRoles: unsupported('The local Access file boundary has no portable server-side role model.'),
  }, ['access-data-macros']),
};

function unavailableCapability(reason: string): DatabaseDesignerCapability {
  return capability('runtime-unavailable', 'runtime', ALL_READ_OPERATIONS, { reason });
}

function createUnavailableManifest(kind: DatabaseKind): DatabaseDesignerCapabilities {
  const reason = `No designer runtime is registered for database kind "${String(kind)}".`;
  return createManifest(
    kind,
    Object.fromEntries(
      DESIGNER_CAPABILITY_KEYS.map(key => [key, unavailableCapability(reason)]),
    ) as Record<DatabaseDesignerCapabilityKey, DatabaseDesignerCapability>,
  );
}

function canonicalKind(kind?: string | DatabaseKind): string {
  const value = (kind ?? 'netezza').trim().toLowerCase();
  switch (value) {
    case 'postgres':
      return 'postgresql';
    case 'sqlserver':
    case 'sql server':
      return 'mssql';
    case 'sqlite3':
      return 'sqlite';
    case 'file':
    case 'file sql':
      return 'duckdb';
    default:
      return value;
  }
}

export function getDatabaseDesignerCapabilities(kind?: string | DatabaseKind): DatabaseDesignerCapabilities {
  const canonical = canonicalKind(kind);
  const manifest = DATABASE_DESIGNER_CAPABILITY_MANIFESTS[canonical];
  if (manifest) {
    return canonical === 'duckdb' && (kind ?? '').toString().trim().toLowerCase() === 'file'
      ? { ...manifest, kind: 'file' }
      : manifest;
  }
  return createUnavailableManifest((kind ?? canonical) as DatabaseKind);
}

function withoutMutationOperations(
  capabilityValue: DatabaseDesignerCapability,
): DatabaseDesignerCapability {
  const operations = capabilityValue.operations.filter(operation => operation === 'read');
  const hasMutation = capabilityValue.operations.some(operation => operation !== 'read');
  if (hasMutation && operations.length > 0 && capabilityValue.level !== 'unsupported' && capabilityValue.level !== 'runtime-unavailable') {
    return {
      ...capabilityValue,
      level: 'privilege-blocked',
      reasonCode: 'read-only',
      operations,
      reason: capabilityValue.reason
        ? `${capabilityValue.reason} The current connection is read-only.`
        : 'The current connection is read-only.',
    };
  }
  return capabilityValue;
}

function versionParts(value: string): number[] | undefined {
  const match = value.trim().match(/\d+(?:\.\d+)+/);
  if (!match) return undefined;
  return match[0].split('.').map(part => Number(part));
}

function versionAtLeast(actual: string, required: string): boolean {
  const actualParts = versionParts(actual);
  const requiredParts = versionParts(required);
  if (!actualParts || !requiredParts) return true;
  const length = Math.max(actualParts.length, requiredParts.length);
  for (let index = 0; index < length; index += 1) {
    const actualPart = actualParts[index] ?? 0;
    const requiredPart = requiredParts[index] ?? 0;
    if (actualPart !== requiredPart) return actualPart > requiredPart;
  }
  return true;
}

function restrictCapability(
  capabilityValue: DatabaseDesignerCapability,
  level: DesignerSupportLevel,
  reasonCode: DesignerCapabilityReasonCode,
  reason: string,
): DatabaseDesignerCapability {
  return {
    ...capabilityValue,
    level,
    reasonCode,
    operations: ALL_READ_OPERATIONS,
    reason,
  };
}

function resolveCapabilityRequirements(
  capabilityValue: DatabaseDesignerCapability,
  context: DatabaseDesignerRuntimeContext,
): DatabaseDesignerCapability {
  const requirements = capabilityValue.requirements;
  if (!requirements) return capabilityValue;

  if (requirements.minServerVersion && context.serverVersion && !versionAtLeast(context.serverVersion, requirements.minServerVersion)) {
    return restrictCapability(
      capabilityValue,
      'unsupported',
      'version',
      `Requires database server version ${requirements.minServerVersion} or newer (detected ${context.serverVersion}).`,
    );
  }

  if (requirements.engines && context.engine) {
    const engine = context.engine.trim().toLowerCase();
    const supportedEngines = requirements.engines.map(value => value.trim().toLowerCase());
    if (!supportedEngines.includes(engine)) {
      return restrictCapability(
        capabilityValue,
        'unsupported',
        'engine',
        `This construct requires one of these table engines: ${requirements.engines.join(', ')} (detected ${context.engine}).`,
      );
    }
  }

  if (requirements.objectKinds && context.objectKind) {
    const objectKind = context.objectKind.trim().toUpperCase();
    const supportedKinds = requirements.objectKinds.map(value => value.trim().toUpperCase());
    if (!supportedKinds.includes(objectKind)) {
      return restrictCapability(
        capabilityValue,
        'unsupported',
        'object-kind',
        `This construct is available only for: ${requirements.objectKinds.join(', ')}.`,
      );
    }
  }

  if (requirements.privileges && context.privileges) {
    const availablePrivileges = new Set(context.privileges.map(value => value.trim().toUpperCase()));
    const missing = requirements.privileges.filter(value => !availablePrivileges.has(value.trim().toUpperCase()));
    if (missing.length > 0) {
      return restrictCapability(
        capabilityValue,
        'privilege-blocked',
        'privilege',
        `Missing required privilege(s): ${missing.join(', ')}.`,
      );
    }
  }

  return capabilityValue;
}

/**
 * Resolves connection-specific restrictions without changing the base
 * dialect manifest. This keeps version/engine/privilege logic out of media
 * panels while allowing providers to refine the result after introspection.
 */
export function resolveDatabaseDesignerCapabilities(
  base: DatabaseDesignerCapabilities,
  context: DatabaseDesignerRuntimeContext,
): DatabaseDesignerCapabilities {
  if (context.runtimeAvailable === false) {
    return {
      ...base,
      constructs: Object.fromEntries(
        DESIGNER_CAPABILITY_KEYS.map(key => [key, unavailableCapability('The database runtime is not available in this product surface.')]),
      ) as Record<DatabaseDesignerCapabilityKey, DatabaseDesignerCapability>,
    };
  }

  const resolvedConstructs = Object.fromEntries(
    DESIGNER_CAPABILITY_KEYS.map(key => [key, resolveCapabilityRequirements(base.constructs[key], context)]),
  ) as Record<DatabaseDesignerCapabilityKey, DatabaseDesignerCapability>;
  if (!context.readOnly) return { ...base, constructs: resolvedConstructs };
  return {
    ...base,
    constructs: Object.fromEntries(
      DESIGNER_CAPABILITY_KEYS.map(key => [key, withoutMutationOperations(resolvedConstructs[key])]),
    ) as Record<DatabaseDesignerCapabilityKey, DatabaseDesignerCapability>,
  };
}

export function getDesignerCapability(
  capabilities: DatabaseDesignerCapabilities,
  key: DatabaseDesignerCapabilityKey,
): DatabaseDesignerCapability {
  return capabilities.constructs[key];
}
