/**
 * Schema/Object Comparer
 * Compares table structures and procedure definitions between environments
 */

import type { DatabaseDdlProvider } from '../contracts/database';
import {
    createConnectedDatabaseConnectionFromDetails,
    executeDatabaseQuery,
    getRequiredDatabaseDdlProvider
} from '../core/connectionFactory';

// ===============================
// Types
// ===============================

export interface ColumnInfo {
    name: string;
    description: string | null;
    fullTypeName: string;
    notNull: boolean;
    defaultValue: string | null;
}

export interface KeyInfo {
    type: string;
    typeChar: string;
    columns: string[];
    pkDatabase: string | null;
    pkSchema: string | null;
    pkRelation: string | null;
    pkColumns: string[];
    updateType: string;
    deleteType: string;
}

export interface TableMetadata {
    database: string;
    schema: string;
    tableName: string;
    columns: ColumnInfo[];
    keys: Map<string, KeyInfo>;
    distribution: string[];
    organization: string[];
}

export interface ProcedureMetadata {
    database: string;
    schema: string;
    procedureName: string;
    procedureSignature: string;
    arguments: string | null;
    returns: string;
    executeAsOwner: boolean;
    source: string;
    description: string | null;
}

export type DiffStatus = 'added' | 'removed' | 'modified' | 'unchanged';

export interface ColumnDiff {
    name: string;
    status: DiffStatus;
    sourceColumn?: ColumnInfo;
    targetColumn?: ColumnInfo;
    changes?: string[];
}

export interface KeyDiff {
    name: string;
    status: DiffStatus;
    sourceKey?: KeyInfo;
    targetKey?: KeyInfo;
    changes?: string[];
}

export interface TableComparisonResult {
    source: { database: string; schema: string; name: string };
    target: { database: string; schema: string; name: string };
    columnDiffs: ColumnDiff[];
    keyDiffs: KeyDiff[];
    distributionMatch: boolean;
    sourceDistribution: string[];
    targetDistribution: string[];
    organizationMatch: boolean;
    sourceOrganization: string[];
    targetOrganization: string[];
    summary: {
        columnsAdded: number;
        columnsRemoved: number;
        columnsModified: number;
        columnsUnchanged: number;
        keysAdded: number;
        keysRemoved: number;
        keysModified: number;
    };
}

export interface ProcedureComparisonResult {
    source: { database: string; schema: string; name: string };
    target: { database: string; schema: string; name: string };
    argumentsMatch: boolean;
    sourceArguments: string | null;
    targetArguments: string | null;
    returnsMatch: boolean;
    sourceReturns: string;
    targetReturns: string;
    executeAsOwnerMatch: boolean;
    sourceExecuteAsOwner: boolean;
    targetExecuteAsOwner: boolean;
    sourceMatch: boolean;
    sourceCode: string;
    targetCode: string;
    sourceDiff: string[]; // Line-by-line diff
}

// ===============================
// Helper Functions
// ===============================

/**
 * Execute query and return array of objects
 */
import { NzConnection, ConnectionDetails } from '../types';

/**
 * Execute query and return array of objects
 */
async function executeQueryHelper(connection: NzConnection, sql: string): Promise<Record<string, unknown>[]> {
    return await executeDatabaseQuery<Record<string, unknown>>(connection, sql);
}

/**
 * Parse connection string
 */
// ConnectionDetails imported from types - no parseConnectionString needed

// ===============================
// Table Comparison
// ===============================

/**
 * Get full table metadata for comparison
 */
async function getTableMetadata(
    connection: NzConnection,
    ddlProvider: DatabaseDdlProvider,
    database: string,
    schema: string,
    tableName: string
): Promise<TableMetadata> {
    // Run queries sequentially - Netezza connection doesn't support concurrent commands
    const columns = await ddlProvider.getColumns(connection, database, schema, tableName);
    const keys = await ddlProvider.getKeysInfo(connection, database, schema, tableName);
    const distribution = await ddlProvider.getDistributionInfo(connection, database, schema, tableName);
    const organization = await ddlProvider.getOrganizeInfo(connection, database, schema, tableName);

    return {
        database,
        schema,
        tableName,
        columns,
        keys,
        distribution,
        organization
    };
}

/**
 * Compare two columns and return differences
 */
function compareColumns(source: ColumnInfo, target: ColumnInfo): string[] {
    const changes: string[] = [];

    if (source.fullTypeName !== target.fullTypeName) {
        changes.push(`Type: ${source.fullTypeName} → ${target.fullTypeName}`);
    }
    if (source.notNull !== target.notNull) {
        changes.push(`NOT NULL: ${source.notNull} → ${target.notNull}`);
    }
    if (source.defaultValue !== target.defaultValue) {
        changes.push(`Default: ${source.defaultValue || 'NULL'} → ${target.defaultValue || 'NULL'}`);
    }

    return changes;
}

