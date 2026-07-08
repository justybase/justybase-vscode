/**
 * DDL Generator - Helper Functions
 */
import { NzConnection, ConnectionDetails } from '../../../types';

/**
 * Execute query and return array of objects (shim for NzConnection)
 */
export async function executeQueryHelper<T = Record<string, unknown>>(connection: NzConnection, sql: string): Promise<T[]> {
    const cmd = connection.createCommand(sql);
    const reader = await cmd.executeReader();
    const results: Record<string, unknown>[] = [];

    while (await reader.read()) {
        const row: Record<string, unknown> = {};
        for (let i = 0; i < reader.fieldCount; i++) {
            row[reader.getName(i)] = reader.getValue(i);
        }
        results.push(row);
    }
    return results as T[];
}

/**
 * Quote identifier name if needed (contains special characters or is mixed case)
 */
export function quoteNameIfNeeded(name: string): string {
    if (!name) {
        return name;
    }

    // Check if name contains only uppercase letters, digits, and underscores
    // and starts with a letter or underscore
    const isSimpleIdentifier = /^[A-Z_][A-Z0-9_]*$/i.test(name) && name === name.toUpperCase();

    if (isSimpleIdentifier) {
        return name;
    }

    // Quote name and double internal quotes
    return `"${name.replace(/"/g, '""')}"`;
}

/**
 * Parse ODBC-style connection string into config object
 * @deprecated Use ConnectionDetails directly instead
 */
export function parseConnectionString(connStr: string): {
    host?: string;
    port?: number;
    database?: string;
    user?: string;
    password?: string;
} {
    const parts = connStr.split(';');
    const config: { host?: string; port?: number; database?: string; user?: string; password?: string } = {};
    for (const part of parts) {
        const idx = part.indexOf('=');
        if (idx > 0) {
            const key = part.substring(0, idx).trim().toUpperCase();
            const value = part.substring(idx + 1).trim();
            if (key === 'SERVER') config.host = value;
            else if (key === 'PORT') config.port = parseInt(value);
            else if (key === 'DATABASE') config.database = value;
            else if (key === 'UID') config.user = value;
            else if (key === 'PWD') config.password = value;
        }
    }
    return config;
}

/**
 * Fix Netezza procedure return type syntax for ANY length types
 */
export function fixProcReturnType(procReturns: string): string {
    if (!procReturns) return procReturns;

    const upper = procReturns.trim().toUpperCase();
    if (upper === 'CHARACTER VARYING') {
        return 'CHARACTER VARYING(ANY)';
    } else if (upper === 'NATIONAL CHARACTER VARYING') {
        return 'NATIONAL CHARACTER VARYING(ANY)';
    } else if (upper === 'NATIONAL CHARACTER') {
        return 'NATIONAL CHARACTER(ANY)';
    } else if (upper === 'CHARACTER') {
        return 'CHARACTER(ANY)';
    }
    return procReturns;
}

/**
 * Create NzConnection from ConnectionDetails (recommended)
 * @param details - Connection details
 * @param databaseOverride - Optional: override the database to connect to
 *                           Use this when you need to connect to a specific database
 *                           that differs from the default in connection details.
 *                           CRITICAL for reading _V_VIEW.DEFINITION and _V_PROCEDURE.PROCEDURESOURCE
 */
export async function createConnectionFromDetails(
    details: ConnectionDetails, 
    databaseOverride?: string
): Promise<NzConnection> {
    const config = {
        host: details.host,
        port: details.port || 5480,
        database: databaseOverride || details.database,
        user: details.user,
        password: details.password
    };

    const NzConnection = require('@justybase/netezza-driver').NzConnection;
    const connection = new NzConnection(config);
    await connection.connect();
    return connection;
}

