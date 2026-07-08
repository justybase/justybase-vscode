import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import type { ExtensionContext } from 'vscode';
import { Db2Connection } from '../../../extensions/db2/src/db2Connection';
import { db2Dialect } from '../../../extensions/db2/src/db2Dialect';
import { db2MetadataProvider } from '../../../extensions/db2/src/db2SchemaProvider';
import type { DatabaseConnectionConfig } from '../../contracts/database';
import type { ConnectionManager } from '../../core/connectionManager';
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

function createMockConnectionManager(config: DatabaseConnectionConfig): ConnectionManager {
	return {
		getActiveConnectionName: () => 'db2-live-test',
		getConnection: async () => toConnectionDetails(config),
	} as unknown as ConnectionManager;
}

const config = db2Harness.config;
const describeIfConfigured = config ? describe : describe.skip;

describeIfConfigured('db2 integration', () => {
	let connection: Db2Connection;

	const stamp = `${Date.now().toString(36).slice(-6)}${Math.random().toString(36).slice(2, 6)}`.toUpperCase();
	const tableName = `JBL_DB2_T_${stamp}`;
	const viewName = `JBL_DB2_V_${stamp}`;
	const searchColumnName = `JBL_DC_${stamp}`;
	const sourceMarker = `JBL_DB2_SOURCE_${stamp}`;
	const tableComment = `JBL Db2 comment ${stamp}`;
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

	afterAll(async () => {
		await tryExecute(connection, `DROP VIEW ${buildQualifiedName(schemaName, viewName)}`);
		await tryExecute(connection, `DROP TABLE ${buildQualifiedName(schemaName, tableName)}`);
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
});
