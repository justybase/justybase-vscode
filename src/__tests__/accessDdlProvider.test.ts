import type {
    DatabaseCommand,
    DatabaseConnection,
    DatabaseDataReader,
} from '../contracts/database';
import { accessDdlProvider } from '../../extensions/access/src/accessDdlProvider';
import { accessMetadataProvider } from '../../extensions/access/src/accessSchemaProvider';

interface TableColumnRow {
    ATTNAME?: string;
    FORMAT_TYPE?: string;
    IS_NOT_NULL?: number | string;
    IS_PK?: number | string;
    IS_AUTO?: number | string;
    IS_CALC?: number | string;
    ATTNUM?: number | string;
}

interface ViewSourceRow {
    NAME?: string;
    SOURCE?: string | null;
}

interface RelationshipRow {
    RELATIONSHIP?: string;
    TABLE?: string;
    COLUMN?: string;
    FOREIGN_TABLE?: string;
    FOREIGN_COLUMN?: string;
    ENFORCED?: number | string;
}

const TABLE_COLUMNS = ['ATTNAME', 'FORMAT_TYPE', 'FULL_TYPE', 'IS_NOT_NULL', 'COLDEFAULT', 'DESCRIPTION', 'IS_PK', 'IS_FK', 'ATTNUM', 'IS_AUTO', 'IS_CALC'];
const VIEW_SOURCE_COLUMNS = ['NAME', 'SCHEMA', 'DATABASE', 'SOURCE'];
const RELATIONSHIP_COLUMNS = ['RELATIONSHIP', 'TABLE', 'COLUMN', 'FOREIGN_TABLE', 'FOREIGN_COLUMN', 'ENFORCED', 'UPDATE_CASCADE', 'DELETE_CASCADE'];

function columnRows(rows: TableColumnRow[]): unknown[][] {
    return rows.map(row => [
        row.ATTNAME,
        row.FORMAT_TYPE,
        row.FORMAT_TYPE,
        row.IS_NOT_NULL ?? 0,
        null,
        null,
        row.IS_PK ?? 0,
        0,
        row.ATTNUM,
        row.IS_AUTO ?? 0,
        row.IS_CALC ?? 0,
    ]);
}

class FakeReader implements DatabaseDataReader {
    public readonly fieldCount: number;
    private _readIndex = -1;

    public constructor(
        private readonly _columns: string[],
        private readonly _rows: unknown[][],
    ) {
        this.fieldCount = _columns.length;
    }

    public async read(): Promise<boolean> {
        if (this._readIndex + 1 >= this._rows.length) {
            return false;
        }
        this._readIndex++;
        return true;
    }

    public async nextResult(): Promise<boolean> {
        return false;
    }

    public async close(): Promise<void> {
        // no-op
    }

    public getName(index: number): string {
        return this._columns[index] ?? '';
    }

    public getTypeName(_index: number): string {
        return 'VARCHAR';
    }

    public getValue(index: number): unknown {
        return this._readIndex >= 0 ? this._rows[this._readIndex]?.[index] : undefined;
    }
}

class FakeCommand implements DatabaseCommand {
    public commandTimeout = 0;
    public _recordsAffected = -1;

    public constructor(
        private readonly _sql: string,
        private readonly _handler: (sql: string) => DatabaseDataReader,
    ) {}

    public async executeReader(): Promise<DatabaseDataReader> {
        return this._handler(this._sql);
    }

    public async cancel(): Promise<void> {
        // no-op
    }

    public async execute(): Promise<void> {
        const reader = await this.executeReader();
        await reader.close();
    }
}

function tableNameFromQuery(sql: string): string {
    const match = sql.match(/TABLE = '((?:[^']|'')*)'/);
    return match ? match[1].replace(/''/g, "'") : '';
}

class FakeAccessConnection implements DatabaseConnection {
    public _connected = true;

    public constructor(
        private readonly _tables: Record<string, TableColumnRow[]>,
        private readonly _views: ViewSourceRow[] = [],
        private readonly _relationships: RelationshipRow[] = [],
    ) {}

    public async connect(): Promise<void> {
        // no-op
    }

    public async close(): Promise<void> {
        // no-op
    }

    public on(): void {
        // no-op
    }

    public removeListener(): void {
        // no-op
    }

