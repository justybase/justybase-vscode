import { afterAll, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';

jest.unmock('chevrotain');

import type { ExtensionContext } from 'vscode';
import * as vscode from 'vscode';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { Db2Connection } from '../../../extensions/db2/src/db2Connection';
import { db2Dialect } from '../../../extensions/db2/src/db2Dialect';
import {
	buildDb2ExplainQuery,
	buildDb2ExplainRetrieveQuery,
	parseDb2ExplainJson,
	renderDb2ExplainPlan,
} from '../../../extensions/db2/src/db2ExplainParser';
import { db2MaintenanceProvider } from '../../../extensions/db2/src/db2MaintenanceProvider';
import { db2MetadataProvider } from '../../../extensions/db2/src/db2SchemaProvider';
import { db2SqlAuthoring } from '../../../extensions/db2/src/sql/authoring';
import type {
	DatabaseConnectionConfig,
	DatabaseMaintenanceServices,
	DatabaseMaintenanceTarget,
} from '../../contracts/database';
import type { ConnectionManager } from '../../core/connectionManager';
import type { MetadataColumnItem, MetadataObjectItem } from '../../lsp/protocol';
import { SqlQualityEngine } from '../../providers/sqlQualityEngine';
import { LspCompletionEngine, type CompletionMetadataProvider } from '../../server/completionEngine';
import { InMemorySchemaProvider } from '../../sqlParser/schemaProvider';
import { SqlValidator } from '../../sqlParser/validator';
import type { ConnectionDetails } from '../../types';
import { db2Harness, registerLiveIntegrationSuite } from './optionalDialectIntegrationHarness';

registerLiveIntegrationSuite(db2Harness);

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
		dbType: 'db2',
	};
}

async function readRows(
	connection: Db2Connection,
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

async function readScalar(connection: Db2Connection, sql: string): Promise<unknown> {
	const reader = await connection.createCommand(sql).executeReader();
	try {
		expect(await reader.read()).toBe(true);
		return reader.getValue(0);
	} finally {
		await reader.close();
	}
}

async function tryExecute(connection: Db2Connection, sql: string): Promise<void> {
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
		connectionName: 'db2-live-test',
		databaseName: config.database,
		schemaName,
		tableName,
		qualifiedName: `${schemaName}.${tableName}`,
	};
}

