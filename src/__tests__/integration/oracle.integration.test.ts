import { afterAll, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { ExtensionContext } from 'vscode';
import { OracleConnection } from '../../../extensions/oracle/src/oracleConnection';
import { oracleDialect } from '../../../extensions/oracle/src/oracleDialect';
import { oracleMaintenanceProvider } from '../../../extensions/oracle/src/oracleMaintenanceProvider';
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
				});
				expect(fs.readFileSync(csvPath, 'utf8')).toContain('hex:ABCD');
				expect(fs.readFileSync(jsonPath, 'utf8')).toContain('hex:');

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
