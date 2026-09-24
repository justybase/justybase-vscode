/**
 * Generate a Netezza view in another database that selects from a source table.
 */

import { quoteNetezzaIdentifier } from '@justybase/designer-core';
import type { ConnectionDetails, NzConnection } from '../../../types';
import { createConnectionFromDetails } from './helpers';
import { getColumns, getKeysInfo, getTableComment } from './metadata';
import type { KeyInfo } from './types';

const TARGET_DATABASE_PLACEHOLDER = 'NEW_DATABASE';

function escapeSqlString(value: string): string {
    return value.replace(/'/g, "''");
}

function describeSourceKeys(keysInfo: ReadonlyMap<string, KeyInfo>): string[] {
    const descriptions: string[] = [];

    for (const [name, key] of keysInfo) {
        const columns = key.columns.map(quoteNetezzaIdentifier).join(', ');
        if (key.typeChar === 'p') {
            descriptions.push(`- PRIMARY KEY ${quoteNetezzaIdentifier(name)} (${columns})`);
        } else if (key.typeChar === 'u') {
            descriptions.push(`- UNIQUE ${quoteNetezzaIdentifier(name)} (${columns})`);
        } else if (key.typeChar === 'f') {
            const referencedName = key.pkDatabase && key.pkSchema && key.pkRelation
                ? [key.pkDatabase, key.pkSchema, key.pkRelation].map(quoteNetezzaIdentifier).join('.')
                : 'unknown referenced table';
            const referencedColumns = key.pkColumns.map(quoteNetezzaIdentifier).join(', ');
            const reference = referencedColumns ? `${referencedName} (${referencedColumns})` : referencedName;
            descriptions.push(
                `- FOREIGN KEY ${quoteNetezzaIdentifier(name)} (${columns}) REFERENCES ${reference}`
                + ` ON UPDATE ${key.updateType} ON DELETE ${key.deleteType}`
            );
        }
    }

    return descriptions;
}

/** Build the script from already loaded source metadata. */
export function buildTableAsViewDDL(
    sourceDatabase: string,
    sourceSchema: string,
    tableName: string,
    columns: ReadonlyArray<{ name: string; description?: string | null }>,
    keysInfo: ReadonlyMap<string, KeyInfo>,
    tableComment: string | null,
): string {
    const sourceName = [sourceDatabase, sourceSchema, tableName].map(quoteNetezzaIdentifier).join('.');
    const targetName = `${TARGET_DATABASE_PLACEHOLDER}..${quoteNetezzaIdentifier(tableName)}`;
    const lines = [
        `CREATE VIEW ${targetName} AS`,
        `SELECT * FROM ${sourceName};`,
    ];

    const sourceKeys = describeSourceKeys(keysInfo);
    const viewComment = [
        `View from table ${sourceName}.`,
        ...(tableComment?.trim() ? ['', tableComment.trim()] : []),
        '',
        'Source constraints (informational; not enforced by this view):',
        ...(sourceKeys.length > 0 ? sourceKeys : ['- No key constraints found.']),
    ].join('\n');

    lines.push(
        '',
        `COMMENT ON VIEW ${targetName} IS '${escapeSqlString(viewComment)}';`,
    );

    for (const column of columns) {
        if (!column.description?.trim()) continue;
        lines.push(
            `COMMENT ON COLUMN ${targetName}.${quoteNetezzaIdentifier(column.name)} `
            + `IS '${escapeSqlString(column.description.trim())}';`,
        );
    }

    return lines.join('\n');
}

/** Fetch source table metadata and build the cross-database view script. */
export async function generateTableAsViewDDL(
    connectionDetails: ConnectionDetails,
    database: string,
    schema: string,
    tableName: string,
): Promise<string> {
    let connection: NzConnection | undefined;
    try {
        connection = await createConnectionFromDetails(connectionDetails, database);
        // Keep catalog reads sequential because the driver connection owns a
        // single active reader at a time.
        const columns = await getColumns(connection, database, schema, tableName);
        const keysInfo = await getKeysInfo(connection, database, schema, tableName);
        const tableComment = await getTableComment(connection, database, schema, tableName);

        if (columns.length === 0) {
            throw new Error(`Table ${database}.${schema}.${tableName} was not found or has no columns.`);
        }

        return buildTableAsViewDDL(database, schema, tableName, columns, keysInfo, tableComment);
    } finally {
        if (connection) {
            try {
                await connection.close();
            } catch {
                // Keep metadata or generation errors as the primary failure.
            }
        }
    }
}
