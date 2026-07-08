import type { ConnectionDetails } from '../types';
import type { ImportColumnOptions, ImportResult, ProgressCallback } from './dataImporter';

export type SupportedImportDialect =
    | 'netezza'
    | 'db2'
    | 'postgresql'
    | 'vertica'
    | 'mssql'
    | 'snowflake'
    | 'oracle'
    | 'mysql'
    | 'duckdb'
    | 'sqlite'
    | 'unsupported';

export function resolveImportDialect(dbType?: string): SupportedImportDialect {
    const normalized = (dbType || '').trim().toLowerCase();
    if (!normalized || normalized === 'netezza') {
        return 'netezza';
    }
    if (normalized === 'db2') {
        return 'db2';
    }
    if (normalized === 'postgresql' || normalized === 'postgres') {
        return 'postgresql';
    }
    if (normalized === 'vertica' || normalized === 'verticadb') {
        return 'vertica';
    }
    if (normalized === 'mssql') {
        return 'mssql';
    }
    if (normalized === 'oracle') {
        return 'oracle';
    }
    if (normalized === 'mysql') {
        return 'mysql';
    }
    if (normalized === 'duckdb') {
        return 'duckdb';
    }
    if (normalized === 'sqlite' || normalized === 'sqlite3') {
        return 'sqlite';
    }
    if (normalized === 'snowflake') {
        return 'snowflake';
    }
    return 'unsupported';
}

export function getImportDialectLabel(dbType?: string): string {
    switch (resolveImportDialect(dbType)) {
        case 'db2':
            return 'Db2';
        case 'postgresql':
            return 'PostgreSQL';
        case 'netezza':
            return 'Netezza';
        case 'vertica':
            return 'Vertica';
        case 'mssql':
            return 'MS SQL Server';
        case 'snowflake':
            return 'Snowflake';
        case 'oracle':
            return 'Oracle';
        case 'mysql':
            return 'MySQL';
        case 'duckdb':
            return 'DuckDB';
        case 'sqlite':
            return 'SQLite';
        default:
            return 'database';
    }
}

function buildValidationError(message: string): ImportResult {
    return {
        success: false,
        message
    };
}

function validateImportConnection(connectionDetails?: ConnectionDetails): ImportResult | undefined {
    if (!connectionDetails || !connectionDetails.host) {
        return buildValidationError('Connection details are required.');
    }

    return undefined;
}

export async function importDataForConnection(
    filePath: string,
    targetTable: string,
    connectionDetails: ConnectionDetails,
    progressCallback?: ProgressCallback,
    timeoutSeconds?: number,
    columnOptions?: ImportColumnOptions
): Promise<ImportResult> {
    const connectionValidation = validateImportConnection(connectionDetails);
    if (connectionValidation) {
        return connectionValidation;
    }

    if (!filePath || !filePath.trim()) {
        return buildValidationError('Source file path is required.');
    }

    if (!targetTable || !targetTable.trim()) {
        return buildValidationError('Target table name is required.');
    }

    const normalizedFilePath = filePath.trim();
    const normalizedTargetTable = targetTable.trim();

    switch (resolveImportDialect(connectionDetails.dbType)) {
        case 'db2': {
            const { importDataToDb2 } = await import('./db2Importer');
            return importDataToDb2(
                normalizedFilePath,
                normalizedTargetTable,
                connectionDetails,
                progressCallback,
                timeoutSeconds,
                columnOptions
            );
        }
        case 'postgresql': {
            const { importDataToPostgreSql } = await import('./postgresqlImporter');
            return importDataToPostgreSql(
                normalizedFilePath,
                normalizedTargetTable,
                connectionDetails,
                progressCallback,
                timeoutSeconds,
                columnOptions
            );
        }
        case 'vertica': {
            const { importDataToVertica } = await import('./verticaImporter');
            return importDataToVertica(
                normalizedFilePath,
                normalizedTargetTable,
                connectionDetails,
                progressCallback,
                timeoutSeconds,
                columnOptions
            );
        }
        case 'netezza': {
            const { importDataToNetezza } = await import('./dataImporter');
            return importDataToNetezza(
                normalizedFilePath,
                normalizedTargetTable,
                connectionDetails,
                progressCallback,
                timeoutSeconds,
                columnOptions
            );
        }
        case 'mssql': {
            const { importDataToMsSql } = await import('./mssqlImporter');
            return importDataToMsSql(
                normalizedFilePath,
                normalizedTargetTable,
                connectionDetails,
                progressCallback,
                timeoutSeconds,
                columnOptions
            );
        }
        case 'oracle': {
            const { importDataToOracle } = await import('./oracleImporter');
            return importDataToOracle(
                normalizedFilePath,
                normalizedTargetTable,
                connectionDetails,
                progressCallback,
                timeoutSeconds,
                columnOptions
            );
        }
        case 'mysql': {
            const { importDataToMySql } = await import('./mysqlImporter');
            return importDataToMySql(
                normalizedFilePath,
                normalizedTargetTable,
                connectionDetails,
                progressCallback,
                timeoutSeconds,
                columnOptions
            );
        }
        case 'duckdb': {
            const { importDataToDuckDb } = await import('./duckdbImporter');
            return importDataToDuckDb(
                normalizedFilePath,
                normalizedTargetTable,
                connectionDetails,
                progressCallback,
                timeoutSeconds,
                columnOptions
            );
        }
        case 'sqlite': {
            const { importDataToSqlite } = await import('./sqliteImporter');
            return importDataToSqlite(
                normalizedFilePath,
                normalizedTargetTable,
                connectionDetails,
                progressCallback,
                timeoutSeconds,
                columnOptions
            );
        }
        case 'snowflake': {
            const { createSnowflakeStagedImportResult } = await import('../../extensions/snowflake/src/snowflakeImportPlanner');
            return createSnowflakeStagedImportResult(
                normalizedFilePath,
                normalizedTargetTable,
                columnOptions
            );
        }
        default:
            return {
                success: false,
                message: `Import is not supported for database kind "${connectionDetails.dbType || 'unknown'}".`
            };
    }
}