/**
 * Compare two keys and return differences
 */
function compareKeys(source: KeyInfo, target: KeyInfo): string[] {
    const changes: string[] = [];

    if (source.type !== target.type) {
        changes.push(`Type: ${source.type} → ${target.type}`);
    }
    if (source.columns.join(',') !== target.columns.join(',')) {
        changes.push(`Columns: (${source.columns.join(', ')}) → (${target.columns.join(', ')})`);
    }
    if (source.typeChar === 'f' && target.typeChar === 'f') {
        if (source.pkRelation !== target.pkRelation) {
            changes.push(`References: ${source.pkRelation} → ${target.pkRelation}`);
        }
    }

    return changes;
}

/**
 * Compare two table structures
 */
export async function compareTableStructures(
    connectionDetails: ConnectionDetails,
    sourceDb: string,
    sourceSchema: string,
    sourceTable: string,
    targetDb: string,
    targetSchema: string,
    targetTable: string
): Promise<TableComparisonResult> {
    let connection: NzConnection | null = null;
    const ddlProvider = getRequiredDatabaseDdlProvider(connectionDetails.dbType);

    try {
        connection = await createConnectedDatabaseConnectionFromDetails(connectionDetails) as NzConnection;

        // Get metadata for both tables sequentially
        const sourceMeta = await getTableMetadata(connection!, ddlProvider, sourceDb, sourceSchema, sourceTable);
        const targetMeta = await getTableMetadata(connection!, ddlProvider, targetDb, targetSchema, targetTable);

        // Compare columns
        const columnDiffs: ColumnDiff[] = [];
        const sourceColMap = new Map(sourceMeta.columns.map(c => [c.name.toUpperCase(), c]));
        const targetColMap = new Map(targetMeta.columns.map(c => [c.name.toUpperCase(), c]));

        // Check source columns
        for (const [name, sourceCol] of sourceColMap) {
            const targetCol = targetColMap.get(name);
            if (!targetCol) {
                columnDiffs.push({
                    name: sourceCol.name,
                    status: 'removed',
                    sourceColumn: sourceCol
                });
            } else {
                const changes = compareColumns(sourceCol, targetCol);
                columnDiffs.push({
                    name: sourceCol.name,
                    status: changes.length > 0 ? 'modified' : 'unchanged',
                    sourceColumn: sourceCol,
                    targetColumn: targetCol,
                    changes
                });
            }
        }

        // Check for added columns in target
        for (const [name, targetCol] of targetColMap) {
            if (!sourceColMap.has(name)) {
                columnDiffs.push({
                    name: targetCol.name,
                    status: 'added',
                    targetColumn: targetCol
                });
            }
        }

        // Compare keys
        const keyDiffs: KeyDiff[] = [];
        const sourceKeyMap = sourceMeta.keys;
        const targetKeyMap = targetMeta.keys;

        for (const [name, sourceKey] of sourceKeyMap) {
            const targetKey = targetKeyMap.get(name);
            if (!targetKey) {
                keyDiffs.push({
                    name,
                    status: 'removed',
                    sourceKey
                });
            } else {
                const changes = compareKeys(sourceKey, targetKey);
                keyDiffs.push({
                    name,
                    status: changes.length > 0 ? 'modified' : 'unchanged',
                    sourceKey,
                    targetKey,
                    changes
                });
            }
        }

        for (const [name, targetKey] of targetKeyMap) {
            if (!sourceKeyMap.has(name)) {
                keyDiffs.push({
                    name,
                    status: 'added',
                    targetKey
                });
            }
        }

        // Compare distribution and organization
        const distributionMatch = JSON.stringify(sourceMeta.distribution) === JSON.stringify(targetMeta.distribution);
        const organizationMatch = JSON.stringify(sourceMeta.organization) === JSON.stringify(targetMeta.organization);

        // Calculate summary
        const summary = {
            columnsAdded: columnDiffs.filter(d => d.status === 'added').length,
            columnsRemoved: columnDiffs.filter(d => d.status === 'removed').length,
            columnsModified: columnDiffs.filter(d => d.status === 'modified').length,
            columnsUnchanged: columnDiffs.filter(d => d.status === 'unchanged').length,
            keysAdded: keyDiffs.filter(d => d.status === 'added').length,
            keysRemoved: keyDiffs.filter(d => d.status === 'removed').length,
            keysModified: keyDiffs.filter(d => d.status === 'modified').length
        };

        return {
            source: { database: sourceDb, schema: sourceSchema, name: sourceTable },
            target: { database: targetDb, schema: targetSchema, name: targetTable },
            columnDiffs,
            keyDiffs,
            distributionMatch,
            sourceDistribution: sourceMeta.distribution,
            targetDistribution: targetMeta.distribution,
            organizationMatch,
            sourceOrganization: sourceMeta.organization,
            targetOrganization: targetMeta.organization,
            summary
        };
    } finally {
        if (connection) {
            try {
                await connection.close();
            } catch {
                // Ignore close errors
            }
        }
    }
}

