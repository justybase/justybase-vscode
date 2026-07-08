/**
 * Unit tests for import/dataImporter.ts
 * Tests data import utilities and type detection
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { once } from 'events';
import {
    NetezzaDataType,
    ColumnTypeChooser,
    NetezzaImporter,
    importDataToNetezza
} from '../import/dataImporter';

describe('import/dataImporter', () => {
    describe('NetezzaDataType', () => {
        describe('constructor', () => {
            it('should create with dbType only', () => {
                const type = new NetezzaDataType('BIGINT');
                expect(type.dbType).toBe('BIGINT');
                expect(type.precision).toBeUndefined();
                expect(type.scale).toBeUndefined();
                expect(type.length).toBeUndefined();
            });

            it('should create with all parameters', () => {
                const type = new NetezzaDataType('NUMERIC', 10, 2, 50);
                expect(type.dbType).toBe('NUMERIC');
                expect(type.precision).toBe(10);
                expect(type.scale).toBe(2);
                expect(type.length).toBe(50);
            });
        });

        describe('toString', () => {
            it('should return BIGINT as-is', () => {
                const type = new NetezzaDataType('BIGINT');
                expect(type.toString()).toBe('BIGINT');
            });

            it('should return DATE as-is', () => {
                const type = new NetezzaDataType('DATE');
                expect(type.toString()).toBe('DATE');
            });

            it('should return DATETIME as-is', () => {
                const type = new NetezzaDataType('DATETIME');
                expect(type.toString()).toBe('DATETIME');
            });

            it('should format NUMERIC with precision and scale', () => {
                const type = new NetezzaDataType('NUMERIC', 10, 2);
                expect(type.toString()).toBe('NUMERIC(10,2)');
            });

            it('should format NVARCHAR with length', () => {
                const type = new NetezzaDataType('NVARCHAR', undefined, undefined, 100);
                expect(type.toString()).toBe('NVARCHAR(100)');
            });

            it('should return default NVARCHAR(255) for unknown types', () => {
                const type = new NetezzaDataType('UNKNOWN');
                expect(type.toString()).toBe('NVARCHAR(255)');
            });
        });
    });

    describe('ColumnTypeChooser', () => {
        describe('constructor', () => {
            it('should create with default decimal delimiter', () => {
                const chooser = new ColumnTypeChooser();
                expect(chooser.currentType.dbType).toBe('BIGINT');
            });

            it('should create with custom decimal delimiter', () => {
                const chooser = new ColumnTypeChooser(',');
                expect(chooser.currentType.dbType).toBe('BIGINT');
            });
        });

        describe('getMaxScale', () => {
            it('should return 0 initially', () => {
                const chooser = new ColumnTypeChooser();
                expect(chooser.getMaxScale()).toBe(0);
            });
        });

        describe('getMaxPrecision', () => {
            it('should return 0 initially', () => {
                const chooser = new ColumnTypeChooser();
                expect(chooser.getMaxPrecision()).toBe(0);
            });
        });

        describe('refreshCurrentType', () => {
            it('should detect BIGINT for integer values', () => {
                const chooser = new ColumnTypeChooser();
                const type = chooser.refreshCurrentType('12345');
                expect(type.dbType).toBe('BIGINT');
            });

            it('should detect BIGINT for large integers', () => {
                const chooser = new ColumnTypeChooser();
                const type = chooser.refreshCurrentType('99999999999999');
                expect(type.dbType).toBe('BIGINT');
            });

            it('should detect NUMERIC for decimal values', () => {
                const chooser = new ColumnTypeChooser();
                const type = chooser.refreshCurrentType('123.45');
                expect(type.dbType).toBe('NUMERIC');
                expect(type.precision).toBeGreaterThan(0);
                expect(type.scale).toBe(2);
            });

            it('should detect NUMERIC with comma delimiter', () => {
                const chooser = new ColumnTypeChooser(',');
                const type = chooser.refreshCurrentType('123,45');
                expect(type.dbType).toBe('NUMERIC');
                expect(type.scale).toBe(2);
            });

            it('should detect DATE for YYYY-MM-DD format', () => {
                const chooser = new ColumnTypeChooser();
                const type = chooser.refreshCurrentType('2024-06-07');
                expect(type.dbType).toBe('DATE');
            });

            it('should detect DATE for YYYY-M-D format', () => {
                const chooser = new ColumnTypeChooser();
                const type = chooser.refreshCurrentType('2024-6-7');
                expect(type.dbType).toBe('DATE');
            });

            it('should detect DATETIME for YYYY-MM-DD HH:mm format', () => {
                const chooser = new ColumnTypeChooser();
                const type = chooser.refreshCurrentType('2024-06-07 14:30');
                expect(type.dbType).toBe('DATETIME');
            });

            it('should detect DATETIME for YYYY-MM-DD HH:mm:ss format', () => {
                const chooser = new ColumnTypeChooser();
                const type = chooser.refreshCurrentType('2024-06-07 14:30:45');
                expect(type.dbType).toBe('DATETIME');
            });

            it('should detect DATETIME for dd.mm.yyyy HH:mm format', () => {
                const chooser = new ColumnTypeChooser();
                const type = chooser.refreshCurrentType('07.06.2024 14:30');
                expect(type.dbType).toBe('DATETIME');
            });

            it('should detect DATETIME for dd.mm.yyyy format', () => {
                const chooser = new ColumnTypeChooser();
                const type = chooser.refreshCurrentType('07.06.2024');
                expect(type.dbType).toBe('DATETIME');
            });

            it('should fallback to NVARCHAR for non-numeric strings', () => {
                const chooser = new ColumnTypeChooser();
                const type = chooser.refreshCurrentType('hello world');
                expect(type.dbType).toBe('NVARCHAR');
            });

            it('should fallback to NVARCHAR for mixed content', () => {
                const chooser = new ColumnTypeChooser();
                chooser.refreshCurrentType('123'); // Start with BIGINT
                const type = chooser.refreshCurrentType('abc123'); // Then mixed
                expect(type.dbType).toBe('NVARCHAR');
            });

            it('should upgrade from BIGINT to NUMERIC', () => {
                const chooser = new ColumnTypeChooser();
                chooser.refreshCurrentType('100'); // BIGINT
                const type = chooser.refreshCurrentType('12.5');
                expect(type.dbType).toBe('NUMERIC');
            });

            it('should track max precision and scale', () => {
                const chooser = new ColumnTypeChooser();
                chooser.refreshCurrentType('12.5'); // precision 3, scale 1
                chooser.refreshCurrentType('123.45'); // precision 5, scale 2
                chooser.refreshCurrentType('12345.678'); // precision 8, scale 3

                expect(chooser.getMaxPrecision()).toBe(8);
                expect(chooser.getMaxScale()).toBe(3);
            });

            it('should handle zero values', () => {
                const chooser = new ColumnTypeChooser();
                const type = chooser.refreshCurrentType('0');
                expect(type.dbType).toBe('BIGINT');
            });

            it('should handle negative integers', () => {
                const chooser = new ColumnTypeChooser();
                const type = chooser.refreshCurrentType('-12345');
                // Negative numbers should fallback to NVARCHAR since regex only matches digits
                expect(type.dbType).toBe('NVARCHAR');
            });

            it('should handle very long integers (fallback)', () => {
                const chooser = new ColumnTypeChooser();
                const type = chooser.refreshCurrentType('123456789012345678901234567890');
                // Too long for BIGINT (< 15 chars check)
                expect(type.dbType).toBe('NVARCHAR');
            });
        });

        describe('type transitions', () => {
            it('should not downgrade from NUMERIC to BIGINT', () => {
                const chooser = new ColumnTypeChooser();
                chooser.refreshCurrentType('12.5'); // NUMERIC
                const type = chooser.refreshCurrentType('100');
                // Once NUMERIC, stays NUMERIC for compatible values
                expect(type.dbType).toBe('NUMERIC');
            });

            it('should detect DATETIME when first value has time', () => {
                const chooser = new ColumnTypeChooser();
                // When first value is datetime, it should detect DATETIME directly
                const type = chooser.refreshCurrentType('2024-06-07 14:30');
            expect(type.dbType).toBe('DATETIME');
        });
    });

    describe('NetezzaImporter (CSV path)', () => {
        let tempDir: string;

        const writeTempFile = (fileName: string, content: string): string => {
            const filePath = path.join(tempDir, fileName);
            fs.writeFileSync(filePath, content, 'utf-8');
            return filePath;
        };

        beforeEach(() => {
            tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'netezza-importer-test-'));
        });

        afterEach(() => {
            fs.rmSync(tempDir, { recursive: true, force: true });
        });

        it('detects CSV delimiter and creates log directory in constructor', () => {
            const csvPath = writeTempFile('data.csv', 'A;B;C\n1;2;3\n');
            const logDir = path.join(tempDir, 'logs');
            const importer = new NetezzaImporter(csvPath, 'TEST_TABLE', logDir);

            expect(importer.getCsvDelimiter()).toBe(';');
            expect(importer.getExternalDelimiter()).toBe(';');
            expect(fs.existsSync(logDir)).toBe(true);
        });

        it('analyzes types, normalizes headers and tracks rows count', async () => {
            const csvPath = writeTempFile('headers.csv', '1col,Name With Space,_private\n123,John,abc\n456,Jane,def\n');
            const importer = new NetezzaImporter(csvPath, 'TEST_TABLE');
            const types = await importer.analyzeDataTypes();

            expect(types).toHaveLength(3);
            expect(importer.getSqlHeaders()).toEqual(['COL_1COL', 'NAME_WITH_SPACE', 'COL_PRIVATE']);
            expect(importer.getRowsCount()).toBe(2);
        });

        it('formats DATETIME and NUMERIC values according to detected column types', async () => {
            const csvPath = writeTempFile('format.csv', 'dt;num\n07.06.2024 14:30;1,23\n');
            const importer = new NetezzaImporter(csvPath, 'TEST_TABLE');
            await importer.analyzeDataTypes();

            expect(importer.formatValue('08.06.2024 05:06', 0)).toBe('2024-06-08 05:06:00');
            expect(importer.formatValue('12,3456', 1)).toBe('12.34');
        });

        it('keeps columns with visible leading zeros as text during file analysis', async () => {
            const csvPath = writeTempFile('leading-zero.csv', 'code,name\n0123,John\n1234,Jane\n');
            const importer = new NetezzaImporter(csvPath, 'TEST_TABLE');
            await importer.analyzeDataTypes();

            expect(importer.getColumnMappings()[0]?.dataType).toBe('NVARCHAR(20)');
            expect(importer.formatValue('0123', 0)).toBe('0123');
        });

        it('forces text type for PESEL-style headers during file analysis', async () => {
            const csvPath = writeTempFile('pesel.csv', 'PESEL_ID,amount\n12345678901,1\n22345678901,2\n');
            const importer = new NetezzaImporter(csvPath, 'TEST_TABLE');
            await importer.analyzeDataTypes();

            expect(importer.getColumnMappings()[0]?.dataType).toBe('NVARCHAR(20)');
            expect(importer.getColumnMappings()[1]?.dataType).toBe('BIGINT');
        });

        it('generates CREATE TABLE SQL with quoted identifiers and detected delimiter', async () => {
            const csvPath = writeTempFile('sql.csv', 'id;full name\n1;John\n');
            const importer = new NetezzaImporter(csvPath, 'MYDB.PUBLIC.ORDER ITEMS');
            await importer.analyzeDataTypes();

            const createSql = importer.generateCreateTableSql();
            expect(createSql).toContain('CREATE TABLE "MYDB"."PUBLIC"."ORDER ITEMS"');
            expect(createSql).toContain('DELIMITER \';\'');
            expect(createSql).toContain('"FULL_NAME"');
        });

        it('creates stream that skips header and returns rows with detected delimiter', async () => {
            const csvPath = writeTempFile('stream.csv', 'A,B\n1,2\n3,4\n');
            const importer = new NetezzaImporter(csvPath, 'TEST_TABLE');
            await importer.analyzeDataTypes();

            const stream = await importer.createDataStream();
            let output = '';
            stream.on('data', chunk => {
                output += String(chunk);
            });
            await once(stream, 'end');

            const rows = output.trim().split('\n');
            expect(rows).toHaveLength(2);
            expect(rows[0]).toContain('1,2');
            expect(rows[1]).toContain('3,4');
            expect(importer.getRowsCount()).toBe(2);
        });

        it('applies selected columns and forced types when generating SQL', async () => {
            const csvPath = writeTempFile('custom.sql.csv', 'id;price;note\n1;12,34;x\n');
            const importer = new NetezzaImporter(csvPath, 'TEST_TABLE');
            await importer.analyzeDataTypes();
            importer.applyColumnOptions({
                selectedColumnIndexes: [1, 2],
                forcedColumnTypes: {
                    1: 'NUMERIC(20,4)'
                }
            });

            const createSql = importer.generateCreateTableSql();
            expect(createSql).toContain('CAST("PRICE" AS NUMERIC(20,4)) AS "PRICE"');
            expect(createSql).toContain('"NOTE"');
            expect(createSql).not.toContain('"ID"');
        });

        it('creates stream with only selected columns in selected order', async () => {
            const csvPath = writeTempFile('selected-stream.csv', 'id,price,note\n1,10.50,aaa\n2,20.75,bbb\n');
            const importer = new NetezzaImporter(csvPath, 'TEST_TABLE');
            await importer.analyzeDataTypes();
            importer.applyColumnOptions({
                selectedColumnIndexes: [2, 0]
            });

            const stream = await importer.createDataStream();
            let output = '';
            stream.on('data', chunk => {
                output += String(chunk);
            });
            await once(stream, 'end');

            const rows = output.trim().split('\n');
            expect(rows).toHaveLength(2);
            expect(rows[0]).toContain('aaa,1');
            expect(rows[1]).toContain('bbb,2');
            expect(importer.getImportColumnCount()).toBe(2);
        });

        it('throws error for empty CSV file during analysis', async () => {
            const csvPath = writeTempFile('empty.csv', '');
            const importer = new NetezzaImporter(csvPath, 'TEST_TABLE');
            await expect(importer.analyzeDataTypes()).rejects.toThrow('No data found in file');
        });
    });

    describe('importDataToNetezza validation paths', () => {
        let tempDir: string;

        const validConnection = {
            host: '127.0.0.1',
            port: 5480,
            database: 'TESTDB',
            user: 'admin',
            password: 'secret'
        };

        const writeTempFile = (fileName: string, content: string): string => {
            const filePath = path.join(tempDir, fileName);
            fs.writeFileSync(filePath, content, 'utf-8');
            return filePath;
        };

        beforeEach(() => {
            tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'netezza-import-fn-test-'));
        });

        afterEach(() => {
            jest.restoreAllMocks();
            fs.rmSync(tempDir, { recursive: true, force: true });
        });

        it('returns failure when source file is missing', async () => {
            const missingFile = path.join(tempDir, 'missing.csv');
            const result = await importDataToNetezza(missingFile, 'TEST_TABLE', validConnection);
            expect(result.success).toBe(false);
            expect(result.message).toContain('Source file not found');
        });

        it('returns failure when target table is missing', async () => {
            const csvPath = writeTempFile('sample.csv', 'A,B\n1,2\n');
            const result = await importDataToNetezza(csvPath, '', validConnection);
            expect(result.success).toBe(false);
            expect(result.message).toContain('Target table name is required');
        });

        it('returns failure when connection details are invalid', async () => {
            const csvPath = writeTempFile('sample.csv', 'A,B\n1,2\n');
            const invalidConnection = {
                host: '',
                database: '',
                user: '',
                password: ''
            };
            const result = await importDataToNetezza(csvPath, 'TEST_TABLE', invalidConnection);
            expect(result.success).toBe(false);
            expect(result.message).toContain('Connection details are required');
        });

        it('returns failure for unsupported file formats', async () => {
            const jsonPath = writeTempFile('sample.json', '{"a":1}');
            const result = await importDataToNetezza(jsonPath, 'TEST_TABLE', validConnection);
            expect(result.success).toBe(false);
            expect(result.message).toContain('Unsupported file format');
        });

        it('returns failure result when analysis throws', async () => {
            const csvPath = writeTempFile('sample.csv', 'A,B\n1,2\n');
            jest.spyOn(NetezzaImporter.prototype, 'analyzeDataTypes').mockRejectedValueOnce(new Error('analysis failed'));

            const result = await importDataToNetezza(csvPath, 'TEST_TABLE', validConnection);
            expect(result.success).toBe(false);
            expect(result.message).toContain('analysis failed');
        });
    });
});
});
