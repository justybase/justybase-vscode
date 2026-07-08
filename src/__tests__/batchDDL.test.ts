/**
 * Unit tests for ddl/batchDDL.ts
 */
/* eslint-disable @typescript-eslint/no-explicit-any */

import { generateBatchDDL } from '../ddl/batchDDL';
import * as helpers from '../ddl/helpers';

// Mock dependencies
jest.mock('../ddl/helpers', () => ({
    executeQueryHelper: jest.fn(),
    createConnectionFromDetails: jest.fn().mockResolvedValue({
        connect: jest.fn().mockResolvedValue(undefined),
        close: jest.fn().mockResolvedValue(undefined)
    }),
    fixProcReturnType: jest.fn().mockImplementation(t => t)
}));

jest.mock('../utils/sqlUtils', () => ({
    buildSchemaFilter: jest.fn().mockImplementation((s, col) => s ? ` AND ${col} = '${s}'` : ''),
    buildDatabaseFilter: jest.fn().mockImplementation((d, col) => ` ${col || 'DBNAME'} = '${d}'`),
    escapeSqlIdentifier: jest.fn().mockImplementation(i => `"${i}"`)
}));

// Mock builders to isolate batch logic
jest.mock('../ddl/tableDDL', () => ({ buildTableDDLFromCache: jest.fn().mockReturnValue('-- TABLE DDL') }));
jest.mock('../ddl/viewDDL', () => ({ buildViewDDLFromCache: jest.fn().mockReturnValue('-- VIEW DDL') }));
jest.mock('../ddl/procedureDDL', () => ({ buildProcedureDDLFromCache: jest.fn().mockReturnValue('-- PROC DDL') }));
jest.mock('../ddl/externalTableDDL', () => ({ buildExternalTableDDLFromCache: jest.fn().mockReturnValue('-- EXT TABLE DDL') }));
jest.mock('../ddl/synonymDDL', () => ({ buildSynonymDDLFromCache: jest.fn().mockReturnValue('-- SYNONYM DDL') }));