// ===============================
// Procedure Comparison
// ===============================

/**
 * Get procedure metadata for comparison
 */
async function getProcedureMetadata(
    connection: NzConnection,
    database: string,
    schema: string,
    procSignature: string
): Promise<ProcedureMetadata> {
    const sql = `
        SELECT 
            SCHEMA,
            PROCEDURESOURCE,
            RETURNS,
            EXECUTEDASOWNER,
            DESCRIPTION,
            PROCEDURESIGNATURE,
            PROCEDURE,
            ARGUMENTS
        FROM ${database.toUpperCase()}.._V_PROCEDURE
        WHERE DATABASE = '${database.toUpperCase()}'
            AND SCHEMA = '${schema.toUpperCase()}'
            AND PROCEDURESIGNATURE = '${procSignature.toUpperCase()}'
    `;

    const result = await executeQueryHelper(connection, sql);

    if (result.length === 0) {
        throw new Error(`Procedure ${database}.${schema}.${procSignature} not found`);
    }

    const row = result[0] as {
        PROCEDURE: string;
        PROCEDURESIGNATURE: string;
        ARGUMENTS: string;
        RETURNS: string;
        EXECUTEDASOWNER: number;
        PROCEDURESOURCE: string;
        DESCRIPTION: string;
    };
    return {
        database,
        schema,
        procedureName: row.PROCEDURE,
        procedureSignature: row.PROCEDURESIGNATURE,
        arguments: row.ARGUMENTS || null,
        returns: row.RETURNS,
        executeAsOwner: Boolean(row.EXECUTEDASOWNER),
        source: row.PROCEDURESOURCE,
        description: row.DESCRIPTION || null
    };
}

/**
 * Simple line-by-line diff for procedure source code
 */
function computeLineDiff(sourceCode: string, targetCode: string): string[] {
    const sourceLines = sourceCode.split('\n').map(l => l.trimEnd());
    const targetLines = targetCode.split('\n').map(l => l.trimEnd());
    const diff: string[] = [];

    const maxLen = Math.max(sourceLines.length, targetLines.length);

    for (let i = 0; i < maxLen; i++) {
        const srcLine = sourceLines[i] || '';
        const tgtLine = targetLines[i] || '';

        if (srcLine === tgtLine) {
            diff.push(`  ${srcLine}`);
        } else if (!sourceLines[i]) {
            diff.push(`+ ${tgtLine}`);
        } else if (!targetLines[i]) {
            diff.push(`- ${srcLine}`);
        } else {
            diff.push(`- ${srcLine}`);
            diff.push(`+ ${tgtLine}`);
        }
    }

    return diff;
}

/**
 * Compare two procedures
 */
export async function compareProcedures(
    connectionDetails: ConnectionDetails,
    sourceDb: string,
    sourceSchema: string,
    sourceProc: string,
    targetDb: string,
    targetSchema: string,
    targetProc: string
): Promise<ProcedureComparisonResult> {
    let connection: NzConnection | null = null;

    try {
        connection = await createConnectedDatabaseConnectionFromDetails(connectionDetails) as NzConnection;

        // Get metadata for both procedures sequentially
        const sourceMeta = await getProcedureMetadata(connection, sourceDb, sourceSchema, sourceProc);
        const targetMeta = await getProcedureMetadata(connection, targetDb, targetSchema, targetProc);

        const argumentsMatch = sourceMeta.arguments === targetMeta.arguments;
        const returnsMatch = sourceMeta.returns === targetMeta.returns;
        const executeAsOwnerMatch = sourceMeta.executeAsOwner === targetMeta.executeAsOwner;
        const sourceMatch = sourceMeta.source.trim() === targetMeta.source.trim();

        const sourceDiff = sourceMatch ? [] : computeLineDiff(sourceMeta.source, targetMeta.source);

        return {
            source: { database: sourceDb, schema: sourceSchema, name: sourceProc },
            target: { database: targetDb, schema: targetSchema, name: targetProc },
            argumentsMatch,
            sourceArguments: sourceMeta.arguments,
            targetArguments: targetMeta.arguments,
            returnsMatch,
            sourceReturns: sourceMeta.returns,
            targetReturns: targetMeta.returns,
            executeAsOwnerMatch,
            sourceExecuteAsOwner: sourceMeta.executeAsOwner,
            targetExecuteAsOwner: targetMeta.executeAsOwner,
            sourceMatch,
            sourceCode: sourceMeta.source,
            targetCode: targetMeta.source,
            sourceDiff
        };
    } finally {
        if (connection) {
            try {
                await connection.close();
            } catch {
                // Ignore close errors
            }
        }
    }
}