    public createCommand(sql: string): DatabaseCommand {
        return new FakeCommand(sql, resolved => {
            if (resolved.includes('_access_metadata.table_columns')) {
                const tableName = tableNameFromQuery(resolved);
                return new FakeReader(TABLE_COLUMNS, columnRows(this._tables[tableName] ?? []));
            }
            if (resolved.includes('_access_metadata.view_source_search')) {
                return new FakeReader(VIEW_SOURCE_COLUMNS, this._views.map(view => [view.NAME, 'default', 'default', view.SOURCE ?? null]));
            }
            if (resolved.includes('_access_metadata.relationships')) {
                return new FakeReader(RELATIONSHIP_COLUMNS, this._relationships.map(relationship => [
                    relationship.RELATIONSHIP,
                    relationship.TABLE,
                    relationship.COLUMN,
                    relationship.FOREIGN_TABLE,
                    relationship.FOREIGN_COLUMN,
                    relationship.ENFORCED ?? 1,
                    0,
                    0,
                ]));
            }
            throw new Error(`Unexpected fake query: ${resolved}`);
        });
    }
}

describe('accessDdlProvider', () => {
    describe('identifier quoting', () => {
        it('wraps names in Access brackets and escapes closing brackets', () => {
            expect(accessDdlProvider.quoteNameIfNeeded('Order Details')).toBe('[Order Details]');
            expect(accessDdlProvider.quoteNameIfNeeded('Weird]Name')).toBe('[Weird]]Name]');
        });

        it('builds flat-schema and mirror-executable stats queries', () => {
            expect(accessDdlProvider.buildFindTableSchemaQuery('db', 'T')).toContain("'default'");
            expect(accessDdlProvider.buildTableStatsQuery('db', 'default', 'Orders')).toBe(
                'SELECT COUNT(*) AS ROW_COUNT FROM [Orders]',
            );
            expect(accessDdlProvider.buildSkewCheckQuery('[Orders]')).toContain('DATASLICEID');
        });
    });

    describe('getColumns', () => {
        const columns = [
            { ATTNAME: 'ID', FORMAT_TYPE: 'LONG', IS_NOT_NULL: 1, IS_PK: 1, IS_AUTO: 1, ATTNUM: 1 },
            { ATTNAME: 'SKU', FORMAT_TYPE: 'VARCHAR(10)', IS_NOT_NULL: 1, IS_PK: 0, ATTNUM: 2 },
            { ATTNAME: 'Amount', FORMAT_TYPE: 'DECIMAL(18,2)', ATTNUM: 3 },
            { ATTNAME: 'Active', FORMAT_TYPE: 'BOOLEAN', ATTNUM: 4 },
            { ATTNAME: 'Memo', FORMAT_TYPE: 'MEMO', ATTNUM: 5 },
        ];

        it('maps Access FORMAT_TYPE values to replayable DDL type names', async () => {
            const connection = new FakeAccessConnection({ Products: columns });
            const result = await accessDdlProvider.getColumns(connection, 'default', 'default', 'Products');

            expect(result.map(column => column.fullTypeName)).toEqual([
                'COUNTER',
                'TEXT(10)',
                'DECIMAL(18,2)',
                'BOOLEAN',
                'MEMO',
            ]);
            expect(result[0]).toMatchObject({ name: 'ID', notNull: true, defaultValue: null });
            expect(result[1]).toMatchObject({ name: 'SKU', notNull: true });
        });

        it('keeps GUID type for ReplicationID AutoNumber columns', async () => {
            const connection = new FakeAccessConnection({
                Items: [{ ATTNAME: 'Token', FORMAT_TYPE: 'GUID', IS_AUTO: 1, ATTNUM: 1 }],
            });
            const result = await accessDdlProvider.getColumns(connection, 'default', 'default', 'Items');
            expect(result[0]?.fullTypeName).toBe('GUID');
        });

        it('documents calculated fields instead of emitting a wrong column', async () => {
            const connection = new FakeAccessConnection({
                People: [
                    { ATTNAME: 'id', FORMAT_TYPE: 'LONG', IS_AUTO: 1, ATTNUM: 1 },
                    { ATTNAME: 'age', FORMAT_TYPE: 'SHORT', ATTNUM: 2 },
                    { ATTNAME: 'age_times_2', FORMAT_TYPE: 'LONG', IS_CALC: 1, ATTNUM: 3 },
                ],
            });
            const result = await accessDdlProvider.getColumns(connection, 'default', 'default', 'People');
            expect(result[2]?.fullTypeName).toBe('CALCULATED');

            const ddl = await accessDdlProvider.generateTableDDL(connection, 'default', 'default', 'People');
            expect(ddl).toContain('-- [age_times_2] — calculated field; cannot be recreated through Access DDL');
            expect(ddl).toContain('CREATE TABLE [People] (');
            expect(ddl).not.toContain('[age_times_2] LONG');
        });

        it('escapes literal quotes inside table names', async () => {
            const connection = new FakeAccessConnection({ "O'Reilly": columns });
            await expect(accessDdlProvider.getColumns(connection, 'default', 'default', "O'Reilly")).resolves.toHaveLength(5);
        });

        it('appends foreign-key constraints to generated table DDL', async () => {
            const connection = new FakeAccessConnection(
                { Orders: [{ ATTNAME: 'CustomerID', FORMAT_TYPE: 'LONG', ATTNUM: 1 }] },
                [],
                [{ RELATIONSHIP: 'FK_Orders_Customers', TABLE: 'Orders', COLUMN: 'CustomerID', FOREIGN_TABLE: 'Customers', FOREIGN_COLUMN: 'ID', ENFORCED: 1 }],
            );
            const ddl = await accessDdlProvider.generateTableDDL(connection, 'default', 'default', 'Orders');
            expect(ddl).toContain('CREATE TABLE [Orders] (');
            expect(ddl).toContain(
                'ALTER TABLE [Orders] ADD CONSTRAINT [FK_Orders_Customers] FOREIGN KEY ([CustomerID]) REFERENCES [Customers] ([ID]);',
            );
        });
    });

    describe('getKeysInfo', () => {
        it('returns a single PRIMARY KEY entry ordered by ATTNUM', async () => {
            const connection = new FakeAccessConnection({
                Orders: [
                    { ATTNAME: 'A', IS_PK: 1, ATTNUM: 2 },
                    { ATTNAME: 'B', IS_PK: 1, ATTNUM: 1 },
                    { ATTNAME: 'C', IS_PK: 0, ATTNUM: 3 },
                ],
            });
            const keys = await accessDdlProvider.getKeysInfo(connection, 'default', 'default', 'Orders');
            const primary = keys.get('PRIMARY');
            expect(primary).toBeDefined();
            expect(primary?.columns).toEqual(['B', 'A']);
            expect(primary?.typeChar).toBe('P');
        });

        it('returns an empty map when the table has no primary key', async () => {
            const connection = new FakeAccessConnection({
                Plain: [{ ATTNAME: 'X', IS_PK: 0, ATTNUM: 1 }],
            });
            const keys = await accessDdlProvider.getKeysInfo(connection, 'default', 'default', 'Plain');
            expect(keys.size).toBe(0);
        });
    });

    describe('buildTableDDLFromCache / generateTableDDL', () => {
        const columns = [
            { ATTNAME: 'ID', FORMAT_TYPE: 'LONG', IS_NOT_NULL: 1, IS_PK: 1, IS_AUTO: 1, ATTNUM: 1 },
            { ATTNAME: 'Name', FORMAT_TYPE: 'VARCHAR(50)', IS_NOT_NULL: 1, IS_PK: 0, ATTNUM: 2 },
            { ATTNAME: 'Price', FORMAT_TYPE: 'CURRENCY', IS_NOT_NULL: 0, ATTNUM: 3 },
        ];

        it('generates CREATE TABLE with inline single-column primary key', async () => {
            const connection = new FakeAccessConnection({ Products: columns });
            const ddl = await accessDdlProvider.generateTableDDL(connection, 'default', 'default', 'Products');

            expect(ddl).toBe([
                'CREATE TABLE [Products] (',
                '    [ID] COUNTER PRIMARY KEY,',
                '    [Name] TEXT(50) NOT NULL,',
                '    [Price] CURRENCY',
                ');',
            ].join('\n'));
        });

        it('emits a table-level PRIMARY KEY with NOT NULL for composite-key columns', async () => {
            const composite = [
                { ATTNAME: 'A', FORMAT_TYPE: 'SHORT', IS_PK: 1, ATTNUM: 1 },
                { ATTNAME: 'B', FORMAT_TYPE: 'SHORT', IS_PK: 1, ATTNUM: 2 },
            ];
            const connection = new FakeAccessConnection({ Pair: composite });
            const ddl = await accessDdlProvider.generateTableDDL(connection, 'default', 'default', 'Pair');

            expect(ddl).toContain('    [A] SHORT NOT NULL,\n    [B] SHORT NOT NULL,\n    PRIMARY KEY ([A], [B])\n);');
            expect(ddl).not.toContain('PRIMARY KEY,');
        });

        it('emits NOT NULL for non-AutoNumber primary-key columns', async () => {
            const textPk = [
                { ATTNAME: 'Code', FORMAT_TYPE: 'VARCHAR(255)', IS_NOT_NULL: 1, IS_PK: 1, ATTNUM: 1 },
            ];
            const connection = new FakeAccessConnection({ Lookup: textPk });
            const ddl = await accessDdlProvider.generateTableDDL(connection, 'default', 'default', 'Lookup');

            expect(ddl).toContain('[Code] TEXT(255) NOT NULL PRIMARY KEY');
        });

        it('keeps AutoNumber primary-key columns without NOT NULL', async () => {
            const counterPk = [
                { ATTNAME: 'ID', FORMAT_TYPE: 'LONG', IS_NOT_NULL: 1, IS_PK: 1, IS_AUTO: 1, ATTNUM: 1 },
                { ATTNAME: 'Name', FORMAT_TYPE: 'VARCHAR(50)', IS_NOT_NULL: 1, IS_PK: 0, ATTNUM: 2 },
            ];
            const connection = new FakeAccessConnection({ Headers: counterPk });
            const ddl = await accessDdlProvider.generateTableDDL(connection, 'default', 'default', 'Headers');

            expect(ddl).toContain('[ID] COUNTER PRIMARY KEY');
            expect(ddl).toContain('[Name] TEXT(50) NOT NULL');
            expect(ddl).not.toContain('COUNTER NOT NULL');
        });

        it('builds DDL from cached columns and keys without a connection', () => {
            const ddl = accessDdlProvider.buildTableDDLFromCache(
                'default',
                'default',
                'Orders',
                [
                    { name: 'ID', description: null, fullTypeName: 'COUNTER', notNull: true, defaultValue: null },
                    { name: 'When', description: null, fullTypeName: 'DATETIME', notNull: false, defaultValue: null },
                ],
                [],
                [],
                new Map([['PRIMARY', {
                    type: 'PRIMARY KEY',
                    typeChar: 'P',
                    columns: ['ID'],
                    pkDatabase: null,
                    pkSchema: null,
                    pkRelation: null,
                    pkColumns: [],
                    updateType: '',
                    deleteType: '',
                }]]),
            );

            expect(ddl).toContain('[ID] COUNTER PRIMARY KEY');
            expect(ddl).toContain('[When] DATETIME');
        });

        it('throws when the table exposes no readable columns', async () => {
            const connection = new FakeAccessConnection({});
            await expect(accessDdlProvider.generateTableDDL(connection, 'default', 'default', 'Missing')).rejects.toThrow(
                /no readable columns/,
            );
        });
    });

    describe('generateViewDDL', () => {
        it('emits CREATE VIEW from the saved-query source', async () => {
            const connection = new FakeAccessConnection(
                {},
                [{ NAME: 'Big Customers', SOURCE: 'SELECT [Name] FROM [Customers] WHERE [Total] > 1000' }],
            );
            const ddl = await accessDdlProvider.generateViewDDL(connection, 'default', 'default', 'Big Customers');

            expect(ddl).toBe(
                'CREATE VIEW [Big Customers] AS\nSELECT [Name] FROM [Customers] WHERE [Total] > 1000;',
            );
        });

        it('strips a leading PARAMETERS clause before CREATE VIEW', async () => {
            const connection = new FakeAccessConnection(
                {},
                [{ NAME: 'ParamView', SOURCE: 'PARAMETERS [@min] LONG;\nSELECT [ID] FROM [T] WHERE [ID] > [@min]' }],
            );
            const ddl = await accessDdlProvider.generateViewDDL(connection, 'default', 'default', 'ParamView');

            expect(ddl).toBe('CREATE VIEW [ParamView] AS\nSELECT [ID] FROM [T] WHERE [ID] > [@min];');
            expect(ddl).not.toContain('PARAMETERS');
        });

        it('throws when the saved-query source is unavailable', async () => {
            const connection = new FakeAccessConnection({}, []);
            await expect(accessDdlProvider.generateViewDDL(connection, 'default', 'default', 'Missing')).rejects.toThrow(
                /view text is unavailable/,
            );
        });
    });

    describe('unsupported object types', () => {
        it('rejects procedures, external tables and synonyms', async () => {
            const connection = new FakeAccessConnection({});
            await expect(accessDdlProvider.generateProcedureDDL(connection, 'default', 'default', 'P')).rejects.toThrow(/stored procedures/);
            await expect(accessDdlProvider.generateExternalTableDDL(connection, 'default', 'default', 'T')).rejects.toThrow(/not implemented/);
            await expect(accessDdlProvider.generateSynonymDDL(connection, 'default', 'default', 'S')).rejects.toThrow(/synonyms/);
        });
    });

    describe('metadata marker shape', () => {
        it('keeps schema-provider markers aligned with the DDL column row layout', () => {
            expect(accessMetadataProvider.buildTableColumnsQuery('default', 'default', 'Products')).toContain(
                '_access_metadata.table_columns',
            );
            expect(accessMetadataProvider.buildColumnMetadataQuery('default', 'default', 'Products')).toContain(
                '_access_metadata.column_metadata',
            );
            expect(accessMetadataProvider.buildViewSourceSearchQuery('default', {
                rawTerm: 'CUSTOMERS',
                likePattern: '%CUSTOMERS%',
                useServerSideFilter: false,
            })).toContain('SERVER_SIDE = 0');
        });
    });
});
