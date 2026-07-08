/**
 * Real Database Integration Tests
 * Tests actual connectivity and query execution against a live Netezza instance
 *
 * Prerequisites:
 * - Set NZ_DEV_PASSWORD environment variable with the database password
 * - Optionally override host/port/database/user via NZ_DEV_HOST/NZ_DEV_PORT/NZ_DEV_DATABASE/NZ_DEV_USER
 *
 * Run with: NZ_DEV_PASSWORD=password npm run test:live:local
 */

// Skip all tests in this file if password is not provided
const skipTests = !process.env.NZ_DEV_PASSWORD;

// Dynamic skip helper
const describeIfDb = skipTests ? describe.skip : describe;
const itIfDb = skipTests ? it.skip : it;

import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
// Import the actual driver, not mocked
import { NzConnection } from '@justybase/netezza-driver';
import { ResultFormatter } from '../../core/streaming/ResultFormatter';

// Connection configuration from environment
const DB_CONFIG = {
    host: process.env.NZ_DEV_HOST || '192.168.0.144',
    port: process.env.NZ_DEV_PORT ? Number(process.env.NZ_DEV_PORT) : 5480,
    database: process.env.NZ_DEV_DATABASE || 'JUST_DATA',
    user: process.env.NZ_DEV_USER || 'admin',
    password: process.env.NZ_DEV_PASSWORD || 'password'
};



