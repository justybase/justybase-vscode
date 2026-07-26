import { afterAll, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';

jest.unmock('chevrotain');

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { ExtensionContext } from 'vscode';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { OracleConnection } from '../../../extensions/oracle/src/oracleConnection';
import { oracleDialect } from '../../../extensions/oracle/src/oracleDialect';
import {
	buildOracleExplainQuery,
	parseOracleExplainJson,
	renderOracleExplainPlan,
} from '../../../extensions/oracle/src/oracleExplainParser';
import { oracleMaintenanceProvider } from '../../../extensions/oracle/src/oracleMaintenanceProvider';
import { oracleSqlAuthoring } from '../../../extensions/oracle/src/sql/authoring';
import { importDataToOracle } from '../../../src/import/oracleImporter';
import { exportResultSetToFile } from '../../../src/export/resultExporter';
import { cancelCommandAndCloseReader } from '../../../src/core/cancellation';
import type { ResultSet } from '../../../src/types';
import { oracleMetadataProvider } from '../../../extensions/oracle/src/oracleSchemaProvider';
import type {
	DatabaseConnectionConfig,
	DatabaseMaintenanceServices,
	DatabaseMaintenanceTarget,
} from '../../contracts/database';
import type { ConnectionManager } from '../../core/connectionManager';
import { LspCompletionEngine, type CompletionMetadataProvider } from '../../server/completionEngine';
import type { MetadataColumnItem, MetadataObjectItem } from '../../lsp/protocol';
import { SqlQualityEngine } from '../../providers/sqlQualityEngine';
import { InMemorySchemaProvider } from '../../sqlParser/schemaProvider';
import { SqlValidator } from '../../sqlParser/validator';
import type { ConnectionDetails } from '../../types';
import { oracleHarness, registerLiveIntegrationSuite } from './optionalDialectIntegrationHarness';

registerLiveIntegrationSuite(oracleHarness);

function quoteIdentifier(value: string): string {
	return `"${value.replace(/"/g, '""')}"`;
}

function buildQualifiedName(schema: string, objectName: string): string {
	return `${quoteIdentifier(schema)}.${quoteIdentifier(objectName)}`;
}

function buildLikePattern(value: string): string {
	return `%${value.toUpperCase()}%`;
}

function toConnectionDetails(config: DatabaseConnectionConfig): ConnectionDetails {
	return {
		...config,
		dbType: 'oracle',
	};
}

async function readRows(
	connection: OracleConnection,
	sql: string,
): Promise<Record<string, unknown>[]> {
	const reader = await connection.createCommand(sql).executeReader();
	try {
		const rows: Record<string, unknown>[] = [];
		while (await reader.read()) {
			const row: Record<string, unknown> = {};
			for (let index = 0; index < reader.fieldCount; index += 1) {
				row[reader.getName(index)] = reader.getValue(index);
			}
			rows.push(row);
		}
		return rows;
	} finally {
		await reader.close();
	}
}

async function tryExecute(connection: OracleConnection, sql: string): Promise<void> {
	try {
		await connection.createCommand(sql).execute();
	} catch {
		// Best-effort cleanup for integration objects.
	}
}

function createMaintenanceTarget(
	config: DatabaseConnectionConfig,
	schemaName: string,
	tableName: string,
): DatabaseMaintenanceTarget {
	return {
		connectionName: 'oracle-live-test',
		databaseName: config.database,
		schemaName,
		tableName,
		qualifiedName: `${schemaName}.${tableName}`,
	};
}

function createMaintenanceServices(
	connection: OracleConnection,
	config: DatabaseConnectionConfig,
	executedSql: string[],
): DatabaseMaintenanceServices {
	return {
		context: {} as ExtensionContext,
		async executeSql(sql: string): Promise<void> {
			executedSql.push(sql);
			await connection.createCommand(sql).execute();
		},
		async getConnectionDetails(): Promise<ConnectionDetails | undefined> {
			return toConnectionDetails(config);
		},
		async openSqlDocument(): Promise<void> {
			return;
		},
		async executeWithProgress<T>(_title: string, task: () => Promise<T>): Promise<T> {
			return task();
		},
		async executeAndReport(
			_target: DatabaseMaintenanceTarget,
			sql: string,
		): Promise<void> {
			executedSql.push(sql);
			await connection.createCommand(sql).execute();
		},
		async executeQuery<T extends Record<string, unknown>>(sql: string): Promise<T[]> {
			return await readRows(connection, sql) as T[];
		},
	};
}

function createMockConnectionManager(config: DatabaseConnectionConfig): ConnectionManager {
	return {
		getActiveConnectionName: () => 'oracle-live-test',
		getConnection: async () => toConnectionDetails(config),
	} as unknown as ConnectionManager;
}

function toOptionalNumber(value: unknown): number | undefined {
	if (typeof value === 'number' && Number.isFinite(value)) {
		return value;
	}
	if (typeof value === 'string' && value.trim().length > 0) {
		const parsed = Number(value);
		return Number.isFinite(parsed) ? parsed : undefined;
	}
	return undefined;
}

function toOptionalString(value: unknown): string | undefined {
	return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

/** Convert flat PLAN_TABLE rows (ID/PARENT_ID) into the nested JSON shape expected by parseOracleExplainJson. */
function buildOracleExplainTreeFromPlanTableRows(
	rows: ReadonlyArray<Record<string, unknown>>,
): Record<string, unknown> {
	if (rows.length === 0) {
		throw new Error('PLAN_TABLE returned no rows for the explained statement.');
	}

	type MutableNode = Record<string, unknown> & { children: MutableNode[] };
	const nodesById = new Map<number, MutableNode>();

	for (const row of rows) {
		const id = toOptionalNumber(row.ID);
		if (id === undefined) {
			continue;
		}

		nodesById.set(id, {
			operation: toOptionalString(row.OPERATION) ?? 'Unknown',
			options: toOptionalString(row.OPTIONS),
			object_owner: toOptionalString(row.OBJECT_OWNER),
			object_name: toOptionalString(row.OBJECT_NAME),
			object_type: toOptionalString(row.OBJECT_TYPE),
			cost: toOptionalNumber(row.COST),
			cardinality: toOptionalNumber(row.CARDINALITY) ?? 0,
			bytes: toOptionalNumber(row.BYTES),
			cpu_cost: toOptionalNumber(row.CPU_COST),
			io_cost: toOptionalNumber(row.IO_COST),
			filter_predicates: toOptionalString(row.FILTER_PREDICATES),
			access_predicates: toOptionalString(row.ACCESS_PREDICATES),
			children: [],
		});
	}

	let root: MutableNode | undefined;
	for (const row of rows) {
		const id = toOptionalNumber(row.ID);
		if (id === undefined) {
			continue;
		}
		const node = nodesById.get(id);
		if (!node) {
			continue;
		}

		const parentId = toOptionalNumber(row.PARENT_ID);
		if (parentId === undefined) {
			root = node;
			continue;
		}

		const parent = nodesById.get(parentId);
		if (parent) {
			parent.children.push(node);
		} else if (!root) {
			root = node;
		}
	}

	if (!root) {
		root = nodesById.values().next().value;
	}
	if (!root) {
		throw new Error('Unable to build Oracle explain tree from PLAN_TABLE rows.');
	}

	return { plan: root };
}

function isOraclePermissionOrMissingObjectError(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	return /ORA-00942|ORA-01031|ORA-00904|insufficient privileges|table or view does not exist/i.test(
		message,
	);
}

function createDocumentWithCursor(sqlWithCursor: string): {
	document: TextDocument;
	cursorOffset: number;
} {
	const cursorOffset = sqlWithCursor.indexOf('|');
	if (cursorOffset < 0) {
		throw new Error('Missing cursor marker "|"');
	}

	const sql = `${sqlWithCursor.slice(0, cursorOffset)}${sqlWithCursor.slice(cursorOffset + 1)}`;
	return {
		document: TextDocument.create('file:///oracle-live-completion.sql', 'sql', 1, sql),
		cursorOffset,
	};
}

function completionLabels(items: { label: string }[]): string[] {
	return items
		.map((item) => item.label)
		.filter((label) => label !== '* (Expand Columns)');
}

class LiveOracleCompletionMetadataProvider implements CompletionMetadataProvider {
	public readonly lookupRequests: Array<{
		database: string;
		table: string;
		schema?: string;
	}> = [];

	public constructor(
		private readonly connection: OracleConnection,
		private readonly database: string,
		private readonly schema: string,
	) {}

	public async getContext(_documentUri: string): Promise<{
		effectiveDatabase?: string;
		effectiveSchema?: string;
		databaseKind?: 'oracle';
	}> {
		return {
			effectiveDatabase: this.database,
			effectiveSchema: this.schema,
			databaseKind: 'oracle',
		};
	}

	public async getDatabases(_documentUri: string): Promise<MetadataObjectItem[]> {
		return [{ name: this.database, detail: 'Service' }];
	}

	public async getSchemas(
		_documentUri: string,
		_database: string,
	): Promise<MetadataObjectItem[]> {
		return [{ name: this.schema, detail: 'Schema' }];
	}

	public async getTables(
		_documentUri: string,
		_database: string,
		schema?: string,
	): Promise<MetadataObjectItem[]> {
		const rows = await readRows(
			this.connection,
			oracleMetadataProvider.buildListTablesQuery(
				this.database,
				schema ?? this.schema,
			),
		);
		const tables: MetadataObjectItem[] = [];
		for (const row of rows) {
			const name = row.OBJNAME;
			if (typeof name === 'string' && name.trim().length > 0) {
				tables.push({ name, detail: 'Table' });
			}
		}
		return tables;
	}

	public async getViews(
		_documentUri: string,
		_database: string,
		schema?: string,
	): Promise<MetadataObjectItem[]> {
		const rows = await readRows(
			this.connection,
			oracleMetadataProvider.buildListViewsQuery(
				this.database,
				schema ?? this.schema,
			),
		);
		const views: MetadataObjectItem[] = [];
		for (const row of rows) {
			const name = row.OBJNAME;
			if (typeof name === 'string' && name.trim().length > 0) {
				views.push({ name, detail: 'View' });
			}
		}
		return views;
	}

	public async getProcedures(
		_documentUri: string,
		_database: string,
		_schema?: string,
	): Promise<MetadataObjectItem[]> {
		return [];
	}

	public async getColumns(
		_documentUri: string,
		database: string,
		table: string,
		schema?: string,
	): Promise<MetadataColumnItem[]> {
		this.lookupRequests.push({ database, table, schema });
		const rows = await readRows(
			this.connection,
			oracleMetadataProvider.buildLookupColumnsQuery({
				schema: schema ?? this.schema,
				tableName: table,
			}),
		);

		const columns: MetadataColumnItem[] = [];
		for (const row of rows) {
			const name = row.ATTNAME;
			if (typeof name !== 'string' || name.trim().length === 0) {
				continue;
			}
			const type = row.FORMAT_TYPE;
			columns.push({
				name,
				type: typeof type === 'string' && type.trim().length > 0 ? type : 'VARCHAR2',
			});
		}
		return columns;
	}
}

async function buildLiveOracleSchemaProvider(
	connection: OracleConnection,
	config: DatabaseConnectionConfig,
	schemaName: string,
	tableName: string,
): Promise<InMemorySchemaProvider> {
	const columns = await oracleDialect.advancedFeatures!.ddl!.getColumns(
		connection,
		config.database,
		schemaName,
		tableName,
	);
	const schemaProvider = new InMemorySchemaProvider(true);
	schemaProvider.addTable({
		name: tableName,
		database: config.database,
		schema: schemaName,
		isCte: false,
		isTempTable: false,
		columns: columns.map((column) => ({
			name: column.name,
			dataType: column.fullTypeName,
		})),
	});
	return schemaProvider;
}

const config = oracleHarness.config;
if (process.env.ORACLE_LIVE_TEST_REQUIRED === 'true' && !config) {
	throw new Error(
		'ORACLE_LIVE_TEST_REQUIRED=true but ORACLE_LIVE_TEST_HOST, ORACLE_LIVE_TEST_DATABASE, '
			+ 'ORACLE_LIVE_TEST_USER and ORACLE_LIVE_TEST_PASSWORD are not fully configured.',
	);
}
const describeIfConfigured = config ? describe : describe.skip;
const showWarningMessage = vscode.window.showWarningMessage as unknown as jest.Mock;
const showInformationMessage = vscode.window.showInformationMessage as unknown as jest.Mock;

describeIfConfigured('oracle integration', () => {
	let connection: OracleConnection;

	const stamp = `${Date.now().toString(36).slice(-6)}${Math.random().toString(36).slice(2, 6)}`.toUpperCase();
	const tableName = `JBL_ORA_T_${stamp}`;
	const viewName = `JBL_ORA_V_${stamp}`;
	const procedureName = `JBL_ORA_P_${stamp}`;
	const functionName = `JBL_ORA_F_${stamp}`;
	const packageName = `JBL_ORA_PKG_${stamp}`;
	const sequenceName = `JBL_ORA_SEQ_${stamp}`;
	const synonymName = `JBL_ORA_SYN_${stamp}`;
	const triggerName = `JBL_ORA_TRG_${stamp}`;
	const indexName = `JBL_ORA_IX_${stamp}`;
	const partitionTableName = `JBL_ORA_PT_${stamp}`;
	const importTableName = `JBL_ORA_IMPORT_${stamp}`;
	const exportTableName = `JBL_ORA_EXPORT_${stamp}`;
	const searchColumnName = `JBL_OC_${stamp}`;
	const sourceMarker = `JBL_ORA_SOURCE_${stamp}`;
	const tableComment = `JBL Oracle comment ${stamp}`;
	let schemaName = '';
	let importFixturePath = '';
	let errorFixturePath = '';

	beforeAll(async () => {
		connection = oracleHarness.createConnection(config!) as OracleConnection;
		await connection.connect();

		schemaName = connection.getCurrentSchema();

		const qualifiedTableName = buildQualifiedName(schemaName, tableName);
		const qualifiedViewName = buildQualifiedName(schemaName, viewName);
		const qualifiedProcedureName = buildQualifiedName(schemaName, procedureName);
		const qualifiedFunctionName = buildQualifiedName(schemaName, functionName);
		const qualifiedPackageName = buildQualifiedName(schemaName, packageName);
		const qualifiedSequenceName = buildQualifiedName(schemaName, sequenceName);
		const qualifiedSynonymName = buildQualifiedName(schemaName, synonymName);
		const qualifiedTriggerName = buildQualifiedName(schemaName, triggerName);
		const qualifiedIndexName = buildQualifiedName(schemaName, indexName);
		const qualifiedPartitionTableName = buildQualifiedName(schemaName, partitionTableName);

		await connection.createCommand(`
			CREATE TABLE ${qualifiedTableName} (
				ID NUMBER(10) NOT NULL PRIMARY KEY,
				${quoteIdentifier(searchColumnName)} VARCHAR2(100) NOT NULL UNIQUE,
				CREATED_AT DATE DEFAULT SYSDATE NOT NULL,
				EVENT_AT TIMESTAMP WITH TIME ZONE DEFAULT SYSTIMESTAMP NOT NULL,
				NOTES CLOB,
				PAYLOAD BLOB
			)
		`).execute();

		await connection.createCommand(`
			INSERT INTO ${qualifiedTableName} (ID, ${quoteIdentifier(searchColumnName)})
			VALUES (1, 'Alice')
		`).execute();
		await connection.createCommand(`
			INSERT INTO ${qualifiedTableName} (ID, ${quoteIdentifier(searchColumnName)})
			VALUES (2, 'Bob')
		`).execute();

		await connection.createCommand(
			`COMMENT ON TABLE ${qualifiedTableName} IS '${tableComment.replace(/'/g, "''")}'`,
		).execute();

		await connection.createCommand(`
			CREATE OR REPLACE VIEW ${qualifiedViewName} AS
			SELECT
				ID,
				${quoteIdentifier(searchColumnName)} AS CUSTOMER_NAME,
				'${sourceMarker}' AS SOURCE_MARKER
			FROM ${qualifiedTableName}
		`).execute();

		await connection.createCommand(`
			CREATE OR REPLACE PROCEDURE ${qualifiedProcedureName} AS
				V_MARKER VARCHAR2(100) := '${sourceMarker}';
			BEGIN
				NULL;
			END;
		`).execute();

		await connection.createCommand(`CREATE SEQUENCE ${qualifiedSequenceName} START WITH 100 INCREMENT BY 1`).execute();
		await connection.createCommand(`CREATE OR REPLACE SYNONYM ${qualifiedSynonymName} FOR ${qualifiedTableName}`).execute();
		await connection.createCommand(`CREATE INDEX ${qualifiedIndexName} ON ${qualifiedTableName} (CREATED_AT)`).execute();
		await connection.createCommand(`
			CREATE OR REPLACE FUNCTION ${qualifiedFunctionName} RETURN NUMBER IS
			BEGIN
				RETURN 42;
			END;
		`).execute();
		await connection.createCommand(`CREATE OR REPLACE PACKAGE ${qualifiedPackageName} AS FUNCTION VALUE RETURN NUMBER; END ${quoteIdentifier(packageName)};`).execute();
		await connection.createCommand(`
			CREATE OR REPLACE PACKAGE BODY ${qualifiedPackageName} AS
				FUNCTION VALUE RETURN NUMBER IS BEGIN RETURN 42; END;
			END ${quoteIdentifier(packageName)};
		`).execute();
		await connection.createCommand(`
			CREATE OR REPLACE TRIGGER ${qualifiedTriggerName}
			BEFORE INSERT ON ${qualifiedTableName}
			FOR EACH ROW
			BEGIN
				IF :NEW.ID IS NULL THEN :NEW.ID := ${qualifiedSequenceName}.NEXTVAL; END IF;
			END;
		`).execute();
		await connection.createCommand(`
			CREATE TABLE ${qualifiedPartitionTableName} (
				ID NUMBER NOT NULL,
				EVENT_AT TIMESTAMP NOT NULL
			)
			PARTITION BY RANGE (EVENT_AT) (
				PARTITION P_OLD VALUES LESS THAN (TIMESTAMP '2027-01-01 00:00:00'),
				PARTITION P_MAX VALUES LESS THAN (MAXVALUE)
			)
		`).execute();

		await connection.createCommand(`GRANT SELECT ON ${qualifiedTableName} TO PUBLIC`).execute();
	}, 120000);

	beforeEach(() => {
		showWarningMessage.mockReset();
		showInformationMessage.mockReset();
		showWarningMessage.mockImplementation(async (_message: unknown, _options: unknown, ...items: unknown[]) => items[0]);
		showInformationMessage.mockImplementation(async (_message: unknown, _options: unknown, ...items: unknown[]) => items[0]);
	});

	afterAll(async () => {
		await tryExecute(connection, `DROP TRIGGER ${buildQualifiedName(schemaName, triggerName)}`);
		await tryExecute(connection, `REVOKE SELECT ON ${buildQualifiedName(schemaName, tableName)} FROM PUBLIC`);
		await tryExecute(connection, `DROP PACKAGE ${buildQualifiedName(schemaName, packageName)}`);
		await tryExecute(connection, `DROP FUNCTION ${buildQualifiedName(schemaName, functionName)}`);
		await tryExecute(connection, `DROP SYNONYM ${buildQualifiedName(schemaName, synonymName)}`);
		await tryExecute(connection, `DROP INDEX ${buildQualifiedName(schemaName, indexName)}`);
		await tryExecute(connection, `DROP SEQUENCE ${buildQualifiedName(schemaName, sequenceName)}`);
		await tryExecute(connection, `DROP TABLE ${buildQualifiedName(schemaName, partitionTableName)} PURGE`);
		await tryExecute(connection, `DROP TABLE ${buildQualifiedName(schemaName, exportTableName)} PURGE`);
		await tryExecute(connection, `DROP TABLE ${buildQualifiedName(schemaName, importTableName)} PURGE`);
		await tryExecute(connection, `DROP PROCEDURE ${buildQualifiedName(schemaName, procedureName)}`);
		await tryExecute(connection, `DROP VIEW ${buildQualifiedName(schemaName, viewName)}`);
		await tryExecute(connection, `DROP TABLE ${buildQualifiedName(schemaName, tableName)}`);
		await connection.close();
		for (const fixturePath of [importFixturePath, errorFixturePath]) {
			if (fixturePath) {
				try { fs.unlinkSync(fixturePath); } catch { /* best effort */ }
			}
		}
	});

	describe('Oracle object families and storage types', () => {
		it('discovers sequence, synonym, function, package, trigger, index, partition and LOB/time-zone metadata', async () => {
			const objectRows = await readRows(
				connection,
				oracleMetadataProvider.buildObjectSearchQuery(config!.database, buildLikePattern(stamp)),
			);
			const objectTypes = new Set(objectRows.map((row) => String(row.TYPE).toUpperCase()));

			expect(objectTypes.has('SEQUENCE')).toBe(true);
			expect(objectTypes.has('SYNONYM')).toBe(true);
			expect(objectTypes.has('FUNCTION')).toBe(true);
			expect(objectTypes.has('PACKAGE')).toBe(true);
			expect(objectTypes.has('TRIGGER')).toBe(true);
			const indexRows = await readRows(
				connection,
				`SELECT INDEX_NAME FROM ALL_INDEXES WHERE OWNER = '${schemaName.replace(/'/g, "''")}' AND INDEX_NAME = '${indexName}'`,
			);
			expect(indexRows).toHaveLength(1);
			const partitionRows = await readRows(
				connection,
				`SELECT PARTITION_NAME FROM ALL_TAB_PARTITIONS WHERE TABLE_OWNER = '${schemaName.replace(/'/g, "''")}' AND TABLE_NAME = '${partitionTableName}'`,
			);
			expect(partitionRows.map((row) => String(row.PARTITION_NAME))).toEqual(
				expect.arrayContaining(['P_OLD', 'P_MAX']),
			);

			const columns = await oracleDialect.advancedFeatures!.ddl!.getColumns(
				connection,
				config!.database,
				schemaName,
				tableName,
			);
			const columnTypes = columns.map((column) => column.fullTypeName.toUpperCase());
			expect(columnTypes).toEqual(expect.arrayContaining(['CLOB', 'BLOB', 'TIMESTAMP(6) WITH TIME ZONE']));
		});
	});

	describe('connection and metadata discovery', () => {
		it('returns current catalog, schema, and sid context', async () => {
			const rows = await readRows(
				connection,
				`
					SELECT
						COALESCE(
							NULLIF(SYS_CONTEXT('USERENV', 'SERVICE_NAME'), ''),
							NULLIF(SYS_CONTEXT('USERENV', 'DB_NAME'), ''),
							USER
						) AS CURRENT_CATALOG,
						SYS_CONTEXT('USERENV', 'CURRENT_SCHEMA') AS CURRENT_SCHEMA,
						SYS_CONTEXT('USERENV', 'SID') AS CURRENT_SID
					FROM DUAL
				`,
			);

			expect(rows).toHaveLength(1);
			expect(String(rows[0].CURRENT_CATALOG ?? '').length).toBeGreaterThan(0);
			expect(String(rows[0].CURRENT_SCHEMA ?? '')).toBe(schemaName);
			expect(String(rows[0].CURRENT_SID ?? '').length).toBeGreaterThan(0);
		});

		it('lists tables, views, and procedures including created integration objects', async () => {
			const tablesSql = oracleMetadataProvider.buildListTablesQuery(config!.database, schemaName);
			expect(tablesSql.toUpperCase()).toContain('O.OWNER');
			expect(tablesSql.toUpperCase()).toContain(schemaName.toUpperCase());

			const tables = await readRows(connection, tablesSql);
			expect(tables.some((row) => String(row.OBJNAME).toUpperCase() === tableName)).toBe(true);

			const viewsSql = oracleMetadataProvider.buildListViewsQuery(config!.database, schemaName);
			expect(viewsSql.toUpperCase()).toContain('O.OWNER');
			const views = await readRows(connection, viewsSql);
			expect(views.some((row) => String(row.OBJNAME).toUpperCase() === viewName)).toBe(true);

			const procedures = await readRows(
				connection,
				oracleMetadataProvider.buildListProceduresQuery(config!.database, schemaName),
			);
			expect(procedures.some((row) => String(row.PROCEDURE).toUpperCase() === procedureName)).toBe(true);

			// One-arg call historically passed schema as database and dropped the OWNER filter.
			const unscopedSql = oracleMetadataProvider.buildListTablesQuery(schemaName);
			expect(unscopedSql.toUpperCase()).not.toMatch(/AND UPPER\(O\.OWNER\)/);
		});

		it('finds created objects and source text through Oracle-specific search queries', async () => {
			const objectRows = await readRows(
				connection,
				oracleMetadataProvider.buildObjectSearchQuery(config!.database, buildLikePattern(tableName)),
			);
			expect(
				objectRows.some(
					(row) => String(row.NAME).toUpperCase() === tableName && String(row.TYPE).toUpperCase() === 'TABLE',
				),
			).toBe(true);

			const columnRows = await readRows(
				connection,
				oracleMetadataProvider.buildObjectSearchQuery(config!.database, buildLikePattern(searchColumnName)),
			);
			expect(
				columnRows.some(
					(row) => String(row.NAME).toUpperCase() === searchColumnName && String(row.PARENT).toUpperCase() === tableName,
				),
			).toBe(true);

			const viewSourceRows = await readRows(
				connection,
				oracleMetadataProvider.buildViewSourceSearchQuery(config!.database, {
					rawTerm: sourceMarker,
					likePattern: buildLikePattern(sourceMarker),
					useServerSideFilter: true,
				}),
			);
			expect(viewSourceRows.some((row) => String(row.NAME).toUpperCase() === viewName)).toBe(true);

			const procedureSourceRows = await readRows(
				connection,
				oracleMetadataProvider.buildProcedureSourceSearchQuery(config!.database, {
					rawTerm: sourceMarker,
					likePattern: buildLikePattern(sourceMarker),
					useServerSideFilter: true,
				}),
			);
			expect(
				procedureSourceRows.some(
					(row) => String(row.NAME).toUpperCase() === procedureName && String(row.TYPE).toUpperCase() === 'PROCEDURE',
				),
			).toBe(true);
		});
	});

	describe('DDL provider', () => {
		it('retrieves columns, keys, comment, and owner metadata for a live table', async () => {
			const ddl = oracleDialect.advancedFeatures!.ddl!;

			const columns = await ddl.getColumns(connection, config!.database, schemaName, tableName);
			expect(columns.map((column) => column.name.toUpperCase())).toEqual(
				expect.arrayContaining(['ID', searchColumnName, 'CREATED_AT']),
			);

			const keysInfo = await ddl.getKeysInfo(connection, config!.database, schemaName, tableName);
			const primaryKey = [...keysInfo.values()].find((key) => key.typeChar === 'P');
			expect(primaryKey).toBeDefined();
			expect(primaryKey!.columns.map((column) => column.toUpperCase())).toContain('ID');

			const comment = await ddl.getTableComment(connection, config!.database, schemaName, tableName);
			expect(comment).toBe(tableComment);

			const owner = await ddl.getTableOwner(connection, config!.database, schemaName, tableName);
			expect(owner).toBe(schemaName);
		});

		it('generates table, view, and procedure DDL from live metadata', async () => {
			const ddl = oracleDialect.advancedFeatures!.ddl!;

			const tableDdl = await ddl.generateTableDDL(connection, config!.database, schemaName, tableName);
			expect(tableDdl).toContain('CREATE TABLE');
			expect(tableDdl.toUpperCase()).toContain(tableName);

			const viewDdl = await ddl.generateViewDDL(connection, config!.database, schemaName, viewName);
			expect(viewDdl).toContain('VIEW');
			expect(viewDdl).toContain(sourceMarker);

			const procedureDdl = await ddl.generateProcedureDDL(connection, config!.database, schemaName, procedureName);
			expect(procedureDdl).toContain('PROCEDURE');
			expect(procedureDdl.toUpperCase()).toContain(procedureName);
		});

		it('uses Oracle optimizer statistics instead of Netezza SPU/skew semantics', async () => {
			const ddl = oracleDialect.advancedFeatures!.ddl!;
			const rows = await readRows(
				connection,
				ddl.buildTableStatsQuery(config!.database, schemaName, tableName),
			);

			expect(rows).toHaveLength(1);
			expect(rows[0]).toHaveProperty('LAST_ANALYZED');
			expect(() => ddl.buildSkewCheckQuery(buildQualifiedName(schemaName, tableName))).toThrow(
				/does not expose Netezza SPU/i,
			);
		});

		it('generates DDL for function, package, trigger, sequence, and synonym objects', async () => {
			const ddl = oracleDialect.advancedFeatures!.ddl!;
			const connectionDetails = toConnectionDetails(config!);
			const cases: Array<{ name: string; type: string; expectFragment: RegExp }> = [
				{ name: functionName, type: 'FUNCTION', expectFragment: /CREATE[\s\S]*FUNCTION/i },
				{ name: packageName, type: 'PACKAGE', expectFragment: /CREATE[\s\S]*PACKAGE/i },
				{ name: triggerName, type: 'TRIGGER', expectFragment: /CREATE[\s\S]*TRIGGER/i },
				{ name: sequenceName, type: 'SEQUENCE', expectFragment: /CREATE[\s\S]*SEQUENCE/i },
				{ name: synonymName, type: 'SYNONYM', expectFragment: /CREATE[\s\S]*SYNONYM/i },
			];

			for (const testCase of cases) {
				const result = await ddl.generateDDL(
					connectionDetails,
					config!.database,
					schemaName,
					testCase.name,
					testCase.type,
				);
				expect(result.success).toBe(true);
				expect(result.ddlCode).toBeTruthy();
				expect(result.ddlCode).toMatch(testCase.expectFragment);
				expect(result.ddlCode?.toUpperCase()).toContain(testCase.name.toUpperCase());
			}
		}, 180000);
	});

	describe('explain and tuning advisor', () => {
		it('runs EXPLAIN PLAN, parses the plan tree, and surfaces SELECT * tuning advice', async () => {
			const statementId = `JBL_${stamp}`.slice(0, 30);
			const qualifiedTable = buildQualifiedName(schemaName, tableName);
			const explainedSql = `SELECT * FROM ${qualifiedTable} WHERE ID = 1`;

			await tryExecute(
				connection,
				`DELETE FROM PLAN_TABLE WHERE STATEMENT_ID = '${statementId.replace(/'/g, "''")}'`,
			);

			await connection
				.createCommand(
					`EXPLAIN PLAN SET STATEMENT_ID = '${statementId.replace(/'/g, "''")}' FOR ${explainedSql}`,
				)
				.execute();

			const planRows = await readRows(
				connection,
				[
					'SELECT ID, PARENT_ID, OPERATION, OPTIONS, OBJECT_OWNER, OBJECT_NAME, OBJECT_TYPE,',
					'       COST, CARDINALITY, BYTES, CPU_COST, IO_COST, FILTER_PREDICATES, ACCESS_PREDICATES',
					'FROM PLAN_TABLE',
					`WHERE STATEMENT_ID = '${statementId.replace(/'/g, "''")}'`,
					'ORDER BY ID',
				].join('\n'),
			);
			expect(planRows.length).toBeGreaterThan(0);
			expect(planRows.some((row) => String(row.OPERATION ?? '').length > 0)).toBe(true);

			const explainEnvelope = buildOracleExplainTreeFromPlanTableRows(planRows);
			const explainPlanText = JSON.stringify(explainEnvelope);
			const parsed = parseOracleExplainJson(explainPlanText);
			expect(parsed.root.operation.length).toBeGreaterThan(0);
			expect(renderOracleExplainPlan(parsed)).toContain(parsed.root.operation);

			// Sanity-check the shared query builder still matches the EXPLAIN PLAN FOR shape.
			expect(buildOracleExplainQuery(explainedSql)).toContain('EXPLAIN PLAN FOR');

			const tuningAdvisor = oracleDialect.advancedFeatures?.tuningAdvisor;
			expect(tuningAdvisor).toBeDefined();
			const report = tuningAdvisor!.analyze({
				sql: explainedSql,
				explainPlanText,
			});
			expect(report.recommendations.map((item) => item.id)).toEqual(
				expect.arrayContaining(['ORTA-001']),
			);

			await tryExecute(
				connection,
				`DELETE FROM PLAN_TABLE WHERE STATEMENT_ID = '${statementId.replace(/'/g, "''")}'`,
			);
		}, 120000);
	});

	describe('compatibility shims', () => {
		it('emulates CURRENT_CATALOG and CURRENT_SCHEMA through OracleConnection', async () => {
			const catalogRows = await readRows(connection, 'SELECT CURRENT_CATALOG FROM DUAL');
			expect(catalogRows).toHaveLength(1);
			expect(String(catalogRows[0].CURRENT_CATALOG ?? '').length).toBeGreaterThan(0);

			const schemaRows = await readRows(connection, 'SELECT CURRENT_SCHEMA FROM DUAL');
			expect(schemaRows).toHaveLength(1);
			expect(String(schemaRows[0].CURRENT_SCHEMA ?? '')).toBe(schemaName);

			const sidRows = await readRows(connection, 'SELECT CURRENT_SID FROM DUAL');
			expect(sidRows).toHaveLength(1);
			expect(String(sidRows[0].CURRENT_SID ?? '').length).toBeGreaterThan(0);
		});
	});

	describe('Oracle import, export, and schema migration', () => {
		it('cancels a large fetch and keeps the Oracle session usable', async () => {
			const command = connection.createCommand('SELECT LEVEL AS ID FROM DUAL CONNECT BY LEVEL <= 1000000');
			const reader = await command.executeReader();
			let fetchedRows = 0;
			let fetchError: unknown;
			const fetchPromise = (async () => {
				try {
					while (await reader.read()) {
						fetchedRows += 1;
					}
				} catch (error: unknown) {
					fetchError = error;
				}
			})();

			await new Promise(resolve => setTimeout(resolve, 25));
			const cleanup = await cancelCommandAndCloseReader(command, reader, { timeoutMs: 5_000 });
			await Promise.race([
				fetchPromise,
				new Promise<void>((_, reject) => setTimeout(() => reject(new Error('Oracle fetch did not stop after cancel')), 5_000)),
			]);

			expect(cleanup.timedOut).toBe(false);
			expect(fetchedRows).toBeGreaterThanOrEqual(0);
			if (fetchError) {
				expect(String(fetchError)).toMatch(/cancel|closed|invalid|ORA-/i);
			}

			const controlRows = await readRows(connection, 'SELECT 1 AS CONTROL_VALUE FROM DUAL');
			expect(controlRows[0].CONTROL_VALUE).toBe(1);
		});

		it('round-trips BOOLEAN, binary, date/time-zone values and cleans failed imports', async () => {
			const connectionDetails = toConnectionDetails(config!);
			importFixturePath = path.join(os.tmpdir(), `${importTableName}.csv`);
			errorFixturePath = path.join(os.tmpdir(), `${importTableName}_error.csv`);
			fs.writeFileSync(
				importFixturePath,
				'ID,NAME,EVENT_DATE,EVENT_TS,FLAG,PAYLOAD,RAW_BYTES,EVENT_TZ\n'
				+ `1,"A,lice's",2026-07-18,2026-07-18 12:30:45,true,hex:CAFE,hex:ABCD,2026-07-18T12:30:45.123+02:00\n`,
				'utf8',
			);

			const importResult = await importDataToOracle(
				importFixturePath,
				`${schemaName}.${importTableName}`,
				connectionDetails,
				undefined,
				1800,
				{
					forcedColumnTypes: {
						0: 'INTEGER',
						1: 'VARCHAR(100)',
						2: 'DATE',
						3: 'TIMESTAMP',
						4: 'BOOLEAN',
						5: 'BLOB',
						6: 'RAW(4)',
						7: 'TIMESTAMP WITH TIME ZONE',
					},
				},
			);
			expect(importResult.success).toBe(true);

			const importedRows = await readRows(
				connection,
				`SELECT ID, NAME, FLAG, DBMS_LOB.GETLENGTH(PAYLOAD) AS PAYLOAD_LENGTH, RAWTOHEX(RAW_BYTES) AS RAW_HEX, TO_CHAR(EVENT_TZ, 'YYYY-MM-DD HH24:MI:SS.FF3 TZH:TZM') AS EVENT_TZ_TEXT FROM ${buildQualifiedName(schemaName, importTableName)}`,
			);
			expect(importedRows).toHaveLength(1);
			expect(importedRows[0].NAME).toBe("A,lice's");
			expect(importedRows[0].FLAG).toBe(1);
			expect(importedRows[0].PAYLOAD_LENGTH).toBe(2);
			expect(importedRows[0].RAW_HEX).toBe('ABCD');
			expect(String(importedRows[0].EVENT_TZ_TEXT)).toContain('+02:00');

			fs.writeFileSync(errorFixturePath, 'ID\nnot-a-number\n', 'utf8');
			const failedImport = await importDataToOracle(
				errorFixturePath,
				`${schemaName}.${importTableName}_ERROR`,
				connectionDetails,
				undefined,
				1800,
				{ forcedColumnTypes: { 0: 'INTEGER' } },
			);
			expect(failedImport.success).toBe(false);
			const leftoverTables = await readRows(
				connection,
				`SELECT TABLE_NAME FROM ALL_TABLES WHERE OWNER = '${schemaName.replace(/'/g, "''")}' AND TABLE_NAME = '${`${importTableName}_ERROR`.toUpperCase()}'`,
			);
			expect(leftoverTables).toHaveLength(0);
		});

		it('exports Oracle binary and timestamp-with-time-zone data as reusable SQL', async () => {
			const rows = await readRows(
				connection,
				`SELECT ID, NAME, EVENT_DATE, EVENT_TS, FLAG, PAYLOAD, RAW_BYTES, EVENT_TZ FROM ${buildQualifiedName(schemaName, importTableName)} ORDER BY ID`,
			);
			const resultSet = {
				columns: [
					{ name: 'ID', type: 'NUMBER' },
					{ name: 'NAME', type: 'VARCHAR2' },
					{ name: 'EVENT_DATE', type: 'DATE' },
					{ name: 'EVENT_TS', type: 'TIMESTAMP' },
					{ name: 'FLAG', type: 'NUMBER' },
					{ name: 'PAYLOAD', type: 'BLOB' },
					{ name: 'RAW_BYTES', type: 'RAW' },
					{ name: 'EVENT_TZ', type: 'TIMESTAMP WITH TIME ZONE' },
				],
				data: rows.map(row => [
					row.ID,
					row.NAME,
					row.EVENT_DATE,
					row.EVENT_TS,
					row.FLAG,
					row.PAYLOAD,
					row.RAW_BYTES,
					row.EVENT_TZ,
				]),
				rowCount: rows.length,
			} as unknown as ResultSet;
			const csvPath = path.join(os.tmpdir(), `${exportTableName}.csv`);
			const jsonPath = path.join(os.tmpdir(), `${exportTableName}.json`);
			const sqlPath = path.join(os.tmpdir(), `${exportTableName}.sql`);
			try {
				await exportResultSetToFile(resultSet, csvPath, { format: 'csv' });
				await exportResultSetToFile(resultSet, jsonPath, { format: 'json' });
				await exportResultSetToFile(resultSet, sqlPath, {
					format: 'sql',
					sqlTargetTable: buildQualifiedName(schemaName, exportTableName),
					sqlDialect: 'oracle',
				});
				expect(fs.readFileSync(csvPath, 'utf8')).toContain('hex:ABCD');
				expect(fs.readFileSync(jsonPath, 'utf8')).toContain('hex:');
				expect(fs.readFileSync(sqlPath, 'utf8')).toMatch(/HEXTORAW\('ABCD'\)/i);

				await connection.createCommand(`
					CREATE TABLE ${buildQualifiedName(schemaName, exportTableName)} (
						ID NUMBER(10), NAME VARCHAR2(100), EVENT_DATE DATE, EVENT_TS TIMESTAMP,
						FLAG NUMBER(1), PAYLOAD BLOB, RAW_BYTES RAW(4), EVENT_TZ TIMESTAMP WITH TIME ZONE
					)
				`).execute();
				const sqlStatements = fs.readFileSync(sqlPath, 'utf8')
					.replace(/^\s*--.*(?:\r?\n|$)/gm, '')
					.split(';')
					.map(value => value.trim())
					.filter(Boolean);
				for (const statement of sqlStatements) {
					await connection.createCommand(statement).execute();
				}

				const exportedRows = await readRows(connection, `SELECT ID, RAWTOHEX(RAW_BYTES) AS RAW_HEX, DBMS_LOB.GETLENGTH(PAYLOAD) AS PAYLOAD_LENGTH FROM ${buildQualifiedName(schemaName, exportTableName)}`);
				expect(exportedRows).toHaveLength(1);
				expect(exportedRows[0].RAW_HEX).toBe('ABCD');
				expect(exportedRows[0].PAYLOAD_LENGTH).toBe(2);
			} finally {
				for (const filePath of [csvPath, jsonPath, sqlPath]) {
					try { fs.unlinkSync(filePath); } catch { /* best effort */ }
				}
			}
		});

		it('generates direct INDEX DDL and schema migration DDL with partition/index/grant surfaces', async () => {
			const ddl = oracleDialect.advancedFeatures!.ddl!;
			const indexResult = await ddl.generateDDL(
				toConnectionDetails(config!),
				config!.database,
				schemaName,
				indexName,
				'INDEX',
			);
			expect(indexResult.success).toBe(true);
			expect(indexResult.ddlCode?.toUpperCase()).toContain('CREATE INDEX');

			const migration = await ddl.generateBatchDDL({
				connectionDetails: toConnectionDetails(config!),
				database: config!.database,
				schema: schemaName,
				objectTypes: ['TABLE'],
				mode: 'schema-migration',
				includeIndexes: true,
				includePartitions: true,
				includeGrants: true,
			});
			if (!migration.success) {
				throw new Error(migration.errors.join('\n'));
			}
			expect(migration.success).toBe(true);
			expect(migration.artifactKind).toBe('schema-migration');
			expect(migration.ddlCode?.toUpperCase()).toContain('CREATE INDEX');
			expect(migration.ddlCode?.toUpperCase()).toContain('PARTITION BY');
			expect(migration.ddlCode?.toUpperCase()).toContain('GRANT SELECT');
		});
	});

	describe('maintenance and session monitor surfaces', () => {
		it('gathers Oracle table statistics through the maintenance provider', async () => {
			const executedSql: string[] = [];
			const services = createMaintenanceServices(connection, config!, executedSql);
			const target = createMaintenanceTarget(config!, schemaName, tableName);

			await oracleMaintenanceProvider.generateStatistics!(target, services);

			expect(executedSql.some((sql) => sql.includes('DBMS_STATS.GATHER_TABLE_STATS'))).toBe(true);

			const statsRows = await readRows(
				connection,
				oracleDialect.advancedFeatures!.ddl!.buildTableStatsQuery(config!.database, schemaName, tableName),
			);
			expect(statsRows).toHaveLength(1);
			expect(statsRows[0].LAST_ANALYZED).toBeTruthy();
		}, 120000);

		it('analyzes a table through the maintenance provider', async () => {
			const executedSql: string[] = [];
			const services = createMaintenanceServices(connection, config!, executedSql);
			const target = createMaintenanceTarget(config!, schemaName, tableName);

			await oracleMaintenanceProvider.analyzeTable!(target, services);

			expect(executedSql.some((sql) => /ANALYZE\s+TABLE/i.test(sql))).toBe(true);
			expect(executedSql.some((sql) => sql.toUpperCase().includes(tableName))).toBe(true);
		}, 120000);

		it('moves a disposable table through vacuumTable without touching the main fixture', async () => {
			const moveTableName = `JBL_ORA_MV_${stamp}`;
			const qualifiedMoveTable = buildQualifiedName(schemaName, moveTableName);
			await connection
				.createCommand(
					`CREATE TABLE ${qualifiedMoveTable} (ID NUMBER PRIMARY KEY, NOTE VARCHAR2(40))`,
				)
				.execute();

			try {
				const executedSql: string[] = [];
				const services = createMaintenanceServices(connection, config!, executedSql);
				const target = createMaintenanceTarget(config!, schemaName, moveTableName);

				await oracleMaintenanceProvider.vacuumTable!(target, services);

				expect(executedSql.some((sql) => /ALTER\s+TABLE[\s\S]*\bMOVE\b/i.test(sql))).toBe(true);
				expect(executedSql.some((sql) => sql.toUpperCase().includes(moveTableName))).toBe(true);

				const controlRows = await readRows(
					connection,
					`SELECT COUNT(*) AS ROW_COUNT FROM ${qualifiedMoveTable}`,
				);
				expect(Number(controlRows[0].ROW_COUNT)).toBe(0);
			} finally {
				await tryExecute(connection, `DROP TABLE ${qualifiedMoveTable} PURGE`);
			}
		}, 180000);

		it('returns storage data through the Oracle session monitor provider', async () => {
			const provider = oracleDialect.advancedFeatures?.sessionMonitor;
			expect(provider).toBeDefined();

			const storage = await provider!.getStorage(
				{} as ExtensionContext,
				createMockConnectionManager(config!),
			);

			expect(Array.isArray(storage)).toBe(true);
			if (storage.length > 0) {
				expect(storage[0]).toHaveProperty('DATABASE');
				expect(storage[0]).toHaveProperty('USED_MB');
			}
		});

		it('lists sessions through the Oracle session monitor V$SESSION shape', async () => {
			// Query via the live connection (not runQueryRaw): silent variable resolution
			// treats V$SESSION / V$SQL as $SESSION / $SQL placeholders.
			try {
				const sessions = await readRows(
					connection,
					`
						SELECT
							s.SID AS "ID",
							s.SID AS "PID",
							s.USERNAME AS "USERNAME",
							NVL(SYS_CONTEXT('USERENV', 'CON_NAME'), SYS_CONTEXT('USERENV', 'DB_NAME')) AS "DBNAME",
							COALESCE(s.MODULE, s.PROGRAM, 'oracle') AS "TYPE",
							TO_CHAR(s.LOGON_TIME, 'YYYY-MM-DD HH24:MI:SS') AS "CONNTIME",
							s.STATUS AS "STATUS",
							SUBSTR(COALESCE(q.SQL_TEXT, s.EVENT, ''), 1, 200) AS "COMMAND",
							0 AS "PRIORITY",
							0 AS "CID",
							COALESCE(s.MACHINE, '') AS "IPADDR",
							COALESCE(s.OSUSER, '') AS "CLIENT_OS_USERNAME"
						FROM V$SESSION s
						LEFT JOIN V$SQL q ON q.SQL_ID = s.SQL_ID
						WHERE s.TYPE <> 'BACKGROUND'
						  AND s.USERNAME IS NOT NULL
						ORDER BY s.LOGON_TIME DESC
						FETCH FIRST 50 ROWS ONLY
					`,
				);

				expect(sessions.length).toBeGreaterThan(0);
				expect(sessions[0]).toHaveProperty('ID');
				expect(sessions[0]).toHaveProperty('USERNAME');
				expect(sessions[0]).toHaveProperty('STATUS');
				expect(
					sessions.some(
						(row) => String(row.USERNAME ?? '').toUpperCase() === config!.user.toUpperCase(),
					),
				).toBe(true);
			} catch (error: unknown) {
				if (isOraclePermissionOrMissingObjectError(error)) {
					console.warn(
						`Skipping Oracle getSessions assertion: ${error instanceof Error ? error.message : String(error)}`,
					);
					return;
				}
				throw error;
			}
		}, 60000);

		it('lists active queries when V$SQL is visible to the test user', async () => {
			try {
				const queries = await readRows(
					connection,
					`
						SELECT
							s.SID AS "QS_SESSIONID",
							0 AS "QS_PLANID",
							0 AS "QS_CLIENTID",
							COALESCE(s.MACHINE, '') AS "QS_CLIIPADDR",
							SUBSTR(COALESCE(q.SQL_TEXT, ''), 1, 300) AS "QS_SQL",
							COALESCE(s.STATUS, 'ACTIVE') AS "QS_STATE",
							s.USERNAME AS "USERNAME"
						FROM V$SESSION s
						LEFT JOIN V$SQL q ON q.SQL_ID = s.SQL_ID
						WHERE s.TYPE <> 'BACKGROUND'
						  AND s.USERNAME IS NOT NULL
						  AND s.STATUS = 'ACTIVE'
						  AND s.SQL_ID IS NOT NULL
						ORDER BY s.LAST_CALL_ET DESC
						FETCH FIRST 50 ROWS ONLY
					`,
				);

				expect(Array.isArray(queries)).toBe(true);
				if (queries.length > 0) {
					expect(queries[0]).toHaveProperty('QS_SESSIONID');
					expect(queries[0]).toHaveProperty('QS_SQL');
				}
			} catch (error: unknown) {
				if (isOraclePermissionOrMissingObjectError(error)) {
					console.warn(
						`Skipping Oracle getQueries assertion: ${error instanceof Error ? error.message : String(error)}`,
					);
					return;
				}
				throw error;
			}
		}, 60000);
	});

	describe('Oracle live completion (Netezza-quality E2E)', () => {
		it('completes columns for an alias against live ALL_TAB_COLUMNS metadata', async () => {
			const provider = new LiveOracleCompletionMetadataProvider(
				connection,
				config!.database,
				schemaName,
			);
			const engine = new LspCompletionEngine(provider);
			const { document, cursorOffset } = createDocumentWithCursor(
				`SELECT t.| FROM ${schemaName}.${tableName} t`,
			);
			const items = await engine.provideCompletionItems(
				document,
				document.positionAt(cursorOffset),
			);
			const labels = completionLabels(items).map((label) => label.toUpperCase());

			expect(provider.lookupRequests.length).toBeGreaterThan(0);
			expect(labels).toEqual(expect.arrayContaining(['ID', searchColumnName.toUpperCase()]));
		}, 120000);

		it('completes tables after schema dot from live catalog', async () => {
			const scopedSql = oracleMetadataProvider.buildListTablesQuery(config!.database, schemaName);
			expect(scopedSql.toUpperCase()).toMatch(/AND UPPER\(O\.OWNER\)\s*=\s*UPPER\('/i);

			const scopedRows = await readRows(connection, scopedSql);
			expect(
				scopedRows.some((row) => String(row.OBJNAME).toUpperCase() === tableName.toUpperCase()),
			).toBe(true);

			const foreignSchemaRows = await readRows(
				connection,
				oracleMetadataProvider.buildListTablesQuery(config!.database, 'SYS'),
			);
			expect(
				foreignSchemaRows.some(
					(row) => String(row.OBJNAME).toUpperCase() === tableName.toUpperCase(),
				),
			).toBe(false);

			const provider = new LiveOracleCompletionMetadataProvider(
				connection,
				config!.database,
				schemaName,
			);
			const engine = new LspCompletionEngine(provider);
			const { document, cursorOffset } = createDocumentWithCursor(
				`SELECT * FROM ${schemaName}.|`,
			);
			const items = await engine.provideCompletionItems(
				document,
				document.positionAt(cursorOffset),
			);
			const labels = completionLabels(items).map((label) => label.toUpperCase());

			expect(labels).toContain(tableName.toUpperCase());
		}, 120000);

		it('offers Oracle keywords and excludes Netezza-only GROOM', async () => {
			const provider = new LiveOracleCompletionMetadataProvider(
				connection,
				config!.database,
				schemaName,
			);
			const engine = new LspCompletionEngine(provider);
			const { document, cursorOffset } = createDocumentWithCursor('|');
			const items = await engine.provideCompletionItems(
				document,
				document.positionAt(cursorOffset),
			);
			const upperLabels = completionLabels(items).map((label) => label.toUpperCase());

			expect(upperLabels).toEqual(expect.arrayContaining(['DUAL', 'CONNECT BY']));
			expect(upperLabels).not.toContain('GROOM');
		}, 60000);
	});

	describe('Oracle live SQL quality', () => {
		it('runs ORA rules, strict parser rejects GROOM, and schema-aware unknown columns', async () => {
			const qualifiedTable = `${schemaName}.${tableName}`;
			const schemaProvider = await buildLiveOracleSchemaProvider(
				connection,
				config!,
				schemaName,
				tableName,
			);
			const qualityEngine = new SqlQualityEngine(
				new SqlValidator(schemaProvider, oracleSqlAuthoring.validation),
				oracleSqlAuthoring.qualityRules,
			);

			const selectStar = qualityEngine.analyze(`SELECT * FROM ${qualifiedTable}`);
			expect(selectStar.issues.map((issue) => issue.ruleId)).toContain('ORA001');

			const deleteAll = qualityEngine.analyze(`DELETE FROM ${qualifiedTable}`);
			expect(deleteAll.issues.map((issue) => issue.ruleId)).toContain('ORA002');

			const updateAll = qualityEngine.analyze(
				`UPDATE ${qualifiedTable} SET ${quoteIdentifier(searchColumnName)} = 'X'`,
			);
			expect(updateAll.issues.map((issue) => issue.ruleId)).toContain('ORA003');

			const rownumOrder = qualityEngine.analyze(
				`SELECT ID FROM ${qualifiedTable} WHERE ROWNUM <= 10 ORDER BY ID`,
			);
			expect(rownumOrder.issues.map((issue) => issue.ruleId)).toContain('ORA004');

			const groom = qualityEngine.analyze('GROOM TABLE sales VERSIONS;');
			expect(groom.parserResult.errors.length).toBeGreaterThan(0);

			const unknownColumn = qualityEngine.analyze(
				`SELECT BAD_COL_THAT_DOES_NOT_EXIST FROM ${qualifiedTable}`,
			);
			expect(
				unknownColumn.parserResult.errors.some((error) => error.code === 'SQL004'),
			).toBe(true);

			const plsql = qualityEngine.analyze(`
				DECLARE
					v_unused NUMBER;
				BEGIN
					SELECT ID FROM ${qualifiedTable};
				END;
			`);
			expect(plsql.parserResult.warnings.map((warning) => warning.code)).toEqual(
				expect.arrayContaining(['SQL037', 'SQL039']),
			);
		}, 120000);
	});

	describe('Oracle advanced DDL fixtures', () => {
		it('generates DDL for composite indexes and partitioned tables created on the live database', async () => {
			const advTableName = `JBL_ORA_ADV_${stamp}`;
			const advIndexName = `JBL_ORA_AIX_${stamp}`;
			const advPartName = `JBL_ORA_APT_${stamp}`;
			const qualifiedAdvTable = buildQualifiedName(schemaName, advTableName);
			const qualifiedAdvIndex = buildQualifiedName(schemaName, advIndexName);
			const qualifiedAdvPart = buildQualifiedName(schemaName, advPartName);
			const connectionDetails = toConnectionDetails(config!);
			const ddl = oracleDialect.advancedFeatures!.ddl!;

			await connection
				.createCommand(
					`
					CREATE TABLE ${qualifiedAdvTable} (
						ID NUMBER(10) NOT NULL,
						CODE VARCHAR2(40) NOT NULL,
						REGION VARCHAR2(20) NOT NULL,
						AMOUNT NUMBER(12,2),
						CONSTRAINT ${quoteIdentifier(`PK_${advTableName}`)} PRIMARY KEY (ID),
						CONSTRAINT ${quoteIdentifier(`UQ_${advTableName}`)} UNIQUE (CODE)
					)
					`,
				)
				.execute();
			await connection
				.createCommand(
					`COMMENT ON TABLE ${qualifiedAdvTable} IS 'JBL advanced DDL fixture ${stamp}'`,
				)
				.execute();
			await connection
				.createCommand(
					`CREATE INDEX ${qualifiedAdvIndex} ON ${qualifiedAdvTable} (REGION, AMOUNT)`,
				)
				.execute();
			await connection
				.createCommand(
					`
					CREATE TABLE ${qualifiedAdvPart} (
						ID NUMBER NOT NULL,
						EVENT_AT TIMESTAMP NOT NULL
					)
					PARTITION BY RANGE (EVENT_AT) (
						PARTITION P_OLD VALUES LESS THAN (TIMESTAMP '2027-01-01 00:00:00'),
						PARTITION P_MAX VALUES LESS THAN (MAXVALUE)
					)
					`,
				)
				.execute();

			try {
				const tableDdl = await ddl.generateTableDDL(
					connection,
					config!.database,
					schemaName,
					advTableName,
				);
				expect(tableDdl.toUpperCase()).toContain('CREATE TABLE');
				expect(tableDdl.toUpperCase()).toContain(advTableName);

				const indexResult = await ddl.generateDDL(
					connectionDetails,
					config!.database,
					schemaName,
					advIndexName,
					'INDEX',
				);
				expect(indexResult.success).toBe(true);
				expect(indexResult.ddlCode?.toUpperCase()).toContain('CREATE INDEX');
				expect(indexResult.ddlCode?.toUpperCase()).toContain(advIndexName);
				expect(indexResult.ddlCode?.toUpperCase()).toMatch(/REGION/);

				const partResult = await ddl.generateDDL(
					connectionDetails,
					config!.database,
					schemaName,
					advPartName,
					'TABLE',
				);
				expect(partResult.success).toBe(true);
				expect(partResult.ddlCode?.toUpperCase()).toContain('PARTITION BY');
				expect(partResult.ddlCode?.toUpperCase()).toContain(advPartName);

				const migration = await ddl.generateBatchDDL({
					connectionDetails,
					database: config!.database,
					schema: schemaName,
					objectTypes: ['TABLE'],
					mode: 'schema-migration',
					includeIndexes: true,
					includePartitions: true,
					includeGrants: false,
				});
				if (!migration.success) {
					throw new Error(migration.errors.join('\n'));
				}
				const migrationSql = migration.ddlCode?.toUpperCase() ?? '';
				expect(migrationSql).toContain(advTableName);
				expect(migrationSql).toContain(advIndexName);
				expect(migrationSql).toContain(advPartName);
				expect(migrationSql).toContain('CREATE INDEX');
				expect(migrationSql).toContain('PARTITION BY');
			} finally {
				await tryExecute(connection, `DROP INDEX ${qualifiedAdvIndex}`);
				await tryExecute(connection, `DROP TABLE ${qualifiedAdvPart} PURGE`);
				await tryExecute(connection, `DROP TABLE ${qualifiedAdvTable} PURGE`);
			}
		}, 180000);
	});
});
