import { afterAll, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import type { ExtensionContext } from 'vscode';
import { MsSqlConnection } from '../../../extensions/mssql/src/mssqlConnection';
import { mssqlDialect } from '../../../extensions/mssql/src/mssqlDialect';
import { mssqlMaintenanceProvider } from '../../../extensions/mssql/src/mssqlMaintenanceProvider';
import { mssqlMetadataProvider } from '../../../extensions/mssql/src/mssqlSchemaProvider';
import { importDataToMsSql } from '../../import/mssqlImporter';
import type {
	DatabaseConnectionConfig,
	DatabaseMaintenanceServices,
	DatabaseMaintenanceTarget,
} from '../../contracts/database';
import type { ConnectionManager } from '../../core/connectionManager';
import type { ConnectionDetails } from '../../types';
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
});