describeIfDb('Real Database Integration Tests', () => {
    let connection: NzConnection;

    beforeAll(async () => {
        if (skipTests) return;

        console.log('Connecting to real Netezza database...');
        connection = new NzConnection({
            host: DB_CONFIG.host,
            port: DB_CONFIG.port,
            database: DB_CONFIG.database,
            user: DB_CONFIG.user,
            password: DB_CONFIG.password
        });

        await connection.connect();
        console.log('Connected successfully!');
    }, 30000); // 30 second timeout for connection

    afterAll(async () => {
        if (connection) {
            connection.close();
            console.log('Connection closed.');
        }
    });

    describe('Connection', () => {
        itIfDb('should establish connection successfully', () => {
            expect(connection).toBeDefined();
        });
    });

    describe('Simple Queries', () => {
        itIfDb('should execute SELECT with calculated value', async () => {
            const cmd = connection.createCommand('SELECT 1 AS TEST_VALUE FROM JUST_DATA.ADMIN.DIMDATE LIMIT 1');
            const reader = await cmd.executeReader();

            try {
                expect(reader).toBeDefined();

                // Read the first row
                const hasRow = await reader.read();
                expect(hasRow).toBe(true);

                // Get value using reader API
                const value = reader.getValue(0);
                expect(value).toBe(1);
            } finally {
                await reader.close();
            }
        });

        itIfDb('should execute arithmetic expression', async () => {
            const cmd = connection.createCommand('SELECT 10 + 20 AS SUM_RESULT FROM JUST_DATA.ADMIN.DIMDATE LIMIT 1');
            const reader = await cmd.executeReader();

            try {
                const hasRow = await reader.read();
                expect(hasRow).toBe(true);
                expect(reader.getValue(0)).toBe(30);
            } finally {
                await reader.close();
            }
        });

        itIfDb('should execute string concatenation', async () => {
            const cmd = connection.createCommand("SELECT 'Hello' || ' ' || 'Netezza' AS GREETING FROM JUST_DATA.ADMIN.DIMDATE LIMIT 1");
            const reader = await cmd.executeReader();

            try {
                const hasRow = await reader.read();
                expect(hasRow).toBe(true);
                expect(reader.getValue(0)).toBe('Hello Netezza');
            } finally {
                await reader.close();
            }
        });

        itIfDb('should execute CURRENT_TIMESTAMP', async () => {
            const cmd = connection.createCommand('SELECT CURRENT_TIMESTAMP AS NOW FROM JUST_DATA.ADMIN.DIMDATE LIMIT 1');
            const reader = await cmd.executeReader();

            try {
                const hasRow = await reader.read();
                expect(hasRow).toBe(true);
                expect(reader.getValue(0)).toBeDefined();
            } finally {
                await reader.close();
            }
        });

        itIfDb('should accept DELETE with CTE-backed IN subquery under EXPLAIN', async () => {
            const cmd = connection.createCommand(`EXPLAIN DELETE FROM JUST_DATA..DIMACCOUNT A
WHERE A.ACCOUNTCODEALTERNATEKEY IN
(
    WITH TTT AS
    (SELECT 1)
    SELECT * FROM TTT
)`);
            const reader = await cmd.executeReader();

            try {
                expect(reader).toBeDefined();
            } finally {
                await reader.close();
            }
        });
    });

    describe('System Views', () => {
        itIfDb('should query _V_DATABASE', async () => {
            const cmd = connection.createCommand('SELECT DATABASE FROM _V_DATABASE LIMIT 5');
            const reader = await cmd.executeReader();

            try {
                expect(reader).toBeDefined();
                expect(reader.fieldCount).toBeGreaterThan(0);
            } finally {
                await reader.close();
            }
        });

        itIfDb('should query _V_SESSION for current session', async () => {
            const cmd = connection.createCommand(`
                SELECT ID, USERNAME, DBNAME, STATUS
                FROM _V_SESSION
                WHERE USERNAME = CURRENT_USER
                LIMIT 1
            `);
            const reader = await cmd.executeReader();

            try {
                const hasRow = await reader.read();
                expect(hasRow).toBe(true);
            } finally {
                await reader.close();
            }
        });
    });

    describe('Data Types', () => {
        itIfDb('should handle INTEGER data type', async () => {
            const cmd = connection.createCommand('SELECT 12345 AS INT_VAL FROM JUST_DATA.ADMIN.DIMDATE LIMIT 1');
            const reader = await cmd.executeReader();

            try {
                await reader.read();
                expect(typeof reader.getValue(0)).toBe('number');
            } finally {
                await reader.close();
            }
        });

        itIfDb('should handle VARCHAR data type', async () => {
            const cmd = connection.createCommand("SELECT 'test string' AS STR_VAL FROM JUST_DATA.ADMIN.DIMDATE LIMIT 1");
            const reader = await cmd.executeReader();

            try {
                await reader.read();
                expect(typeof reader.getValue(0)).toBe('string');
            } finally {
                await reader.close();
            }
        });

        itIfDb('should handle BOOLEAN data type', async () => {
            const cmd = connection.createCommand('SELECT TRUE AS BOOL_VAL FROM JUST_DATA.ADMIN.DIMDATE LIMIT 1');
            const reader = await cmd.executeReader();

            try {
                await reader.read();

                // Boolean may be returned as boolean or number depending on driver
                expect([true, 1, 't', 'T']).toContain(reader.getValue(0));
            } finally {
                await reader.close();
            }
        });

        itIfDb('should handle NULL values', async () => {
            const cmd = connection.createCommand('SELECT NULL AS NULL_VAL FROM JUST_DATA.ADMIN.DIMDATE LIMIT 1');
            const reader = await cmd.executeReader();

            try {
                await reader.read();
                expect(reader.getValue(0)).toBeNull();
            } finally {
                await reader.close();
            }
        });

        itIfDb('should handle DECIMAL data type', async () => {
            const cmd = connection.createCommand('SELECT 123.456 AS DEC_VAL FROM JUST_DATA.ADMIN.DIMDATE LIMIT 1');
            const reader = await cmd.executeReader();

            try {
                await reader.read();

                const value = reader.getValue(0);
                expect(parseFloat(String(value))).toBeCloseTo(123.456, 3);
            } finally {
                await reader.close();
            }
        });

        itIfDb('should expose Netezza national character casts as text metadata', async () => {
            const cmd = connection.createCommand(`
                SELECT
                    'AA'::VARCHAR(32) AS VARCHAR_COL,
                    'AA'::NVARCHAR(32) AS NVARCHAR_COL,
                    'AA'::NCHAR(8) AS NCHAR_COL,
                    'AA'::NATIONAL CHARACTER VARYING(32) AS NCHAR_VARYING_COL
                FROM JUST_DATA..DIMACCOUNT
                LIMIT 1
            `);
            const reader = await cmd.executeReader();

            try {
                expect(ResultFormatter.extractColumns(reader)).toEqual([
                    { name: 'VARCHAR_COL', type: 'VARCHAR(32)' },
                    { name: 'NVARCHAR_COL', type: 'NVARCHAR(32)' },
                    { name: 'NCHAR_COL', type: 'NCHAR(8)' },
                    { name: 'NCHAR_VARYING_COL', type: 'NVARCHAR(32)' }
                ]);

                // Live driver raw type names can be misleading for national character casts.
                // Verify the fallback metadata contract via getSchemaTable() instead.
                const schema = reader.getSchemaTable();
                const rows = Array.isArray(schema) ? schema : schema.Rows;
                expect(rows[0].ColumnName).toBe('VARCHAR_COL');
                expect(rows[0].ColumnSize).toBe(32);
                expect(rows[1].ColumnName).toBe('NVARCHAR_COL');
                expect(rows[1].ColumnSize).toBe(32);
                expect(rows[1].ProviderType).toBe(2530);
                expect(rows[2].ColumnName).toBe('NCHAR_COL');
                expect(rows[2].ProviderType).toBe(2522);

                const hasRow = await reader.read();
                expect(hasRow).toBe(true);
                expect(reader.getValue(0)).toBe('AA');
                expect(reader.getValue(1)).toBe('AA');
                expect(reader.getValue(2)).toBe('AA');
                expect(reader.getValue(3)).toBe('AA');
            } finally {
                await reader.close();
            }
        });

        itIfDb('should preserve column metadata for zero-row result sets', async () => {
            const cmd = connection.createCommand(`
                SELECT
                    1::INT4 AS INT_COL,
                    CURRENT_TIMESTAMP AS TS_COL,
                    'AA'::NVARCHAR(32) AS NVARCHAR_COL
                FROM _V_DATABASE
                LIMIT 0
            `);
            const reader = await cmd.executeReader();

            try {
                expect(reader.fieldCount).toBe(3);
                expect(await reader.read()).toBe(false);
                expect(ResultFormatter.extractColumns(reader)).toEqual([
                    { name: 'INT_COL', type: 'INT4' },
                    { name: 'TS_COL', type: 'TIMESTAMPTZ' },
                    { name: 'NVARCHAR_COL', type: 'NVARCHAR(32)' }
                ]);
            } finally {
                await reader.close();
            }
        });
    });

    describe('Row Limiting', () => {
        itIfDb('should respect LIMIT clause', async () => {
            const cmd = connection.createCommand('SELECT * FROM _V_DATABASE LIMIT 3');
            const reader = await cmd.executeReader();

            try {
                let count = 0;
                while (await reader.read()) {
                    count++;
                }

                expect(count).toBeLessThanOrEqual(3);
            } finally {
                await reader.close();
            }
        });

        itIfDb('should handle LIMIT 0', async () => {
            const cmd = connection.createCommand('SELECT * FROM _V_DATABASE LIMIT 0');
            const reader = await cmd.executeReader();

            try {
                const hasRow = await reader.read();
                expect(hasRow).toBe(false);
            } finally {
                await reader.close();
            }
        });
    });

    describe('Error Handling', () => {
        itIfDb('should throw error for invalid SQL', async () => {
            const cmd = connection.createCommand('INVALID SQL STATEMENT');

            await expect(cmd.executeReader()).rejects.toThrow();
        });

        itIfDb('should throw error for non-existent table', async () => {
            const cmd = connection.createCommand('SELECT * FROM NON_EXISTENT_TABLE_XYZ123');

            await expect(cmd.executeReader()).rejects.toThrow();
        });

        itIfDb('should throw error for syntax error', async () => {
            const cmd = connection.createCommand('SELECT * FORM _V_DATABASE');

            await expect(cmd.executeReader()).rejects.toThrow();
        });
    });

    describe('Schema Exploration', () => {
        itIfDb('should list schemas in database', async () => {
            const cmd = connection.createCommand(`
                SELECT SCHEMA FROM _V_SCHEMA
                ORDER BY SCHEMA
            `);
            const reader = await cmd.executeReader();

            try {
                let count = 0;
                while (await reader.read()) {
                    count++;
                }

                expect(count).toBeGreaterThan(0);
            } finally {
                await reader.close();
            }
        });

        itIfDb('should list tables in database', async () => {
            const cmd = connection.createCommand(`
                SELECT OBJNAME,OWNER
                FROM _V_OBJECTS
                WHERE OBJTYPE = 'TABLE'
                LIMIT 20
            `);
            const reader = await cmd.executeReader();

            try {
                expect(reader).toBeDefined();
                expect(reader.fieldCount).toBeGreaterThan(0);
            } finally {
                await reader.close();
            }
        });
    });
});

// If tests are skipped, log a message
if (skipTests) {
    console.log('⚠️ Real database tests skipped: NZ_DEV_PASSWORD environment variable not set');
    console.log('To run real database tests, set: NZ_DEV_PASSWORD=yourpassword npm run test:live:local');
}
