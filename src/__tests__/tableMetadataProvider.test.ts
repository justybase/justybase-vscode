import { QueryResult } from '../types';
import { queryResultToRows } from '../core/queryRunner';
import {
    buildColumnMetadataQuery,
    buildTableCommentQuery,
    getTableMetadata,
    parseColumnMetadata,
    parseColumnRow,
    parseTableComment,
    RawColumnRow,
    toWebviewFormat
} from '../providers/tableMetadataProvider';

jest.mock('../core/queryRunner', () => ({
    queryResultToRows: jest.fn()
}));

const queryResultToRowsMock = queryResultToRows as unknown as jest.Mock;

describe('tableMetadataProvider', () => {
    const dummyResult: QueryResult = {
        columns: [],
        data: []
    };

    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('builds table comment query', () => {
        const query = buildTableCommentQuery('DB1', 'PUBLIC', 'ORDERS');

        expect(query).toContain('DB1.._v_object_data');
        expect(query).toContain("objname='ORDERS'");
        expect(query).toContain("schema='PUBLIC'");
    });

    it('builds column metadata query with PK/FK clauses', () => {
        const query = buildColumnMetadataQuery('DB1', 'PUBLIC', 'ORDERS');

        expect(query).toContain('DB1.._V_RELATION_COLUMN');
        expect(query).toContain('MAX(CASE WHEN K.CONTYPE = \'p\' THEN 1 ELSE 0 END) AS IS_PK');
        expect(query).toContain('MAX(CASE WHEN K.CONTYPE = \'f\' THEN 1 ELSE 0 END) AS IS_FK');
        expect(query).toContain('UPPER(\'ORDERS\')');
        expect(query).toContain('UPPER(\'PUBLIC\')');
    });

    it('parses column row with boolean, numeric and string flag variants', () => {
        const fromBoolean = parseColumnRow({
            ATTNAME: 'ID',
            FORMAT_TYPE: 'INTEGER',
            IS_NOT_NULL: true,
            COLDEFAULT: null,
            DESCRIPTION: '',
            IS_PK: 1,
            IS_FK: 0
        });
        const fromNumber = parseColumnRow({
            ATTNAME: 'NAME',
            FORMAT_TYPE: 'VARCHAR(100)',
            IS_NOT_NULL: 1,
            COLDEFAULT: 'N/A',
            DESCRIPTION: 'Name',
            IS_PK: '0',
            IS_FK: '1'
        });
        const fromString = parseColumnRow({
            ATTNAME: 'FLAG',
            FORMAT_TYPE: 'BOOLEAN',
            IS_NOT_NULL: 't',
            COLDEFAULT: '',
            DESCRIPTION: '',
            IS_PK: '0',
            IS_FK: '0'
        });

        expect(fromBoolean.isNotNull).toBe(true);
        expect(fromNumber.isNotNull).toBe(true);
        expect(fromNumber.isFk).toBe(true);
        expect(fromNumber.colDefault).toBe('N/A');
        expect(fromString.isNotNull).toBe(true);
        expect(fromString.colDefault).toBeNull();
    });

    it('parses table comment and handles empty cases', () => {
        expect(parseTableComment(undefined)).toBeNull();

        queryResultToRowsMock.mockReturnValue([{ DESCRIPTION: 'Table comment' }]);
        expect(parseTableComment(dummyResult)).toBe('Table comment');

        queryResultToRowsMock.mockReturnValue([{ DESCRIPTION: '' }]);
        expect(parseTableComment(dummyResult)).toBeNull();

        queryResultToRowsMock.mockReturnValue([]);
        expect(parseTableComment(dummyResult)).toBeNull();
    });

    it('parses column metadata from result rows', () => {
        const rows: RawColumnRow[] = [
            {
                ATTNAME: 'ID',
                FORMAT_TYPE: 'INTEGER',
                IS_NOT_NULL: 1,
                COLDEFAULT: null,
                DESCRIPTION: 'Identifier',
                IS_PK: 1,
                IS_FK: 0
            },
            {
                ATTNAME: 'ORDER_ID',
                FORMAT_TYPE: 'INTEGER',
                IS_NOT_NULL: 0,
                COLDEFAULT: null,
                DESCRIPTION: '',
                IS_PK: 0,
                IS_FK: 1
            }
        ];
        queryResultToRowsMock.mockReturnValue(rows);

        const parsed = parseColumnMetadata(dummyResult);

        expect(parsed).toHaveLength(2);
        expect(parsed[0]).toEqual(
            expect.objectContaining({
                attname: 'ID',
                isPk: true,
                isFk: false,
                isNotNull: true
            })
        );
        expect(parsed[1].isFk).toBe(true);
    });

    it('returns empty metadata on parsing errors', () => {
        const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
        queryResultToRowsMock.mockImplementation(() => {
            throw new Error('parse failed');
        });

        expect(parseColumnMetadata(dummyResult)).toEqual([]);
        expect(consoleSpy).toHaveBeenCalled();
    });

    it('fetches complete table metadata using both queries', async () => {
        const runQueryFn = jest.fn(async (query: string) => {
            if (query.includes('_v_object_data')) {
                return { columns: [{ name: 'DESCRIPTION' }], data: [['Orders table']] } as QueryResult;
            }
            return { columns: [{ name: 'ATTNAME' }], data: [['ID']] } as QueryResult;
        });

        queryResultToRowsMock
            .mockReturnValueOnce([{ DESCRIPTION: 'Orders table' }])
            .mockReturnValueOnce([
                {
                    ATTNAME: 'ID',
                    FORMAT_TYPE: 'INTEGER',
                    IS_NOT_NULL: 1,
                    COLDEFAULT: null,
                    DESCRIPTION: 'Identifier',
                    IS_PK: 1,
                    IS_FK: 0
                }
            ]);

        const metadata = await getTableMetadata(runQueryFn, 'DB1', 'PUBLIC', 'ORDERS');

        expect(runQueryFn).toHaveBeenCalledTimes(2);
        expect(metadata.tableComment).toBe('Orders table');
        expect(metadata.columns).toHaveLength(1);
        expect(metadata.columns[0].attname).toBe('ID');
    });

    it('converts metadata to webview format', () => {
        const formatted = toWebviewFormat([
            {
                attname: 'ID',
                formatType: 'INTEGER',
                isNotNull: true,
                colDefault: null,
                description: 'Identifier',
                isPk: true,
                isFk: false
            }
        ]);

        expect(formatted).toEqual([
            {
                ATTNAME: 'ID',
                FORMAT_TYPE: 'INTEGER',
                IS_NOT_NULL: 1,
                COLDEFAULT: null,
                DESCRIPTION: 'Identifier',
                IS_PK: 1,
                IS_FK: 0
            }
        ]);
    });
});