describe('batchDDL', () => {
    const mockOptions = {
        database: 'TESTDB',
        connectionDetails: {} as any,
        objectTypes: ['TABLE', 'VIEW', 'PROCEDURE', 'EXTERNAL TABLE', 'SYNONYM']
    };

    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('should generate complete DDL with all object types', async () => {
        (helpers.executeQueryHelper as jest.Mock).mockImplementation((_conn, sql) => {
            if (sql.includes('_V_RELATION_COLUMN')) {
                return [
                    { SCHEMA: 'S1', OBJNAME: 'T1', OBJTYPE: 'TABLE', ATTNAME: 'C1', FULL_TYPE: 'INT', ATTNOTNULL: 't' },
                    { SCHEMA: 'S1', OBJNAME: 'T1', OBJTYPE: 'TABLE', ATTNAME: 'C2', FULL_TYPE: 'VARCHAR(10)', ATTNOTNULL: 0 }
                ];
            }
            if (sql.includes('_V_TABLE_DIST_MAP')) return [{ SCHEMA: 'S1', TABLENAME: 'T1', ATTNAME: 'C1' }];
            if (sql.includes('_V_TABLE_ORGANIZE_COLUMN')) return [{ SCHEMA: 'S1', TABLENAME: 'T1', ATTNAME: 'C2' }];
            if (sql.includes('_V_RELATION_KEYDATA')) return [{ SCHEMA: 'S1', RELATION: 'T1', CONSTRAINTNAME: 'PK', CONTYPE: 'p', ATTNAME: 'C1' }];
            if (sql.includes('_V_PROCEDURE')) {
                if (sql.includes('OBJNAME')) return [{ OBJNAME: 'P1(INT)', SCHEMA: 'S1' }];
                return [{ SCHEMA: 'S1', PROCEDURE: 'P1', PROCEDURESIGNATURE: 'P1(INT)', PROCEDURESOURCE: '...', RETURNS: 'INT' }];
            }
            if (sql.includes('_V_VIEW')) {
                return [{ SCHEMA: 'S1', VIEWNAME: 'V1', DEFINITION: 'CREATE VIEW...' }];
            }
            if (sql.includes('_V_SYNONYM')) {
                return [{ SCHEMA: 'S1', SYNONYM_NAME: 'SYN1', REFOBJNAME: 'T1', OWNER: 'ADMIN' }];
            }
            if (sql.includes('_V_EXTERNAL')) {
                return [{ SCHEMA: 'S1', TABLENAME: 'EXT1', EXTOBJNAME: 'OBJ', OBJID: 100, FORMAT: 'TEXT' }];
            }
            if (sql.includes('_V_OBJECT_DATA')) {
                if (sql.includes('OBJTYPE = \'TABLE\'')) return [{ OBJNAME: 'T1', SCHEMA: 'S1' }];
                if (sql.includes('OBJTYPE = \'VIEW\'')) return [{ OBJNAME: 'V1', SCHEMA: 'S1' }];
                if (sql.includes('OBJTYPE = \'EXTERNAL TABLE\'')) return [{ OBJNAME: 'EXT1', SCHEMA: 'S1' }];
                if (sql.includes('OBJTYPE = \'SYNONYM\'')) return [{ OBJNAME: 'SYN1', SCHEMA: 'S1' }];
                if (sql.includes('DESCRIPTION IS NOT NULL')) return [{ SCHEMA: 'S1', OBJNAME: 'T1', DESCRIPTION: 'Comment' }];
            }
            return [];
        });

        const result = await generateBatchDDL(mockOptions);

        expect(result.success).toBe(true);
        expect(result.objectCount).toBe(5);
        expect(result.ddlCode).toContain('-- TABLE DDL');
        expect(result.ddlCode).toContain('-- VIEW DDL');
        expect(result.ddlCode).toContain('-- PROC DDL');
        expect(result.ddlCode).toContain('-- EXT TABLE DDL');
        expect(result.ddlCode).toContain('-- SYNONYM DDL');
    });

    it('should handle different column NOT NULL representations', async () => {
        (helpers.executeQueryHelper as jest.Mock).mockImplementation((_conn, sql) => {
            if (sql.includes('_V_RELATION_COLUMN')) {
                return [
                    { SCHEMA: 'S1', OBJNAME: 'T1', OBJTYPE: 'TABLE', ATTNAME: 'C1', ATTNOTNULL: true },
                    { SCHEMA: 'S1', OBJNAME: 'T1', OBJTYPE: 'TABLE', ATTNAME: 'C2', ATTNOTNULL: 1 },
                    { SCHEMA: 'S1', OBJNAME: 'T1', OBJTYPE: 'TABLE', ATTNAME: 'C3', ATTNOTNULL: 'true' },
                    { SCHEMA: 'S1', OBJNAME: 'T1', OBJTYPE: 'TABLE', ATTNAME: 'C4', ATTNOTNULL: '1' }
                ];
            }
            if (sql.includes('_V_OBJECT_DATA') && sql.includes('OBJTYPE = \'TABLE\'')) return [{ OBJNAME: 'T1', SCHEMA: 'S1' }];
            return [];
        });

        const result = await generateBatchDDL({ ...mockOptions, objectTypes: ['TABLE'] });
        expect(result.success).toBe(true);
        // Verify via buildTableDDLFromCache calls (captured columns)
        const buildTableDDL = require('../ddl/tableDDL').buildTableDDLFromCache;
        const columns = buildTableDDL.mock.calls[0][3];
        expect(columns.every((c: any) => c.notNull === true)).toBe(true);
    });

    it('should handle errors in bulk fetches gracefully', async () => {
        (helpers.executeQueryHelper as jest.Mock).mockImplementation((_conn, sql) => {
            if (sql.includes('_V_RELATION_COLUMN')) throw new Error('Query Timeout');
            if (sql.includes('_V_OBJECT_DATA') && sql.includes('OBJTYPE = \'TABLE\'')) return [{ OBJNAME: 'T1', SCHEMA: 'S1' }];
            return [];
        });

        const result = await generateBatchDDL({ ...mockOptions, objectTypes: ['TABLE'] });
        expect(result.success).toBe(true);
        expect(result.errors.length).toBeGreaterThan(0);
        expect(result.ddlCode).toContain('ERROR REPORT');
    });

    it('should filter by object types', async () => {
        const result = await generateBatchDDL({ ...mockOptions, objectTypes: ['VIEW'] });
        expect(result.ddlCode).toContain('Object Types: VIEW');
    });

    it('should handle null/empty objectTypes by processing all supported', async () => {
        const result = await generateBatchDDL({ ...mockOptions, objectTypes: [] });
        expect(result.ddlCode).toContain('TABLE, VIEW, PROCEDURE, EXTERNAL TABLE, SYNONYM');
    });

    it('should handle schema filtering', async () => {
        const result = await generateBatchDDL({ ...mockOptions, schema: 'MYSCHEMA' });
        expect(result.ddlCode).toContain('-- Schema: MYSCHEMA');
    });

    it('should handle missing metadata for an object', async () => {
        (helpers.executeQueryHelper as jest.Mock).mockImplementation((_conn, sql) => {
            if (sql.includes('_V_OBJECT_DATA') && sql.includes('OBJTYPE = \'SYNONYM\'')) {
                return [{ OBJNAME: 'MISSING_SYN', SCHEMA: 'S1' }];
            }
            return [];
        });

        const result = await generateBatchDDL({ ...mockOptions, objectTypes: ['SYNONYM'] });
        expect(result.skipped).toBe(1);
        expect(result.errors[0]).toContain('Metadata for synonym S1.MISSING_SYN not found');
    });

    it('should catch top-level connection errors', async () => {
        (helpers.createConnectionFromDetails as jest.Mock).mockRejectedValueOnce(new Error('Connection Failed'));
        const result = await generateBatchDDL(mockOptions);
        expect(result.success).toBe(false);
        expect(result.errors[0]).toBe('Batch DDL generation error: Connection Failed');
    });

    it('should handle external table boolean parsing', async () => {
        (helpers.executeQueryHelper as jest.Mock).mockImplementation((_conn, sql) => {
            if (sql.includes('_V_EXTERNAL')) {
                return [{
                    SCHEMA: 'S1', TABLENAME: 'EXT1', EXTOBJNAME: 'OBJ', OBJID: 100,
                    CRINSTRING: 't', TRUNCSTRING: 1, CTRLCHARS: true, IGNOREZERO: 'yes',
                    TIMEEXTRAZEROS: 'on', FILLRECORD: 'false'
                }];
            }
            if (sql.includes('_V_OBJECT_DATA')) {
                if (sql.includes('OBJTYPE = \'EXTERNAL TABLE\'')) return [{ OBJNAME: 'EXT1', SCHEMA: 'S1' }];
            }
            return [];
        });
        const result = await generateBatchDDL({ ...mockOptions, objectTypes: ['EXTERNAL TABLE'] });
        expect(result.errors).toEqual([]);
        expect(result.success).toBe(true);
    });
});
