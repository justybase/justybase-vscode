import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import type { ExtensionContext } from 'vscode';
import { VerticaConnection } from '../../../extensions/vertica/src/verticaConnection';
import { verticaDialect } from '../../../extensions/vertica/src/verticaDialect';
import { verticaMaintenanceProvider } from '../../../extensions/vertica/src/verticaMaintenanceProvider';
import { verticaMetadataProvider } from '../../../extensions/vertica/src/verticaSchemaProvider';
import type {
	DatabaseConnectionConfig,
	DatabaseMaintenanceServices,
	DatabaseMaintenanceTarget,
} from '../../contracts/database';
import type { ConnectionManager } from '../../core/connectionManager';
import type { ConnectionDetails } from '../../types';
import { registerLiveIntegrationSuite, verticaHarness } from './optionalDialectIntegrationHarness';

registerLiveIntegrationSuite(verticaHarness);

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
		dbType: 'vertica',
	};
}

async function readRows(
	connection: VerticaConnection,
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

async function tryExecute(connection: VerticaConnection, sql: string): Promise<void> {
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
		connectionName: 'vertica-live-test',
		databaseName: config.database,
		schemaName,
		tableName,
		qualifiedName: `${schemaName}.${tableName}`,
	};
}

function createMaintenanceServices(
	connection: VerticaConnection,
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
		getActiveConnectionName: () => 'vertica-live-test',
		getConnection: async () => toConnectionDetails(config),
	} as unknown as ConnectionManager;
}

const config = verticaHarness.config;
const describeIfConfigured = config ? describe : describe.skip;