function createMaintenanceServices(
	connection: Db2Connection,
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
		getActiveConnectionName: () => 'db2-live-test',
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

/** Convert flat EXPLAIN_OPERATOR rows into nested JSON for parseDb2ExplainJson. */
function buildDb2ExplainTreeFromOperatorRows(
	rows: ReadonlyArray<Record<string, unknown>>,
): Record<string, unknown> {
	if (rows.length === 0) {
		throw new Error('EXPLAIN_OPERATOR returned no rows for the explained statement.');
	}

	type MutableNode = Record<string, unknown> & { children: MutableNode[] };
	const nodes: MutableNode[] = rows.map((row) => ({
		operator_type: toOptionalString(row.OPERATOR_TYPE) ?? 'Unknown',
		object_schema: toOptionalString(row.OBJECT_SCHEMA),
		object_name: toOptionalString(row.OBJECT_NAME),
		total_cost: toOptionalNumber(row.TOTAL_COST) ?? 0,
		estimated_rows: toOptionalNumber(row.STREAM_COUNT) ?? 0,
		ios_cost: toOptionalNumber(row.IO_COST),
		cpu_cost: toOptionalNumber(row.CPU_COST),
		children: [] as MutableNode[],
	}));

	const root = nodes[0];
	root.children = nodes.slice(1);
	return { plan: root };
}

function isDb2ExplainEnvironmentError(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	return /SQL0219N|SQL0551N|SQL0204N|SQL0443N|EXPLAIN_|explain table|does not exist|insufficient|not authorized|SYSINSTALLOBJECTS|undefined name/i.test(
		message,
	);
}

function isDb2MaintenanceEnvironmentError(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	return /SQL0551N|SQL0440N|SQL2048N|ADMIN_CMD|RUNSTATS|not authorized|insufficient|does not have the privilege/i.test(
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
		document: TextDocument.create('file:///db2-live-completion.sql', 'sql', 1, sql),
		cursorOffset,
	};
}

function completionLabels(items: { label: string }[]): string[] {
	return items
		.map((item) => item.label)
		.filter((label) => label !== '* (Expand Columns)');
}

class LiveDb2CompletionMetadataProvider implements CompletionMetadataProvider {
	public readonly lookupRequests: Array<{
		database: string;
		table: string;
		schema?: string;
	}> = [];

	public constructor(
		private readonly connection: Db2Connection,
		private readonly database: string,
		private readonly schema: string,
	) {}

	public async getContext(_documentUri: string): Promise<{
		effectiveDatabase?: string;
		effectiveSchema?: string;
		databaseKind?: 'db2';
	}> {
		return {
			effectiveDatabase: this.database,
			effectiveSchema: this.schema,
			databaseKind: 'db2',
		};
	}

	public async getDatabases(_documentUri: string): Promise<MetadataObjectItem[]> {
		return [{ name: this.database, detail: 'Database' }];
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
			// Always pass database + schema — never schema alone as the first arg.
			db2MetadataProvider.buildListTablesQuery(this.database, schema ?? this.schema),
		);
		const tables: MetadataObjectItem[] = [];
		for (const row of rows) {
			const name = row.OBJNAME;
			if (typeof name === 'string' && name.trim().length > 0) {
				tables.push({ name: name.trim(), detail: 'Table' });
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
			db2MetadataProvider.buildListViewsQuery(this.database, schema ?? this.schema),
		);
		const views: MetadataObjectItem[] = [];
		for (const row of rows) {
			const name = row.OBJNAME;
			if (typeof name === 'string' && name.trim().length > 0) {
				views.push({ name: name.trim(), detail: 'View' });
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
			db2MetadataProvider.buildLookupColumnsQuery({
				database: this.database,
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
				name: name.trim(),
				type: typeof type === 'string' && type.trim().length > 0 ? type : 'VARCHAR',
			});
		}
		return columns;
	}
}

async function buildLiveDb2SchemaProvider(
	connection: Db2Connection,
	config: DatabaseConnectionConfig,
	schemaName: string,
	tableName: string,
): Promise<InMemorySchemaProvider> {
	const columns = await db2Dialect.advancedFeatures!.ddl!.getColumns(
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

const config = db2Harness.config;
// Local runs are mandatory (fail if DB2_LIVE_TEST_* / ibm_db missing).
// GitHub Actions soft-skips when secrets are absent — do not set DB2_LIVE_TEST_REQUIRED there.
const isCi = process.env.CI === 'true' || process.env.GITHUB_ACTIONS === 'true';
const requireLive = isCi
	? process.env.DB2_LIVE_TEST_REQUIRED === 'true'
	: process.env.DB2_LIVE_TEST_REQUIRED !== 'false';
if (requireLive && !config) {
	throw new Error(
		'Db2 live integration requires DB2_LIVE_TEST_HOST, DB2_LIVE_TEST_DATABASE, '
			+ 'DB2_LIVE_TEST_USER and DB2_LIVE_TEST_PASSWORD (and a working ibm_db Node runtime). '
			+ 'Set DB2_LIVE_TEST_REQUIRED=false to soft-skip locally.',
	);
}
const describeIfConfigured = config ? describe : describe.skip;
const showWarningMessage = vscode.window.showWarningMessage as unknown as jest.Mock;
const showInformationMessage = vscode.window.showInformationMessage as unknown as jest.Mock;

describeIfConfigured('db2 integration', () => {
	let connection: Db2Connection;

	const stamp = `${Date.now().toString(36).slice(-6)}${Math.random().toString(36).slice(2, 6)}`.toUpperCase();
	const tableName = `JBL_DB2_T_${stamp}`;
	const viewName = `JBL_DB2_V_${stamp}`;
	const searchColumnName = `JBL_DC_${stamp}`;
	const sourceMarker = `JBL_DB2_SOURCE_${stamp}`;
	const tableComment = `JBL Db2 comment ${stamp}`;
	const advTableName = `JBL_DB2_ADV_${stamp}`;
	const advIndexName = `JBL_DB2_AIX_${stamp}`;
	const advPartName = `JBL_DB2_APT_${stamp}`;
	let schemaName = '';

	beforeAll(async () => {
		connection = db2Harness.createConnection(config!) as Db2Connection;
		await connection.connect();

		schemaName = String(await readScalar(connection, 'SELECT CURRENT SCHEMA FROM SYSIBM.SYSDUMMY1 WITH UR')).trim();

		const qualifiedTableName = buildQualifiedName(schemaName, tableName);
		const qualifiedViewName = buildQualifiedName(schemaName, viewName);

		await connection.createCommand(`
			CREATE TABLE ${qualifiedTableName} (
				ID INTEGER NOT NULL PRIMARY KEY,
				${quoteIdentifier(searchColumnName)} VARCHAR(100) NOT NULL UNIQUE,
				CREATED_AT TIMESTAMP NOT NULL WITH DEFAULT CURRENT TIMESTAMP
			)
		`).execute();

		await connection.createCommand(`
			INSERT INTO ${qualifiedTableName} (ID, ${quoteIdentifier(searchColumnName)})
			VALUES (1, 'Alice'), (2, 'Bob')
		`).execute();

		await connection.createCommand(
			`COMMENT ON TABLE ${qualifiedTableName} IS '${tableComment.replace(/'/g, "''")}'`,
		).execute();

		await connection.createCommand(`
			CREATE VIEW ${qualifiedViewName} AS
			SELECT
				ID,
				${quoteIdentifier(searchColumnName)} AS CUSTOMER_NAME,
				'${sourceMarker}' AS SOURCE_MARKER
			FROM ${qualifiedTableName}
		`).execute();
	}, 120000);

	beforeEach(() => {
		showWarningMessage.mockReset();
		showInformationMessage.mockReset();
		showWarningMessage.mockImplementation(async (_message: unknown, _options: unknown, ...items: unknown[]) => items[0]);
		showInformationMessage.mockImplementation(async (_message: unknown, _options: unknown, ...items: unknown[]) => items[0]);
	});

	afterAll(async () => {
		await tryExecute(connection, `DROP VIEW ${buildQualifiedName(schemaName, viewName)}`);
		await tryExecute(connection, `DROP TABLE ${buildQualifiedName(schemaName, tableName)}`);
		await tryExecute(connection, `DROP INDEX ${buildQualifiedName(schemaName, advIndexName)}`);
		await tryExecute(connection, `DROP TABLE ${buildQualifiedName(schemaName, advPartName)}`);
		await tryExecute(connection, `DROP TABLE ${buildQualifiedName(schemaName, advTableName)}`);
		await connection.close();
	});

	describe('connection and metadata discovery', () => {
		it('returns current database and schema context', async () => {
			const rows = await readRows(
				connection,
				'SELECT CURRENT SERVER AS CURRENT_CATALOG, CURRENT SCHEMA AS CURRENT_SCHEMA FROM SYSIBM.SYSDUMMY1 WITH UR',
			);

			expect(rows).toHaveLength(1);
			expect(String(rows[0].CURRENT_CATALOG ?? '').length).toBeGreaterThan(0);
			expect(String(rows[0].CURRENT_SCHEMA ?? '').trim()).toBe(schemaName);
		});

		it('lists schemas, tables, views, and procedures through the Db2 metadata provider', async () => {
			const schemas = await readRows(connection, db2MetadataProvider.buildListSchemasQuery(config!.database));
			expect(schemas.some((row) => String(row.SCHEMA).trim() === schemaName)).toBe(true);

			const tables = await readRows(connection, db2MetadataProvider.buildListTablesQuery(config!.database, schemaName));
			expect(tables.some((row) => String(row.OBJNAME).trim().toUpperCase() === tableName)).toBe(true);

			const views = await readRows(connection, db2MetadataProvider.buildListViewsQuery(config!.database, schemaName));
			expect(views.some((row) => String(row.OBJNAME).trim().toUpperCase() === viewName)).toBe(true);

			const procedures = await readRows(connection, db2MetadataProvider.buildListProceduresQuery(config!.database, schemaName));
			expect(Array.isArray(procedures)).toBe(true);
		});

		it('finds created objects and source text through Db2-specific search queries', async () => {
			const objectRows = await readRows(
				connection,
				db2MetadataProvider.buildObjectSearchQuery(config!.database, buildLikePattern(tableName)),
			);
			expect(
				objectRows.some(
					(row) => String(row.NAME).trim().toUpperCase() === tableName && String(row.TYPE).trim().toUpperCase() === 'TABLE',
				),
			).toBe(true);

			const columnRows = await readRows(
				connection,
				db2MetadataProvider.buildObjectSearchQuery(config!.database, buildLikePattern(searchColumnName)),
			);
			expect(
				columnRows.some(
					(row) => String(row.NAME).trim().toUpperCase() === searchColumnName && String(row.PARENT).trim().toUpperCase() === tableName,
				),
			).toBe(true);

			const viewSourceRows = await readRows(
				connection,
				db2MetadataProvider.buildViewSourceSearchQuery(config!.database, {
					rawTerm: sourceMarker,
					likePattern: buildLikePattern(sourceMarker),
					useServerSideFilter: false,
				}),
			);
			expect(
				viewSourceRows.some(
					(row) => String(row.NAME).trim().toUpperCase() === viewName && String(row.SOURCE ?? '').includes(sourceMarker),
				),
			).toBe(true);
		});
	});

	describe('DDL and session monitor surfaces', () => {
		it('retrieves columns, keys, comment, and owner metadata for a live table', async () => {
			const ddl = db2Dialect.advancedFeatures!.ddl!;

			const columns = await ddl.getColumns(connection, config!.database, schemaName, tableName);
			expect(columns.map((column) => column.name.toUpperCase())).toEqual(
				expect.arrayContaining(['ID', searchColumnName, 'CREATED_AT']),
			);

			const keysInfo = await ddl.getKeysInfo(connection, config!.database, schemaName, tableName);
			const primaryKey = [...keysInfo.values()].find((key) => key.typeChar === 'p');
			expect(primaryKey).toBeDefined();
			expect(primaryKey!.columns.map((column) => column.toUpperCase())).toContain('ID');

			const comment = await ddl.getTableComment(connection, config!.database, schemaName, tableName);
			expect(comment).toBe(tableComment);

			const owner = await ddl.getTableOwner(connection, config!.database, schemaName, tableName);
			expect(typeof owner === 'string' || owner === null).toBe(true);
		});

		it('generates table and view DDL from live metadata', async () => {
			const ddl = db2Dialect.advancedFeatures!.ddl!;

			const tableDdl = await ddl.generateTableDDL(connection, config!.database, schemaName, tableName);
			expect(tableDdl).toContain('CREATE TABLE');
			expect(tableDdl.toUpperCase()).toContain(tableName);

			const viewDdl = await ddl.generateViewDDL(connection, config!.database, schemaName, viewName);
			expect(viewDdl).toContain('CREATE VIEW');
			expect(viewDdl).toContain(sourceMarker);
		});

		it('executes table stats and skew-check queries against live objects', async () => {
			const ddl = db2Dialect.advancedFeatures!.ddl!;

			const statsRows = await readRows(
				connection,
				ddl.buildTableStatsQuery(config!.database, schemaName, tableName),
			);
			expect(statsRows).toHaveLength(1);
			expect(String(statsRows[0].TABNAME).trim().toUpperCase()).toBe(tableName);

			const skewRows = await readRows(
				connection,
				ddl.buildSkewCheckQuery(buildQualifiedName(schemaName, tableName)),
			);
			expect(skewRows).toHaveLength(1);
			expect(Number(skewRows[0].ROW_COUNT)).toBe(2);
		});

		it('returns storage data through the Db2 session monitor provider', async () => {
			const provider = db2Dialect.advancedFeatures?.sessionMonitor;
			expect(provider).toBeDefined();

			const storage = await provider!.getStorage(
				{} as ExtensionContext,
				createMockConnectionManager(config!),
			);

			expect(Array.isArray(storage)).toBe(true);
			if (storage.length > 0) {
				expect(storage[0]).toHaveProperty('DATABASE');
				expect(storage[0]).toHaveProperty('TABLE_COUNT');
			}
		});
	});

	describe('metadata scoped schema audit', () => {
		it('filters tables by schema only when buildListTablesQuery receives database + schema', async () => {
			const scopedSql = db2MetadataProvider.buildListTablesQuery(config!.database, schemaName);
			expect(scopedSql.toUpperCase()).toMatch(/AND\s+TABSCHEMA\s*=/);
			expect(scopedSql.toUpperCase()).toContain(schemaName.toUpperCase());

			const scopedRows = await readRows(connection, scopedSql);
			expect(
				scopedRows.some((row) => String(row.OBJNAME).trim().toUpperCase() === tableName),
			).toBe(true);

			// One-arg call passes schema as database; listTables ignores database and leaves schema unset,
			// so the TABSCHEMA equality filter is omitted. Always call with (database, schema).
			const unscopedSql = db2MetadataProvider.buildListTablesQuery(schemaName);
			expect(unscopedSql.toUpperCase()).not.toMatch(/AND\s+TABSCHEMA\s*=/);

			const foreignSchemaRows = await readRows(
				connection,
				db2MetadataProvider.buildListTablesQuery(config!.database, 'SYSIBM'),
			);
			expect(
				foreignSchemaRows.some(
					(row) => String(row.OBJNAME).trim().toUpperCase() === tableName,
				),
			).toBe(false);
		}, 120000);
	});

	describe('explain and tuning advisor', () => {
		it('runs EXPLAIN PLAN, parses the plan tree, and surfaces SELECT * tuning advice', async () => {
			const qualifiedTable = buildQualifiedName(schemaName, tableName);
			const explainedSql = `SELECT * FROM ${qualifiedTable} WHERE ID = 1`;
			const explainSql = buildDb2ExplainQuery(explainedSql);
			expect(explainSql).toContain('EXPLAIN PLAN FOR');

			try {
				await connection.createCommand(explainSql).execute();

				const planRows = await readRows(connection, buildDb2ExplainRetrieveQuery());
				expect(planRows.length).toBeGreaterThan(0);
				expect(planRows.some((row) => String(row.OPERATOR_TYPE ?? '').length > 0)).toBe(true);

				const explainEnvelope = buildDb2ExplainTreeFromOperatorRows(planRows);
				const explainPlanText = JSON.stringify(explainEnvelope);
				const parsed = parseDb2ExplainJson(explainPlanText);
				expect(parsed.root.operatorType.length).toBeGreaterThan(0);
				expect(renderDb2ExplainPlan(parsed)).toContain(parsed.root.operatorType);

				const tuningAdvisor = db2Dialect.advancedFeatures?.tuningAdvisor;
				expect(tuningAdvisor).toBeDefined();
				const report = tuningAdvisor!.analyze({
					sql: explainedSql,
					explainPlanText,
				});
				expect(report.recommendations.map((item) => item.id)).toEqual(
					expect.arrayContaining(['DB2TA-001']),
				);
			} catch (error: unknown) {
				if (isDb2ExplainEnvironmentError(error)) {
					console.warn(
						`Skipping Db2 EXPLAIN/tuning assertion: ${error instanceof Error ? error.message : String(error)}`,
					);
					// Still verify SELECT * tuning advice works when explain JSON is unavailable.
					const tuningAdvisor = db2Dialect.advancedFeatures?.tuningAdvisor;
					expect(tuningAdvisor).toBeDefined();
					const report = tuningAdvisor!.analyze({ sql: explainedSql });
					expect(report.recommendations.map((item) => item.id)).toContain('DB2TA-001');
					return;
				}
				throw error;
			}
		}, 120000);
	});

	describe('maintenance', () => {
		it('gathers Db2 table statistics through RUNSTATS via the maintenance provider', async () => {
			const executedSql: string[] = [];
			const services = createMaintenanceServices(connection, config!, executedSql);
			const target = createMaintenanceTarget(config!, schemaName, tableName);

			try {
				await db2MaintenanceProvider.generateStatistics!(target, services);

				expect(executedSql.some((sql) => /RUNSTATS|ADMIN_CMD/i.test(sql))).toBe(true);
				expect(executedSql.some((sql) => sql.toUpperCase().includes(tableName))).toBe(true);

				const statsRows = await readRows(
					connection,
					db2Dialect.advancedFeatures!.ddl!.buildTableStatsQuery(config!.database, schemaName, tableName),
				);
				expect(statsRows).toHaveLength(1);
				expect(String(statsRows[0].TABNAME).trim().toUpperCase()).toBe(tableName);
			} catch (error: unknown) {
				if (isDb2MaintenanceEnvironmentError(error)) {
					console.warn(
						`Skipping Db2 RUNSTATS assertion: ${error instanceof Error ? error.message : String(error)}`,
					);
					return;
				}
				throw error;
			}
		}, 120000);
	});

	describe('compatibility shims', () => {
		it('supports CURRENT SERVER, CURRENT SCHEMA, and SYSIBM.SYSDUMMY1', async () => {
			const rows = await readRows(
				connection,
				`
					SELECT
						CURRENT SERVER AS CURRENT_SERVER,
						CURRENT SCHEMA AS CURRENT_SCHEMA,
						1 AS DUMMY_VALUE
					FROM SYSIBM.SYSDUMMY1
					WITH UR
				`,
			);

			expect(rows).toHaveLength(1);
			expect(String(rows[0].CURRENT_SERVER ?? '').length).toBeGreaterThan(0);
			expect(String(rows[0].CURRENT_SCHEMA ?? '').trim()).toBe(schemaName);
			expect(Number(rows[0].DUMMY_VALUE)).toBe(1);
		});
	});

	describe('Db2 live completion (Oracle-parity E2E)', () => {
		it('completes columns for an alias against live SYSCAT.COLUMNS metadata', async () => {
			const provider = new LiveDb2CompletionMetadataProvider(
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
			const scopedSql = db2MetadataProvider.buildListTablesQuery(config!.database, schemaName);
			expect(scopedSql.toUpperCase()).toMatch(/AND\s+TABSCHEMA\s*=/);

			const scopedRows = await readRows(connection, scopedSql);
			expect(
				scopedRows.some((row) => String(row.OBJNAME).trim().toUpperCase() === tableName),
			).toBe(true);

			const provider = new LiveDb2CompletionMetadataProvider(
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

		it('offers Db2 keywords and excludes Netezza-only GROOM', async () => {
			const provider = new LiveDb2CompletionMetadataProvider(
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

			expect(upperLabels).toEqual(expect.arrayContaining(['FETCH FIRST', 'WITH UR']));
			expect(upperLabels).not.toContain('GROOM');
		}, 60000);
	});

	describe('Db2 live SQL quality', () => {
		it('runs DB200x, strict parser rejects Netezza-only syntax, and schema-aware SQL004/SQL025', async () => {
			const qualifiedTable = `${schemaName}.${tableName}`;
			const schemaProvider = await buildLiveDb2SchemaProvider(
				connection,
				config!,
				schemaName,
				tableName,
			);
			const qualityEngine = new SqlQualityEngine(
				new SqlValidator(schemaProvider, db2SqlAuthoring.validation),
				db2SqlAuthoring.qualityRules,
			);

			const selectStar = qualityEngine.analyze(`SELECT * FROM ${qualifiedTable}`);
			expect(selectStar.issues.map((issue) => issue.ruleId)).toContain('DB2001');

			const deleteAll = qualityEngine.analyze(`DELETE FROM ${qualifiedTable}`);
			expect(deleteAll.issues.map((issue) => issue.ruleId)).toContain('DB2002');

			const updateAll = qualityEngine.analyze(
				`UPDATE ${qualifiedTable} SET ${quoteIdentifier(searchColumnName)} = 'X'`,
			);
			expect(updateAll.issues.map((issue) => issue.ruleId)).toContain('DB2003');

			const groom = qualityEngine.analyze('GROOM TABLE sales VERSIONS;');
			expect(groom.issues.map((issue) => issue.ruleId)).toContain('DB2004');
			expect(groom.parserResult.errors.length).toBeGreaterThan(0);

			const distributeOn = qualityEngine.analyze(
				'CREATE TABLE t (a INT) DISTRIBUTE ON (a);',
			);
			expect(distributeOn.issues.map((issue) => issue.ruleId)).toContain('DB2005');

			const fetchWithoutOrder = qualityEngine.analyze(
				`SELECT ${quoteIdentifier(searchColumnName)} FROM ${qualifiedTable} FETCH FIRST 5 ROWS ONLY`,
			);
			expect(fetchWithoutOrder.issues.map((issue) => issue.ruleId)).toContain('DB2006');

			const limit = qualityEngine.analyze(
				`SELECT ${quoteIdentifier(searchColumnName)} FROM ${qualifiedTable} LIMIT 5`,
			);
			expect(limit.issues.map((issue) => issue.ruleId)).toContain('DB2007');
			expect(limit.parserResult.errors.length).toBeGreaterThan(0);

			const doubleDot = qualityEngine.analyze('SELECT * FROM DB..TABLE');
			expect(doubleDot.issues.map((issue) => issue.ruleId)).toContain('DB2008');
			expect(doubleDot.parserResult.errors.length).toBeGreaterThan(0);

			const withIsolation = qualityEngine.analyze(
				`SELECT ${quoteIdentifier(searchColumnName)} FROM ${qualifiedTable} ORDER BY ${quoteIdentifier(searchColumnName)} FETCH FIRST 5 ROWS ONLY OPTIMIZE FOR 5 ROWS WITH UR`,
			);
			expect(withIsolation.parserResult.errors).toHaveLength(0);

			const unknownColumn = qualityEngine.analyze(
				`SELECT BAD_COL_THAT_DOES_NOT_EXIST FROM ${qualifiedTable}`,
			);
			expect(
				unknownColumn.parserResult.errors.some((error) => error.code === 'SQL004'),
			).toBe(true);

			const typeMismatch = qualityEngine.analyze(
				`SELECT ID FROM ${qualifiedTable} WHERE ID = 'not-a-number'`,
			);
			expect(
				typeMismatch.parserResult.warnings.some((warning) => warning.code === 'SQL025')
					|| typeMismatch.issues.some((issue) => issue.ruleId === 'SQL025'),
			).toBe(true);
		}, 120000);
	});

	describe('Db2 advanced DDL fixtures', () => {
		it('generates DDL for composite indexes and partitioned tables created on the live database', async () => {
			const qualifiedAdvTable = buildQualifiedName(schemaName, advTableName);
			const qualifiedAdvIndex = buildQualifiedName(schemaName, advIndexName);
			const qualifiedAdvPart = buildQualifiedName(schemaName, advPartName);
			const ddl = db2Dialect.advancedFeatures!.ddl!;

			await connection
				.createCommand(
					`
					CREATE TABLE ${qualifiedAdvTable} (
						ID INTEGER NOT NULL,
						CODE VARCHAR(40) NOT NULL,
						REGION VARCHAR(20) NOT NULL,
						AMOUNT DECIMAL(12,2),
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

			let partitionCreated = false;
			try {
				await connection
					.createCommand(
						`
						CREATE TABLE ${qualifiedAdvPart} (
							ID INTEGER NOT NULL,
							EVENT_AT TIMESTAMP NOT NULL
						)
						PARTITION BY RANGE (EVENT_AT) (
							PARTITION P_OLD STARTING MINVALUE ENDING ('2027-01-01-00.00.00.000000'),
							PARTITION P_MAX STARTING ('2027-01-01-00.00.00.000000') ENDING MAXVALUE
						)
						`,
					)
					.execute();
				partitionCreated = true;
			} catch (error: unknown) {
				console.warn(
					`Skipping disposable partitioned-table create: ${error instanceof Error ? error.message : String(error)}`,
				);
			}

			try {
				const tableDdl = await ddl.generateTableDDL(
					connection,
					config!.database,
					schemaName,
					advTableName,
				);
				expect(tableDdl.toUpperCase()).toContain('CREATE TABLE');
				expect(tableDdl.toUpperCase()).toContain(advTableName);
				expect(tableDdl.toUpperCase()).toMatch(/REGION|AMOUNT|CREATE INDEX/);

				if (partitionCreated) {
					const partDdl = await ddl.generateTableDDL(
						connection,
						config!.database,
						schemaName,
						advPartName,
					);
					expect(partDdl.toUpperCase()).toContain(advPartName);
					expect(partDdl.toUpperCase()).toContain('PARTITION');
				}
			} finally {
				await tryExecute(connection, `DROP INDEX ${qualifiedAdvIndex}`);
				await tryExecute(connection, `DROP TABLE ${qualifiedAdvPart}`);
				await tryExecute(connection, `DROP TABLE ${qualifiedAdvTable}`);
			}
		}, 180000);
	});
});

const fixtureSchemaName = (process.env.DB2_LIVE_FIXTURE_SCHEMA?.trim() || 'JBL_LIVE').toUpperCase();

describeIfConfigured('db2 persistent live fixture', () => {
	let connection: Db2Connection;
	let fixtureAvailable = false;

	beforeAll(async () => {
		connection = db2Harness.createConnection(config!) as Db2Connection;
		await connection.connect();
		const rows = await readRows(
			connection,
			`SELECT COUNT(*) AS CNT FROM SYSCAT.SCHEMATA WHERE SCHEMANAME = '${fixtureSchemaName.replace(/'/g, "''")}'`,
		);
		fixtureAvailable = Number(rows[0]?.CNT ?? 0) > 0;
	}, 120000);

	afterAll(async () => {
		if (connection) {
			await connection.close();
		}
	});

	it('skips when JBL_LIVE fixture schema is not seeded', () => {
		if (!fixtureAvailable) {
			console.warn(
				`Skipping fixture tests: schema ${fixtureSchemaName} not found. Run npm run db2:seed-live-fixture -- --force`,
			);
		}
		expect(true).toBe(true);
	});

	it('lists fixture tables, views, aliases, and procedures via metadata provider', async () => {
		if (!fixtureAvailable) {
			return;
		}

		const tables = await readRows(
			connection,
			db2MetadataProvider.buildListTablesQuery(config!.database, fixtureSchemaName),
		);
		expect(tables.some((row) => String(row.OBJNAME).trim() === 'JBL_ORDERS')).toBe(true);
		expect(tables.some((row) => String(row.OBJNAME).trim() === 'JBL_ALIAS_CUSTOMERS')).toBe(true);

		const views = await readRows(
			connection,
			db2MetadataProvider.buildListViewsQuery(config!.database, fixtureSchemaName),
		);
		expect(views.some((row) => String(row.OBJNAME).trim() === 'JBL_V_EMP_DEPT')).toBe(true);

		const procedures = await readRows(
			connection,
			db2MetadataProvider.buildListProceduresQuery(config!.database, fixtureSchemaName),
		);
		expect(
			procedures.some(
				(row) =>
					String(row.PROCEDURE ?? row.OBJNAME ?? '')
						.trim()
						=== 'JBL_GET_CUSTOMER_ORDER_COUNT',
			),
		).toBe(true);
	});

	it('reads fixture row counts and employee hierarchy', async () => {
		if (!fixtureAvailable) {
			return;
		}

		const empCount = await readScalar(
			connection,
			`SELECT COUNT(*) FROM ${buildQualifiedName(fixtureSchemaName, 'JBL_EMPLOYEES')} WITH UR`,
		);
		expect(Number(empCount)).toBe(12);

		const jan = await readRows(
			connection,
			`SELECT EMP_ID, MANAGER_ID FROM ${buildQualifiedName(fixtureSchemaName, 'JBL_EMPLOYEES')} WHERE EMAIL = 'jan.kowalski@fixture.local' WITH UR`,
		);
		expect(jan).toHaveLength(1);
		expect(jan[0].MANAGER_ID).toBeNull();
	});

	it('generates DDL for partitioned sales fact table', async () => {
		if (!fixtureAvailable) {
			return;
		}

		const ddl = db2Dialect.advancedFeatures!.ddl!;
		const tableDdl = await ddl.generateTableDDL(
			connection,
			config!.database,
			fixtureSchemaName,
			'JBL_SALES_FACT',
		);
		expect(tableDdl.toUpperCase()).toContain('JBL_SALES_FACT');
		expect(tableDdl.toUpperCase()).toContain('PARTITION');
	});

	it('finds fixture view source marker through view search', async () => {
		if (!fixtureAvailable) {
			return;
		}

		const viewSourceRows = await readRows(
			connection,
			db2MetadataProvider.buildViewSourceSearchQuery(config!.database, {
				rawTerm: 'JBL_FIXTURE_ORDER_SUM_MARKER',
				likePattern: '%JBL_FIXTURE_ORDER_SUM_MARKER%',
				useServerSideFilter: false,
			}),
		);
		expect(
			viewSourceRows.some(
				(row) =>
					String(row.NAME).trim() === 'JBL_V_CUSTOMER_ORDER_SUM'
					&& String(row.SOURCE ?? '').includes('JBL_FIXTURE_ORDER_SUM_MARKER'),
			),
		).toBe(true);
	});
});
