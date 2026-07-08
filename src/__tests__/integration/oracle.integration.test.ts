import { afterAll, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import * as vscode from 'vscode';
import type { ExtensionContext } from 'vscode';
import { OracleConnection } from '../../../extensions/oracle/src/oracleConnection';
import { oracleDialect } from '../../../extensions/oracle/src/oracleDialect';
import { oracleMaintenanceProvider } from '../../../extensions/oracle/src/oracleMaintenanceProvider';
import { oracleMetadataProvider } from '../../../extensions/oracle/src/oracleSchemaProvider';
import type {
	DatabaseConnectionConfig,
	DatabaseMaintenanceServices,
	DatabaseMaintenanceTarget,
} from '../../contracts/database';
import type { ConnectionManager } from '../../core/connectionManager';
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

const config = oracleHarness.config;
const describeIfConfigured = config ? describe : describe.skip;
const showWarningMessage = vscode.window.showWarningMessage as unknown as jest.Mock;
const showInformationMessage = vscode.window.showInformationMessage as unknown as jest.Mock;

describeIfConfigured('oracle integration', () => {
	let connection: OracleConnection;

	const stamp = `${Date.now().toString(36).slice(-6)}${Math.random().toString(36).slice(2, 6)}`.toUpperCase();
	const tableName = `JBL_ORA_T_${stamp}`;
	const viewName = `JBL_ORA_V_${stamp}`;
	const procedureName = `JBL_ORA_P_${stamp}`;
	const searchColumnName = `JBL_OC_${stamp}`;
	const sourceMarker = `JBL_ORA_SOURCE_${stamp}`;
	const tableComment = `JBL Oracle comment ${stamp}`;
	let schemaName = '';

	beforeAll(async () => {
		connection = oracleHarness.createConnection(config!) as OracleConnection;
		await connection.connect();

		schemaName = connection.getCurrentSchema();

		const qualifiedTableName = buildQualifiedName(schemaName, tableName);
		const qualifiedViewName = buildQualifiedName(schemaName, viewName);
		const qualifiedProcedureName = buildQualifiedName(schemaName, procedureName);

		await connection.createCommand(`
			CREATE TABLE ${qualifiedTableName} (
				ID NUMBER(10) NOT NULL PRIMARY KEY,
				${quoteIdentifier(searchColumnName)} VARCHAR2(100) NOT NULL UNIQUE,
				CREATED_AT DATE DEFAULT SYSDATE NOT NULL
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
	}, 120000);

	beforeEach(() => {
		showWarningMessage.mockReset();
		showInformationMessage.mockReset();
		showWarningMessage.mockImplementation(async (_message: unknown, _options: unknown, ...items: unknown[]) => items[0]);
		showInformationMessage.mockImplementation(async (_message: unknown, _options: unknown, ...items: unknown[]) => items[0]);
	});

	afterAll(async () => {
		await tryExecute(connection, `DROP PROCEDURE ${buildQualifiedName(schemaName, procedureName)}`);
		await tryExecute(connection, `DROP VIEW ${buildQualifiedName(schemaName, viewName)}`);
		await tryExecute(connection, `DROP TABLE ${buildQualifiedName(schemaName, tableName)}`);
		await connection.close();
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
			const tables = await readRows(connection, oracleMetadataProvider.buildListTablesQuery(schemaName));
			expect(tables.some((row) => String(row.OBJNAME).toUpperCase() === tableName)).toBe(true);

			const views = await readRows(connection, oracleMetadataProvider.buildListViewsQuery(schemaName));
			expect(views.some((row) => String(row.OBJNAME).toUpperCase() === viewName)).toBe(true);

			const procedures = await readRows(
				connection,
				oracleMetadataProvider.buildListProceduresQuery(config!.database, schemaName),
			);
			expect(procedures.some((row) => String(row.PROCEDURE).toUpperCase() === procedureName)).toBe(true);
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

		it('executes the skew-check query against live objects', async () => {
			const ddl = oracleDialect.advancedFeatures!.ddl!;
			const rows = await readRows(
				connection,
				ddl.buildSkewCheckQuery(buildQualifiedName(schemaName, tableName)),
			);

			expect(rows).toHaveLength(1);
			expect(Number(rows[0].ROW_COUNT)).toBe(2);
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
	});
});
