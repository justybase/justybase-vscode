jest.mock('../../extensions/mssql/src/mssqlConnection', () => {
    type Row = Record<string, unknown>;

    class MockReader {
        private index = -1;

        constructor(private readonly rows: Row[]) {}

        public async read(): Promise<boolean> {
            this.index += 1;
            return this.index < this.rows.length;
        }

        public get fieldCount(): number {
            return Object.keys(this.rows[0] ?? {}).length;
        }

        public getName(index: number): string {
            return Object.keys(this.rows[this.index] ?? this.rows[0] ?? {})[index] ?? '';
        }

        public getValue(index: number): unknown {
            const row = this.rows[this.index] ?? {};
            const key = this.getName(index);
            return row[key];
        }

        public async close(): Promise<void> {}
    }

    const mockMsSqlConnection = jest.fn().mockImplementation((config: { database?: string }) => ({
        connect: jest.fn().mockResolvedValue(undefined),
        close: jest.fn().mockResolvedValue(undefined),
        createCommand: (sql: string) => ({
            executeReader: async () => {
                const normalizedSql = sql.toUpperCase();
                const database = (config.database || '').toUpperCase();

                if (normalizedSql.includes('FROM INFORMATION_SCHEMA.COLUMNS')) {
                    const rows = database === 'TARGETDB'
                        ? [
                            {
                                COLUMN_NAME: 'EMPLOYEE_ID',
                                DATA_TYPE: 'int',
                                CHARACTER_MAXIMUM_LENGTH: null,
                                NUMERIC_PRECISION: null,
                                NUMERIC_SCALE: null,
                                IS_NULLABLE: 'NO',
                                COLUMN_DEFAULT: null,
                                ORDINAL_POSITION: 1
                            },
                            {
                                COLUMN_NAME: 'FULL_NAME',
                                DATA_TYPE: 'nvarchar',
                                CHARACTER_MAXIMUM_LENGTH: 100,
                                NUMERIC_PRECISION: null,
                                NUMERIC_SCALE: null,
                                IS_NULLABLE: 'YES',
                                COLUMN_DEFAULT: null,
                                ORDINAL_POSITION: 2
                            }
                        ]
                        : [];
                    return new MockReader(rows);
                }

                return new MockReader([]);
            }
        })
    }));

    return {
        MsSqlConnection: mockMsSqlConnection,
        __mockMsSqlConnection: mockMsSqlConnection
    };
});

import { mssqlAdvancedFeatures } from '../../extensions/mssql/src/mssqlDdlGenerator';

const {
    __mockMsSqlConnection: mockMsSqlConnection
} = jest.requireMock('../../extensions/mssql/src/mssqlConnection') as {
    __mockMsSqlConnection: jest.Mock;
};

describe('mssqlAdvancedFeatures ddl', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('uses the requested database when generating MSSQL table DDL', async () => {
        const result = await mssqlAdvancedFeatures.ddl!.generateDDL(
            {
                host: 'localhost',
                database: 'master',
                user: 'sa',
                password: 'secret',
                dbType: 'mssql'
            },
            'TARGETDB',
            'dbo',
            'employees',
            'TABLE'
        );

        expect(result.success).toBe(true);
        expect(mockMsSqlConnection).toHaveBeenCalledWith(expect.objectContaining({ database: 'TARGETDB' }));
        expect(result.ddlCode).toContain('CREATE TABLE [dbo].[employees] (');
        expect(result.ddlCode).toContain('[EMPLOYEE_ID] INT NOT NULL');
        expect(result.ddlCode).toContain('[FULL_NAME] NVARCHAR(100)');
    });

    it('returns an error instead of empty MSSQL CREATE TABLE when column metadata is missing', async () => {
        const result = await mssqlAdvancedFeatures.ddl!.generateDDL(
            {
                host: 'localhost',
                database: 'master',
                user: 'sa',
                password: 'secret',
                dbType: 'mssql'
            },
            'EMPTYDB',
            'dbo',
            'employees',
            'TABLE'
        );

        expect(result.success).toBe(false);
        expect(result.error).toContain('did not return any column metadata');
    });
});
