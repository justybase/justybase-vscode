import { describe, expect, it } from '@jest/globals';
import {
    buildTableMetadataCommentBlock,
    getColumnTypeSymbol,
} from '../commands/schema/tableMetadataCommentBuilder';

describe('buildTableMetadataCommentBlock', () => {
    it('builds formatted SQL comment with icons, bullets, and key summary', () => {
        const comment = buildTableMetadataCommentBlock({
            tableName: 'DIMACCOUNT',
            qualifiedName: 'JUST_DATA_2.ADMIN.DIMACCOUNT',
            tableDescription: 'xyz',
            objectType: 'TABLE',
            columns: [
                {
                    name: 'ACCOUNTKEY',
                    dataType: 'BIGINT',
                    isPk: true,
                    isDistributionKey: true,
                },
                {
                    name: 'PARENTACCOUNTKEY',
                    dataType: 'BIGINT',
                    isFk: true,
                },
                {
                    name: 'ACCOUNTDESCRIPTION',
                    dataType: 'VARCHAR(80)',
                    description: 'Account label',
                },
            ],
        });

        expect(comment).toContain('🗃  TABLE  DIMACCOUNT');
        expect(comment).toContain('└─ JUST_DATA_2.ADMIN.DIMACCOUNT');
        expect(comment).toContain('└─ xyz');
        expect(comment).toContain('COLUMNS');
        expect(comment).toContain('• 🔢 ACCOUNTKEY  ·  `BIGINT`  ·  🔑 PK · ⚡ DIST');
        expect(comment).toContain('• 🔢 PARENTACCOUNTKEY  ·  `BIGINT`  ·  🔗 FK');
        expect(comment).toContain('• 📝 ACCOUNTDESCRIPTION  ·  `VARCHAR(80)`');
        expect(comment).toContain('└─ Account label');
        expect(comment).toContain('KEYS & DISTRIBUTION');
        expect(comment).toContain('• 🔑 Primary key: ACCOUNTKEY');
        expect(comment).toContain('• 🔗 Foreign keys: PARENTACCOUNTKEY');
        expect(comment).toContain('• ⚡ Distribution: ACCOUNTKEY');
        expect(comment.startsWith('/*\n════════════════')).toBe(true);
        expect(comment.endsWith('════════════════════════════════════════\n*/')).toBe(true);
    });

    it('uses view icon for views', () => {
        const comment = buildTableMetadataCommentBlock({
            tableName: 'V_SALES',
            qualifiedName: 'JUST_DATA_2.ADMIN.V_SALES',
            objectType: 'VIEW',
            columns: [],
        });

        expect(comment).toContain('👁  VIEW  V_SALES');
    });

    it('omits duplicate qualified name line when it matches table name', () => {
        const comment = buildTableMetadataCommentBlock({
            tableName: 'DIMACCOUNT',
            qualifiedName: 'DIMACCOUNT',
            columns: [{ name: 'ID', dataType: 'INTEGER' }],
        });

        expect(comment).toContain('• 🔢 ID  ·  `INTEGER`');
        expect(comment).not.toContain('└─ DIMACCOUNT');
    });
});

describe('getColumnTypeSymbol', () => {
    it('maps common data types to symbols', () => {
        expect(getColumnTypeSymbol('INTEGER')).toBe('🔢');
        expect(getColumnTypeSymbol('VARCHAR(80)')).toBe('📝');
        expect(getColumnTypeSymbol('TIMESTAMP')).toBe('📅');
        expect(getColumnTypeSymbol('BOOLEAN')).toBe('☑');
        expect(getColumnTypeSymbol('BYTE')).toBe('⬛');
        expect(getColumnTypeSymbol('UNKNOWN_TYPE')).toBe('◆');
    });
});
