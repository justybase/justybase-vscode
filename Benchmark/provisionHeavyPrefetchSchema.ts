/**
 * Standalone provisioner for heavy prefetch E2E databases on live Netezza.
 *
 * Usage:
 *   set -a && . ./.env.local && set +a
 *   npm run provision:heavy-prefetch-schema
 *
 * Env (see heavyPrefetchSchema.ts):
 *   NZ_DEV_PASSWORD, NZ_E2E_DB_COUNT, NZ_E2E_TABLES_PER_DB, NZ_E2E_COLUMNS_PER_TABLE, ...
 */

import { NzConnection } from '@justybase/netezza-driver';
import { ResultFormatter } from '../src/core/streaming/ResultFormatter';
import type { QueryResult } from '../src/types/index';
import {
    estimateHeavySchemaStats,
    getHeavySchemaConfigFromEnv,
    heavySchemaObjectCountSql,
    provisionHeavySchema,
    resolveHeavySchemaDatabaseNames,
} from './heavyPrefetchSchema';

const DB_CONFIG = {
    host: process.env.NZ_DEV_HOST || 'localhost',
    port: process.env.NZ_DEV_PORT ? Number(process.env.NZ_DEV_PORT) : 5480,
    user: process.env.NZ_DEV_USER || 'admin',
    password: process.env.NZ_DEV_PASSWORD || '',
};

async function executeRaw(connection: NzConnection, sql: string): Promise<QueryResult> {
    const cmd = connection.createCommand(sql);
    const reader = await cmd.executeReader();
    const columns = ResultFormatter.extractColumns(reader);
    const data: unknown[][] = [];
    while (await reader.read()) {
        const row: unknown[] = [];
        for (let i = 0; i < reader.fieldCount; i++) {
            row.push(reader.getValue(i));
        }
        data.push(row);
    }
    await reader.close();
    return { columns, data };
}

async function executeSilent(connection: NzConnection, sql: string): Promise<void> {
    const cmd = connection.createCommand(sql);
    const reader = await cmd.executeReader();
    while (await reader.read()) {
        // drain
    }
    await reader.close();
}

async function main(): Promise<void> {
    if (!DB_CONFIG.password) {
        console.error('Set NZ_DEV_PASSWORD (e.g. in .env.local) before provisioning.');
        process.exit(1);
    }

    const config = getHeavySchemaConfigFromEnv();
    const plan = estimateHeavySchemaStats(config);
    const databases = resolveHeavySchemaDatabaseNames(config);

    console.log('Heavy prefetch schema plan:');
    console.log(`  Databases: ${databases.join(', ')}`);
    console.log(`  Tables: ${plan.totalTables} (~${plan.dimensionTables} dim + ${plan.factTables} fact)`);
    console.log(`  Estimated columns: ${plan.estimatedColumns}`);
    console.log(`  Enriched tables (PK/FK/comments): ~${plan.enrichedTables}`);
    console.log(`  Synonyms: ${plan.synonyms}, procedures: ${plan.procedures}`);
    console.log('');

    const systemConnection = new NzConnection({
        host: DB_CONFIG.host,
        port: DB_CONFIG.port,
        database: 'SYSTEM',
        user: DB_CONFIG.user,
        password: DB_CONFIG.password,
    });
    await systemConnection.connect();

    const openConnections: NzConnection[] = [systemConnection];
    const databaseConnections = new Map<string, NzConnection>();

    try {
        const stats = await provisionHeavySchema({
            config,
            executeOnSystem: (sql) => executeSilent(systemConnection, sql),
            connectToDatabase: async (database) => {
                const existing = databaseConnections.get(database);
                if (existing) {
                    try {
                        existing.close();
                    } catch {
                        // ignore
                    }
                    databaseConnections.delete(database);
                }
                const connection = new NzConnection({
                    host: DB_CONFIG.host,
                    port: DB_CONFIG.port,
                    database,
                    user: DB_CONFIG.user,
                    password: DB_CONFIG.password,
                });
                await connection.connect();
                openConnections.push(connection);
                databaseConnections.set(database, connection);
                return (sql) => executeSilent(connection, sql);
            },
            databaseExists: async (database) => {
                const result = await executeRaw(
                    systemConnection,
                    `SELECT DATABASE FROM _V_DATABASE WHERE UPPER(DATABASE) = UPPER('${database}')`,
                );
                const rows = ResultFormatter.queryResultToRows<{ DATABASE: string }>(result);
                return rows.length > 0;
            },
            countExistingObjects: async (database) => {
                const connection = databaseConnections.get(database);
                if (!connection) {
                    return 0;
                }
                const result = await executeRaw(
                    connection,
                    heavySchemaObjectCountSql(database, config.schema),
                );
                const rows = ResultFormatter.queryResultToRows<{ CNT: number }>(result);
                return Number(rows[0]?.CNT ?? 0);
            },
            onProgress: (progress) => {
                console.log(
                    `[${progress.database}] ${progress.phase} ${progress.completed}/${progress.total}`,
                );
            },
        });

        console.log('');
        console.log('Provisioning complete:');
        console.log(`  DDL statements executed: ${stats.ddlStatements}`);
        console.log(`  Duration: ${stats.durationMs} ms`);
        console.log(`  Databases: ${stats.databases.join(', ')}`);
    } finally {
        for (const connection of openConnections) {
            try {
                connection.close();
            } catch {
                // ignore
            }
        }
    }
}

main().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
});
