import { oracleBatchImportConfig } from '../import/oracleImporter';
import {
    normalizeImportedLiteralValue,
    normalizeTimestampWithTimeZoneValue,
    type PreparedImportColumnDescriptor,
} from '../import/batchImportSupport';

describe('Oracle batch import support', () => {
    const binaryColumn: PreparedImportColumnDescriptor = {
        sourceIndex: 0,
        columnName: 'PAYLOAD',
        dataType: 'BLOB',
        sourceDataType: 'BLOB',
        targetDataType: 'BLOB',
    };

    it('normalizes timestamp values with offsets without dropping the zone', () => {
        expect(normalizeTimestampWithTimeZoneValue('2026-07-18T12:30:45+02:00'))
            .toBe('2026-07-18 12:30:45 +02:00');
        expect(normalizeImportedLiteralValue(
            '2026-07-18T12:30:45Z',
            'VARCHAR',
            'TIMESTAMP WITH TIME ZONE',
            '.',
        )).toBe('2026-07-18 12:30:45 +00:00');
    });

    it('builds Oracle binary literals from the canonical hex representation', () => {
        expect(oracleBatchImportConfig.toSqlLiteral('hex:CAFE', binaryColumn, '.'))
            .toBe("TO_BLOB(HEXTORAW('CAFE'))");
        expect(() => oracleBatchImportConfig.toSqlLiteral('hex:ABC', binaryColumn, '.'))
            .toThrow(/even-length-hex/);
    });

    it('provides destructive cleanup only for a target created by the import', () => {
        expect(oracleBatchImportConfig.cleanupCreatedTargetOnFailure).toBe(true);
        const target = oracleBatchImportConfig.parseTargetTable('HR.JBL_IMPORT_TEST', {
            dbType: 'oracle',
            host: 'localhost',
            port: 1521,
            database: 'ORCL',
            user: 'TEST',
        });
        expect(oracleBatchImportConfig.buildDropTableSql?.(target)).toBe('DROP TABLE HR.JBL_IMPORT_TEST PURGE');
    });
});