export async function importClipboardDataForConnection(
    targetTable: string,
    connectionDetails: ConnectionDetails,
    formatPreference?: string | null,
    options?: unknown,
    progressCallback?: ProgressCallback
): Promise<ImportResult> {
    const connectionValidation = validateImportConnection(connectionDetails);
    if (connectionValidation) {
        return connectionValidation;
    }

    if (!targetTable || !targetTable.trim()) {
        return buildValidationError('Target table name is required.');
    }

    const normalizedTargetTable = targetTable.trim();

    switch (resolveImportDialect(connectionDetails.dbType)) {
        case 'db2': {
            const { importClipboardDataToDb2 } = await import('./db2Importer');
            return importClipboardDataToDb2(
                normalizedTargetTable,
                connectionDetails,
                formatPreference,
                options,
                progressCallback
            );
        }
        case 'postgresql': {
            const { importClipboardDataToPostgreSql } = await import('./postgresqlImporter');
            return importClipboardDataToPostgreSql(
                normalizedTargetTable,
                connectionDetails,
                formatPreference,
                options,
                progressCallback
            );
        }
        case 'vertica': {
            const { importClipboardDataToVertica } = await import('./verticaImporter');
            return importClipboardDataToVertica(
                normalizedTargetTable,
                connectionDetails,
                formatPreference,
                options,
                progressCallback
            );
        }
        case 'netezza': {
            const { importClipboardDataToNetezza } = await import('./clipboardImporter');
            return importClipboardDataToNetezza(
                normalizedTargetTable,
                connectionDetails,
                formatPreference,
                options,
                progressCallback
            );
        }
        case 'mssql': {
            const { importClipboardDataToMsSql } = await import('./mssqlImporter');
            return importClipboardDataToMsSql(
                normalizedTargetTable,
                connectionDetails,
                formatPreference,
                options,
                progressCallback
            );
        }
        case 'oracle': {
            const { importClipboardDataToOracle } = await import('./oracleImporter');
            return importClipboardDataToOracle(
                normalizedTargetTable,
                connectionDetails,
                formatPreference,
                options,
                progressCallback
            );
        }
        case 'mysql': {
            const { importClipboardDataToMySql } = await import('./mysqlImporter');
            return importClipboardDataToMySql(
                normalizedTargetTable,
                connectionDetails,
                formatPreference,
                options,
                progressCallback
            );
        }
        case 'duckdb': {
            const { importClipboardDataToDuckDb } = await import('./duckdbImporter');
            return importClipboardDataToDuckDb(
                normalizedTargetTable,
                connectionDetails,
                formatPreference,
                options,
                progressCallback
            );
        }
        case 'sqlite': {
            const { importClipboardDataToSqlite } = await import('./sqliteImporter');
            return importClipboardDataToSqlite(
                normalizedTargetTable,
                connectionDetails,
                formatPreference,
                options,
                progressCallback
            );
        }
        case 'snowflake': {
            const { createSnowflakeClipboardImportResult } = await import('../../extensions/snowflake/src/snowflakeImportPlanner');
            return createSnowflakeClipboardImportResult(normalizedTargetTable);
        }
        default:
            return {
                success: false,
                message: `Import is not supported for database kind "${connectionDetails.dbType || 'unknown'}".`
            };
    }
}
