import { afterAll, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';

jest.unmock('chevrotain');

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import type { ExtensionContext } from 'vscode';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { MsSqlConnection } from '../../../extensions/mssql/src/mssqlConnection';
import { mssqlDialect } from '../../../extensions/mssql/src/mssqlDialect';
import { mssqlMaintenanceProvider } from '../../../extensions/mssql/src/mssqlMaintenanceProvider';
import { mssqlMetadataProvider } from '../../../extensions/mssql/src/mssqlSchemaProvider';
import { mssqlSqlAuthoring } from '../../../extensions/mssql/src/sql/authoring';
import { importDataToMsSql } from '../../import/mssqlImporter';
import { exportResultSetToFile } from '../../export/resultExporter';
import { cancelCommandAndCloseReader } from '../../core/cancellation';
import type {
	DatabaseConnectionConfig,
	DatabaseMaintenanceServices,
	DatabaseMaintenanceTarget,
} from '../../contracts/database';
import type { ConnectionManager } from '../../core/connectionManager';
import type { ConnectionDetails, ResultSet } from '../../types';
import type { MetadataColumnItem, MetadataObjectItem } from '../../lsp/protocol';
import { LspCompletionEngine, type CompletionMetadataProvider } from '../../server/completionEngine';
import { SqlQualityEngine } from '../../providers/sqlQualityEngine';
import { SqlValidator } from '../../sqlParser/validator';
import { InMemorySchemaProvider } from '../../sqlParser/schemaProvider';
import { mssqlHarness, registerLiveIntegrationSuite } from './optionalDialectIntegrationHarness';

registerLiveIntegrationSuite(mssqlHarness);

function quoteIdentifier(value: string): string {
	return `[${value.replace(/]/g, ']]')}]`;
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
		dbType: 'mssql',
	};
}

function createSmokeCsv(): { filePath: string; cleanup(): void } {
	const filePath = path.join(
		os.tmpdir(),
		`mssql-integration-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.csv`,
	);
	fs.writeFileSync(filePath, 'id,name\n1,Alice\n2,Bob\n', 'utf8');

	return {
		filePath,
		cleanup(): void {
			if (fs.existsSync(filePath)) {
				fs.unlinkSync(filePath);
			}
		},
	};
}

async function readRows(
	connection: MsSqlConnection,
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

async function readScalar(connection: MsSqlConnection, sql: string): Promise<unknown> {
	const reader = await connection.createCommand(sql).executeReader();
	try {
		expect(await reader.read()).toBe(true);
		return reader.getValue(0);
	} finally {
		await reader.close();
	}
}

async function tryExecute(connection: MsSqlConnection, sql: string): Promise<void> {
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
		connectionName: 'mssql-live-test',
		databaseName: config.database,
		schemaName,
		tableName,
		qualifiedName: `${config.database}.${schemaName}.${tableName}`,
	};
}

function createMaintenanceServices(
	connection: MsSqlConnection,
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
		getActiveConnectionName: () => 'mssql-live-test',
		getConnection: async () => toConnectionDetails(config),
	} as unknown as ConnectionManager;
}

const config = mssqlHarness.config;
const describeIfConfigured = config ? describe : describe.skip;
const showWarningMessage = vscode.window.showWarningMessage as unknown as jest.Mock;
const showInformationMessage = vscode.window.showInformationMessage as unknown as jest.Mock;

