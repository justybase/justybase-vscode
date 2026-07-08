import { postgresqlAdvancedFeatures } from '../../extensions/postgresql/src/postgresqlDdlGenerator';
import type { DatabaseCommand, DatabaseConnection, DatabaseDataReader } from '../contracts/database';

type Row = Record<string, unknown>;

class MockReader implements DatabaseDataReader {
    private index = -1;

    constructor(private readonly rows: readonly Row[]) {}

    public async read(): Promise<boolean> {
        this.index += 1;
        return this.index < this.rows.length;
    }

    public async nextResult(): Promise<boolean> {
        return false;
    }

    public async close(): Promise<void> {}

    public get fieldCount(): number {
        return Object.keys(this.rows[0] ?? {}).length;
    }

    public getName(index: number): string {
        return Object.keys(this.rows[this.index] ?? this.rows[0] ?? {})[index] ?? '';
    }

    public getTypeName(_index: number): string {
        return 'text';
    }

    public getValue(index: number): unknown {
        const row = this.rows[this.index] ?? {};
        return row[this.getName(index)];
    }
}

function createConnection(rows: readonly Row[]): DatabaseConnection {
    return {
        async connect(): Promise<void> {},
        async close(): Promise<void> {},
        createCommand(_sql: string): DatabaseCommand {
            return {
                commandTimeout: 0,
                async executeReader(): Promise<DatabaseDataReader> {
                    return new MockReader(rows);
                },
                async cancel(): Promise<void> {},
                async execute(): Promise<void> {},
                _recordsAffected: 0,
            };
        },
        on(_event: string, _listener: (arg: unknown) => void): void {},
        removeListener(_event: string, _listener: (arg: unknown) => void): void {},
    };
}

describe('postgresqlAdvancedFeatures ddl', () => {
    it('generates CREATE MATERIALIZED VIEW for materialized views', async () => {
        const ddl = await postgresqlAdvancedFeatures.ddl!.generateViewDDL(
            createConnection([
                {
                    VIEW_KIND: 'MATERIALIZED VIEW',
                    VIEW_SQL: 'SELECT id FROM public.orders',
                },
            ]),
            'TESTDB',
            'public',
            'orders_mv',
        );

        expect(ddl).toBe('CREATE MATERIALIZED VIEW public.orders_mv AS\nSELECT id FROM public.orders;');
    });

    it('keeps CREATE OR REPLACE VIEW for standard views', async () => {
        const ddl = await postgresqlAdvancedFeatures.ddl!.generateViewDDL(
            createConnection([
                {
                    VIEW_KIND: 'VIEW',
                    VIEW_SQL: 'SELECT id FROM public.orders',
                },
            ]),
            'TESTDB',
            'public',
            'orders_v',
        );

        expect(ddl).toBe('CREATE OR REPLACE VIEW public.orders_v AS\nSELECT id FROM public.orders;');
    });
});