describeIfConfigured('vertica integration', () => {
	let connection: VerticaConnection;

	const stamp = `${Date.now().toString(36).slice(-6)}${Math.random().toString(36).slice(2, 6)}`;
	const tableName = `jbl_vertica_t_${stamp}`;
	const viewName = `jbl_vertica_v_${stamp}`;
	const searchColumnName = `jbl_vc_${stamp}`;
	const sourceMarker = `JBL_VERTICA_SOURCE_${stamp.toUpperCase()}`;
	const tableComment = `JBL Vertica comment ${stamp}`;
	let schemaName = 'public';

	beforeAll(async () => {
		connection = verticaHarness.createConnection(config!) as VerticaConnection;
		await connection.connect();

		schemaName = connection.getCurrentSchema();

		const qualifiedTableName = buildQualifiedName(schemaName, tableName);
		const qualifiedViewName = buildQualifiedName(schemaName, viewName);

		await connection.createCommand(`
			CREATE TABLE ${qualifiedTableName} (
				id INTEGER NOT NULL PRIMARY KEY,
				${quoteIdentifier(searchColumnName)} VARCHAR(100) NOT NULL UNIQUE,
				created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
			)
		`).execute();

		await connection.createCommand(`
			INSERT INTO ${qualifiedTableName} (id, ${quoteIdentifier(searchColumnName)})
			SELECT 1, 'Alice'
			UNION ALL
			SELECT 2, 'Bob'
		`).execute();

		await connection.createCommand(
			`COMMENT ON TABLE ${qualifiedTableName} IS '${tableComment.replace(/'/g, "''")}'`,
		).execute();

		await connection.createCommand(`
			CREATE VIEW ${qualifiedViewName} AS
			SELECT
				id,
				${quoteIdentifier(searchColumnName)} AS customer_name,
				'${sourceMarker}' AS source_marker
			FROM ${qualifiedTableName}
		`).execute();
	}, 120000);

	afterAll(async () => {
		await tryExecute(connection, `DROP VIEW IF EXISTS ${buildQualifiedName(schemaName, viewName)}`);
		await tryExecute(connection, `DROP TABLE IF EXISTS ${buildQualifiedName(schemaName, tableName)}`);
		await connection.close();
	});

	describe('connection and metadata discovery', () => {
		it('returns current database and schema context', async () => {
			const rows = await readRows(
				connection,
				'SELECT CURRENT_DATABASE() AS DATABASE_NAME, CURRENT_SCHEMA() AS SCHEMA_NAME',
			);

			expect(rows).toHaveLength(1);
			expect(String(rows[0].DATABASE_NAME ?? '').length).toBeGreaterThan(0);
			expect(String(rows[0].SCHEMA_NAME ?? '').length).toBeGreaterThan(0);
		});

		it('lists schemas, tables, views, and procedures through the Vertica metadata provider', async () => {
			const schemas = await readRows(connection, verticaMetadataProvider.buildListSchemasQuery(config!.database));
			expect(schemas.some((row) => String(row.SCHEMA).toLowerCase() === schemaName.toLowerCase())).toBe(true);

			const tables = await readRows(connection, verticaMetadataProvider.buildListTablesQuery(config!.database, schemaName));
			expect(
				tables.some((row) => String(row.OBJNAME).toLowerCase() === tableName.toLowerCase()),
			).toBe(true);

			const views = await readRows(connection, verticaMetadataProvider.buildListViewsQuery(config!.database, schemaName));
			expect(
				views.some((row) => String(row.OBJNAME).toLowerCase() === viewName.toLowerCase()),
			).toBe(true);

			const procedures = await readRows(connection, verticaMetadataProvider.buildListProceduresQuery(config!.database, schemaName));
			expect(Array.isArray(procedures)).toBe(true);
		});

		it('finds created objects and view source text through Vertica-specific search queries', async () => {
			const objectRows = await readRows(
				connection,
				verticaMetadataProvider.buildObjectSearchQuery(config!.database, buildLikePattern(tableName)),
			);
			expect(
				objectRows.some(
					(row) => String(row.NAME).toLowerCase() === tableName.toLowerCase() && String(row.TYPE).toUpperCase() === 'TABLE',
				),
			).toBe(true);

			const columnRows = await readRows(
				connection,
				verticaMetadataProvider.buildObjectSearchQuery(config!.database, buildLikePattern(searchColumnName)),
			);
			expect(
				columnRows.some(
					(row) => String(row.NAME).toLowerCase() === searchColumnName.toLowerCase() && String(row.PARENT).toLowerCase() === tableName.toLowerCase(),
				),
			).toBe(true);

			const viewSourceRows = await readRows(
				connection,
				verticaMetadataProvider.buildViewSourceSearchQuery(config!.database, {
					rawTerm: sourceMarker,
					likePattern: buildLikePattern(sourceMarker),
					useServerSideFilter: true,
				}),
			);
			expect(
				viewSourceRows.some((row) => String(row.NAME).toLowerCase() === viewName.toLowerCase()),
			).toBe(true);
		});
	});

	describe('DDL, maintenance, and session monitor surfaces', () => {
		it('retrieves columns, keys, comment, and owner metadata for a live table', async () => {
			const ddl = verticaDialect.advancedFeatures!.ddl!;

			const columns = await ddl.getColumns(connection, config!.database, schemaName, tableName);
			expect(columns.map((column) => column.name.toLowerCase())).toEqual(
				expect.arrayContaining(['id', searchColumnName.toLowerCase(), 'created_at']),
			);

			const keysInfo = await ddl.getKeysInfo(connection, config!.database, schemaName, tableName);
			const primaryKey = [...keysInfo.values()].find((key) => key.typeChar.toUpperCase() === 'P');
			expect(primaryKey).toBeDefined();
			expect(primaryKey!.columns.map((column) => column.toLowerCase())).toContain('id');

			const comment = await ddl.getTableComment(connection, config!.database, schemaName, tableName);
			expect(comment).toBe(tableComment);

			const owner = await ddl.getTableOwner(connection, config!.database, schemaName, tableName);
			expect(typeof owner === 'string' || owner === null).toBe(true);
		});

		it('generates table and view DDL from live metadata', async () => {
			const ddl = verticaDialect.advancedFeatures!.ddl!;

			const tableDdl = await ddl.generateTableDDL(connection, config!.database, schemaName, tableName);
			expect(tableDdl).toContain('CREATE TABLE');
			expect(tableDdl.toLowerCase()).toContain(tableName.toLowerCase());

			const viewDdl = await ddl.generateViewDDL(connection, config!.database, schemaName, viewName);
			expect(viewDdl).toMatch(/CREATE\s+VIEW/i);
			expect(viewDdl).toContain(sourceMarker);
		});

		it('executes table stats and skew-check queries against live objects', async () => {
			const ddl = verticaDialect.advancedFeatures!.ddl!;

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

		it('runs analyze statistics and returns storage data through Vertica providers', async () => {
			const executedSql: string[] = [];
			const services = createMaintenanceServices(connection, config!, executedSql);
			const target = createMaintenanceTarget(config!, schemaName, tableName);

			await verticaMaintenanceProvider.generateStatistics!(target, services);

			expect(executedSql.some((sql) => sql.includes('ANALYZE_STATISTICS'))).toBe(true);

			const provider = verticaDialect.advancedFeatures?.sessionMonitor;
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
		}, 120000);
	});
});