describeIfConfigured('mssql integration', () => {
	let connection: MsSqlConnection;

	const stamp = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
	const tableName = `jbl_mssql_table_${stamp}`;
	const viewName = `jbl_mssql_view_${stamp}`;
	const procedureName = `jbl_mssql_proc_${stamp}`;
	const importTableName = `jbl_mssql_import_${stamp}`;
	const searchColumnName = `jbl_mssql_col_${stamp}`;
	const sourceMarker = `JBL_MSSQL_SOURCE_${stamp.toUpperCase()}`;
	const tableComment = `JBL MSSQL COMMENT ${stamp}`;
	let schemaName = 'dbo';

	beforeAll(async () => {
		connection = mssqlHarness.createConnection(config!) as MsSqlConnection;
		await connection.connect();

		schemaName = connection.getCurrentSchemaName();

		const qualifiedTableName = buildQualifiedName(schemaName, tableName);
		const qualifiedViewName = buildQualifiedName(schemaName, viewName);
		const qualifiedProcedureName = buildQualifiedName(schemaName, procedureName);

		await connection.createCommand(`
			CREATE TABLE ${qualifiedTableName} (
				[id] INT NOT NULL PRIMARY KEY,
				${quoteIdentifier(searchColumnName)} NVARCHAR(100) NOT NULL UNIQUE,
				[created_at] DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()
			)
		`).execute();

		await connection.createCommand(`
			INSERT INTO ${qualifiedTableName} ([id], ${quoteIdentifier(searchColumnName)})
			VALUES (1, N'Alice'), (2, N'Bob')
		`).execute();

		await connection.createCommand(`
			EXEC sys.sp_addextendedproperty
				@name = N'MS_Description',
				@value = N'${tableComment.replace(/'/g, "''")}',
				@level0type = N'SCHEMA', @level0name = N'${schemaName.replace(/'/g, "''")}',
				@level1type = N'TABLE', @level1name = N'${tableName.replace(/'/g, "''")}';
		`).execute();

		await connection.createCommand(`
			CREATE VIEW ${qualifiedViewName} AS
			SELECT
				[id],
				${quoteIdentifier(searchColumnName)} AS [customer_name],
				'${sourceMarker}' AS [source_marker]
			FROM ${qualifiedTableName};
		`).execute();

		await connection.createCommand(`
			CREATE PROCEDURE ${qualifiedProcedureName}
			AS
			BEGIN
				SET NOCOUNT ON;
				SELECT '${sourceMarker}' AS [source_marker], COUNT(*) AS [row_count]
				FROM ${qualifiedTableName};
			END;
		`).execute();
	}, 120000);

	beforeEach(() => {
		showWarningMessage.mockReset();
		showInformationMessage.mockReset();
		showWarningMessage.mockImplementation(async (_message: unknown, _options: unknown, ...items: unknown[]) => items[0]);
		showInformationMessage.mockImplementation(async (_message: unknown, _options: unknown, ...items: unknown[]) => items[0]);
	});

	afterAll(async () => {
		if (!connection) {
			return;
		}

		await tryExecute(connection, `DROP PROCEDURE IF EXISTS ${buildQualifiedName(schemaName, procedureName)}`);
		await tryExecute(connection, `DROP VIEW IF EXISTS ${buildQualifiedName(schemaName, viewName)}`);
		await tryExecute(connection, `DROP TABLE IF EXISTS ${buildQualifiedName(schemaName, tableName)}`);
		await tryExecute(connection, `DROP TABLE IF EXISTS ${buildQualifiedName(schemaName, importTableName)}`);
		await connection.close();
	});

	describe('connection and metadata discovery', () => {
		it('returns current database, schema, and session context', async () => {
			const reader = await connection
				.createCommand('SELECT DB_NAME() AS CURRENT_CATALOG, SCHEMA_NAME() AS CURRENT_SCHEMA, @@SPID AS CURRENT_SID')
				.executeReader();
			try {
				expect(await reader.read()).toBe(true);
				expect(reader.getValue(0)).toBe(config!.database);
				expect(String(reader.getValue(1)).length).toBeGreaterThan(0);
				expect(Number(reader.getValue(2))).toBeGreaterThan(0);
			} finally {
				await reader.close();
			}
		});

		it('lists schemas, tables, views, and procedures including created integration objects', async () => {
			const schemas = await readRows(
				connection,
				mssqlMetadataProvider.buildListSchemasQuery(config!.database),
			);
			expect(schemas.some((row) => row.SCHEMA === schemaName)).toBe(true);

			const tables = await readRows(
				connection,
				mssqlMetadataProvider.buildListTablesQuery(config!.database, schemaName),
			);
			expect(tables.some((row) => row.OBJNAME === tableName)).toBe(true);

			const views = await readRows(
				connection,
				mssqlMetadataProvider.buildListViewsQuery(config!.database, schemaName),
			);
			expect(views.some((row) => row.OBJNAME === viewName)).toBe(true);

			const procedures = await readRows(
				connection,
				mssqlMetadataProvider.buildListProceduresQuery(config!.database, schemaName),
			);
			expect(procedures.some((row) => row.OBJNAME === procedureName)).toBe(true);
		});

		it('finds created objects and source text through MSSQL-specific search queries', async () => {
			const objectRows = await readRows(
				connection,
				mssqlMetadataProvider.buildObjectSearchQuery(config!.database, buildLikePattern(tableName)),
			);
			expect(objectRows.some((row) => row.NAME === tableName && row.TYPE === 'TABLE')).toBe(true);

			const columnRows = await readRows(
				connection,
				mssqlMetadataProvider.buildObjectSearchQuery(config!.database, buildLikePattern(searchColumnName)),
			);
			expect(
				columnRows.some(
					(row) => row.NAME === searchColumnName && row.TYPE === 'COLUMN' && row.PARENT === tableName,
				),
			).toBe(true);

			const viewSourceRows = await readRows(
				connection,
				mssqlMetadataProvider.buildViewSourceSearchQuery(config!.database, {
					rawTerm: sourceMarker,
					likePattern: buildLikePattern(sourceMarker),
					useServerSideFilter: true,
				}),
			);
			expect(viewSourceRows.some((row) => row.NAME === viewName && row.TYPE === 'VIEW')).toBe(true);

			const procedureSourceRows = await readRows(
				connection,
				mssqlMetadataProvider.buildProcedureSourceSearchQuery(config!.database, {
					rawTerm: sourceMarker,
					likePattern: buildLikePattern(sourceMarker),
					useServerSideFilter: true,
				}),
			);
			expect(
				procedureSourceRows.some((row) => row.NAME === procedureName && row.TYPE === 'PROCEDURE'),
			).toBe(true);
		});
	});

	describe('DDL provider', () => {
		it('retrieves columns, keys, comment, and owner metadata for a live table', async () => {
			const ddl = mssqlDialect.advancedFeatures!.ddl!;

			const columns = await ddl.getColumns(connection, config!.database, schemaName, tableName);
			expect(columns.map((column) => column.name)).toEqual(
				expect.arrayContaining(['id', searchColumnName, 'created_at']),
			);

			const keysInfo = await ddl.getKeysInfo(connection, config!.database, schemaName, tableName);
			const primaryKey = [...keysInfo.values()].find((key) => key.typeChar === 'P');
			expect(primaryKey).toBeDefined();
			expect(primaryKey!.columns).toContain('id');

			const comment = await ddl.getTableComment(connection, config!.database, schemaName, tableName);
			expect(comment).toBe(tableComment);

			const owner = await ddl.getTableOwner(connection, config!.database, schemaName, tableName);
			expect(typeof owner === 'string' || owner === null).toBe(true);
		});

		it('generates table and view DDL from live metadata', async () => {
			const ddl = mssqlDialect.advancedFeatures!.ddl!;

			const tableDdl = await ddl.generateTableDDL(connection, config!.database, schemaName, tableName);
			expect(tableDdl).toContain(`CREATE TABLE ${buildQualifiedName(schemaName, tableName)}`);
			expect(tableDdl).toContain('PRIMARY KEY');
			expect(tableDdl).toContain(tableComment);

			const viewDdl = await ddl.generateViewDDL(connection, config!.database, schemaName, viewName);
			expect(viewDdl).toContain('CREATE VIEW');
			expect(viewDdl).toContain(viewName);
			expect(viewDdl).toContain(sourceMarker);
		});

		it('executes generated table statistics and skew-check queries against live objects', async () => {
			const ddl = mssqlDialect.advancedFeatures!.ddl!;

			const statsRows = await readRows(
				connection,
				ddl.buildTableStatsQuery(config!.database, schemaName, tableName),
			);
			expect(statsRows).toHaveLength(1);
			expect(Number(statsRows[0].ROW_COUNT)).toBe(2);

			const skewRows = await readRows(
				connection,
				ddl.buildSkewCheckQuery(buildQualifiedName(schemaName, tableName)),
			);
			expect(skewRows).toHaveLength(1);
			expect(Number(skewRows[0].ROW_COUNT)).toBe(2);
		});
	});

	describe('maintenance, import, and session monitor surfaces', () => {
		it('executes UPDATE STATISTICS and index rebuild through the maintenance provider', async () => {
			const executedSql: string[] = [];
			const services = createMaintenanceServices(connection, config!, executedSql);
			const target = createMaintenanceTarget(config!, schemaName, tableName);

			await mssqlMaintenanceProvider.generateStatistics!(target, services);
			await mssqlMaintenanceProvider.reindexTable!(target, services);

			expect(executedSql.some((sql) => sql.includes('UPDATE STATISTICS'))).toBe(true);
			expect(executedSql.some((sql) => sql.includes('ALTER INDEX ALL'))).toBe(true);
		});

		it('imports a small CSV file into the configured SQL Server database', async () => {
			const sourceFile = createSmokeCsv();
			try {
				const result = await importDataToMsSql(
					sourceFile.filePath,
					importTableName,
					toConnectionDetails(config!),
				);
				expect(result.success).toBe(true);
				expect(result.details?.rowsInserted).toBe(2);

				const importedRowCount = await readScalar(
					connection,
					`SELECT COUNT(*) AS ROW_COUNT FROM ${buildQualifiedName(schemaName, importTableName)}`,
				);
				expect(Number(importedRowCount)).toBe(2);
			} finally {
				await tryExecute(connection, `DROP TABLE IF EXISTS ${buildQualifiedName(schemaName, importTableName)}`);
				sourceFile.cleanup();
			}
		}, 120000);

		it('returns storage data through the MSSQL session monitor provider', async () => {
			const provider = mssqlDialect.advancedFeatures?.sessionMonitor;
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
	});

	describe('streaming cancel, import/export round-trip', () => {
		it('cancels a large fetch and keeps the MSSQL session usable', async () => {
			const command = connection.createCommand(`
				WITH n AS (
					SELECT 1 AS id
					UNION ALL
					SELECT id + 1 FROM n WHERE id < 500000
				)
				SELECT id FROM n OPTION (MAXRECURSION 0)
			`);
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

			await new Promise((resolve) => setTimeout(resolve, 50));
			const cleanup = await cancelCommandAndCloseReader(command, reader, { timeoutMs: 5_000 });
			await Promise.race([
				fetchPromise,
				new Promise<void>((_, reject) =>
					setTimeout(() => reject(new Error('MSSQL fetch did not stop after cancel')), 5_000),
				),
			]);

			expect(cleanup.timedOut).toBe(false);
			expect(fetchedRows).toBeGreaterThanOrEqual(0);
			if (fetchError) {
				expect(String(fetchError)).toMatch(/cancel|abort|closed/i);
			}

			const controlRows = await readRows(connection, 'SELECT 1 AS CONTROL_VALUE');
			expect(Number(controlRows[0].CONTROL_VALUE)).toBe(1);
		}, 120000);

		it('round-trips typed CSV import and exports reusable SQL/CSV', async () => {
			const connectionDetails = toConnectionDetails(config!);
			const typedTable = `jbl_mssql_typed_${stamp}`;
			const exportTable = `jbl_mssql_exp_${stamp}`;
			const fixturePath = path.join(os.tmpdir(), `${typedTable}.csv`);
			const csvOut = path.join(os.tmpdir(), `${exportTable}.csv`);
			const sqlOut = path.join(os.tmpdir(), `${exportTable}.sql`);

			fs.writeFileSync(
				fixturePath,
				'id,flag,amount,name,created_at,guid_col\n'
					+ '1,1,12.34,Alice,2024-02-01 10:20:30,aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee\n'
					+ '2,0,56.78,Bob,2024-03-04 11:22:33,11111111-2222-3333-4444-555555555555\n',
				'utf8',
			);

			try {
				const importResult = await importDataToMsSql(
					fixturePath,
					typedTable,
					connectionDetails,
					undefined,
					undefined,
					{
						forcedColumnTypes: {
							0: 'INT',
							1: 'BIT',
							2: 'DECIMAL(12,2)',
							3: 'NVARCHAR(100)',
							4: 'DATETIME2',
							5: 'UNIQUEIDENTIFIER',
						},
					},
				);
				expect(importResult.success).toBe(true);
				expect(importResult.details?.rowsInserted).toBe(2);

				const imported = await readRows(
					connection,
					`SELECT id, flag, amount, name, CONVERT(VARCHAR(36), guid_col) AS guid_text FROM ${buildQualifiedName(schemaName, typedTable)} ORDER BY id`,
				);
				expect(imported).toHaveLength(2);
				expect(Number(imported[0].flag)).toBe(1);
				expect(String(imported[0].name)).toBe('Alice');
				expect(String(imported[0].guid_text).toLowerCase()).toContain('aaaaaaaa');

				const resultSet = {
					columns: [
						{ name: 'id', type: 'INT' },
						{ name: 'flag', type: 'BIT' },
						{ name: 'amount', type: 'DECIMAL' },
						{ name: 'name', type: 'NVARCHAR' },
						{ name: 'guid_text', type: 'VARCHAR' },
					],
					data: imported.map((row) => [
						row.id,
						row.flag,
						row.amount,
						row.name,
						row.guid_text,
					]),
					rowCount: imported.length,
				} as unknown as ResultSet;

				await exportResultSetToFile(resultSet, csvOut, { format: 'csv' });
				await exportResultSetToFile(resultSet, sqlOut, {
					format: 'sql',
					sqlTargetTable: buildQualifiedName(schemaName, exportTable),
					sqlDialect: 'mssql',
				});
				expect(fs.readFileSync(csvOut, 'utf8')).toContain('Alice');
				expect(fs.readFileSync(sqlOut, 'utf8').toUpperCase()).toContain('INSERT');
			} finally {
				await tryExecute(connection, `DROP TABLE IF EXISTS ${buildQualifiedName(schemaName, typedTable)}`);
				await tryExecute(connection, `DROP TABLE IF EXISTS ${buildQualifiedName(schemaName, exportTable)}`);
				for (const filePath of [fixturePath, csvOut, sqlOut]) {
					if (fs.existsSync(filePath)) {
						fs.unlinkSync(filePath);
					}
				}
			}
		}, 180000);
	});

	describe('MSSQL live completion', () => {
		it('completes columns for an alias against live catalog metadata', async () => {
			const provider = new LiveMsSqlCompletionMetadataProvider(
				connection,
				config!.database,
				schemaName,
			);
			const engine = new LspCompletionEngine(provider);
			const { document, cursorOffset } = createDocumentWithCursor(
				`SELECT t.| FROM ${buildQualifiedName(schemaName, tableName)} t`,
			);
			const items = await engine.provideCompletionItems(
				document,
				document.positionAt(cursorOffset),
			);
			const labels = completionLabels(items).map((label) => label.toUpperCase());

			expect(provider.lookupRequests.length).toBeGreaterThan(0);
			expect(labels).toEqual(
				expect.arrayContaining(['ID', searchColumnName.toUpperCase()]),
			);
		}, 120000);

		it('offers MSSQL keywords and excludes Netezza-only GROOM', async () => {
			const provider = new LiveMsSqlCompletionMetadataProvider(
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

			expect(upperLabels).toEqual(expect.arrayContaining(['TOP', 'OUTPUT', 'CROSS APPLY']));
			expect(upperLabels).not.toContain('GROOM');
		}, 60000);
	});

	describe('MSSQL live SQL quality', () => {
		it('runs MSS* rules, rejects Netezza-only syntax, and schema-aware SQL004/SQL025', async () => {
			const qualifiedTable = buildQualifiedName(schemaName, tableName);
			const schemaProvider = await buildLiveMsSqlSchemaProvider(
				connection,
				config!,
				schemaName,
				tableName,
			);
			const qualityEngine = new SqlQualityEngine(
				new SqlValidator(schemaProvider, mssqlSqlAuthoring.validation),
				mssqlSqlAuthoring.qualityRules,
			);

			expect(
				qualityEngine.analyze(`SELECT * FROM ${qualifiedTable}`).issues.map((i) => i.ruleId),
			).toContain('MSS001');
			expect(
				qualityEngine.analyze(`DELETE FROM ${qualifiedTable}`).issues.map((i) => i.ruleId),
			).toContain('MSS002');
			expect(
				qualityEngine
					.analyze(`UPDATE ${qualifiedTable} SET ${quoteIdentifier(searchColumnName)} = N'X'`)
					.issues.map((i) => i.ruleId),
			).toContain('MSS003');

			const groom = qualityEngine.analyze('GROOM TABLE sales VERSIONS;');
			expect(groom.issues.map((i) => i.ruleId)).toContain('MSS004');
			expect(groom.parserResult.errors.length).toBeGreaterThan(0);

			const limit = qualityEngine.analyze(
				`SELECT ${quoteIdentifier(searchColumnName)} FROM ${qualifiedTable} LIMIT 5`,
			);
			expect(limit.issues.map((i) => i.ruleId)).toContain('MSS007');
			expect(limit.parserResult.errors.length).toBeGreaterThan(0);

			const doubleDot = qualityEngine.analyze('SELECT * FROM DB..TABLE');
			expect(doubleDot.issues.map((i) => i.ruleId)).toContain('MSS008');
			expect(doubleDot.parserResult.errors.length).toBeGreaterThan(0);

			const topOk = qualityEngine.analyze(
				`SELECT TOP 5 ${quoteIdentifier(searchColumnName)} FROM ${qualifiedTable} ORDER BY id`,
			);
			expect(topOk.parserResult.errors).toHaveLength(0);

			const unknownColumn = qualityEngine.analyze(
				`SELECT BAD_COL_THAT_DOES_NOT_EXIST FROM ${qualifiedTable}`,
			);
			expect(
				unknownColumn.parserResult.errors.some((error) => error.code === 'SQL004'),
			).toBe(true);

			const typeMismatch = qualityEngine.analyze(
				`SELECT id FROM ${qualifiedTable} WHERE id = 'not-a-number'`,
			);
			expect(
				typeMismatch.parserResult.warnings.some((warning) => warning.code === 'SQL025')
					|| typeMismatch.issues.some((issue) => issue.ruleId === 'SQL025'),
			).toBe(true);
		}, 120000);
	});
});

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
		document: TextDocument.create('file:///mssql-live-completion.sql', 'mssql', 1, sql),
		cursorOffset,
	};
}

function completionLabels(items: { label: string }[]): string[] {
	return items
		.map((item) => item.label)
		.filter((label) => label !== '* (Expand Columns)');
}

class LiveMsSqlCompletionMetadataProvider implements CompletionMetadataProvider {
	public readonly lookupRequests: Array<{
		database: string;
		table: string;
		schema?: string;
	}> = [];

	public constructor(
		private readonly connection: MsSqlConnection,
		private readonly database: string,
		private readonly schema: string,
	) {}

	public async getContext(_documentUri: string): Promise<{
		effectiveDatabase?: string;
		effectiveSchema?: string;
		databaseKind?: 'mssql';
	}> {
		return {
			effectiveDatabase: this.database,
			effectiveSchema: this.schema,
			databaseKind: 'mssql',
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
			mssqlMetadataProvider.buildListTablesQuery(this.database, schema ?? this.schema),
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
			mssqlMetadataProvider.buildListViewsQuery(this.database, schema ?? this.schema),
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
		schema?: string,
	): Promise<MetadataObjectItem[]> {
		const rows = await readRows(
			this.connection,
			mssqlMetadataProvider.buildListProceduresQuery(this.database, schema ?? this.schema),
		);
		const procedures: MetadataObjectItem[] = [];
		for (const row of rows) {
			const name = row.OBJNAME;
			if (typeof name === 'string' && name.trim().length > 0) {
				procedures.push({ name: name.trim(), detail: 'Procedure' });
			}
		}
		return procedures;
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
			mssqlMetadataProvider.buildTableColumnsQuery(
				this.database,
				schema ?? this.schema,
				table,
			),
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
				type: typeof type === 'string' && type.trim().length > 0 ? type : 'NVARCHAR',
			});
		}
		return columns;
	}
}

async function buildLiveMsSqlSchemaProvider(
	connection: MsSqlConnection,
	config: DatabaseConnectionConfig,
	schemaName: string,
	tableName: string,
): Promise<InMemorySchemaProvider> {
	const columns = await mssqlDialect.advancedFeatures!.ddl!.getColumns(
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
