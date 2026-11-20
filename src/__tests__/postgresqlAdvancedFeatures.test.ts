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

    it('normalizes table storage metadata and text-array reloptions', async () => {
        const ddl = postgresqlAdvancedFeatures.ddl!;
        const metadata = await ddl.getTableDefinitionMetadata!(
            createConnection([{
                PERSISTENCE: 'u',
                ACCESS_METHOD: 'heap',
                TABLESPACE: 'fast',
                RELOPTIONS: '{fillfactor=70,autovacuum_enabled=false}',
                PARTITION_KEY: 'RANGE (id)',
            }]),
            'TESTDB',
            'public',
            'orders',
        );

        expect(metadata).toEqual({
            engine: 'heap',
            persistence: 'unlogged',
            accessMethod: 'heap',
            tablespace: 'fast',
            reloptions: ['fillfactor=70', 'autovacuum_enabled=false'],
            partitionBy: 'RANGE (id)',
        });

        await expect(ddl.getTableDefinitionMetadata!(
            createConnection([]),
            'TESTDB',
            'public',
            'missing',
        )).resolves.toBeNull();
    });

    it('preserves identity, generated, collation, storage and table options', () => {
        const ddl = postgresqlAdvancedFeatures.ddl!.buildTableDDLFromCache(
            'TESTDB',
            'public',
            'orders',
            [
                {
                    name: 'id',
                    description: null,
                    fullTypeName: 'bigint',
                    notNull: true,
                    defaultValue: null,
                    identity: 'ALWAYS',
                    identityOptions: ' (INCREMENT BY 2 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 100 CACHE 1 NO CYCLE)',
                },
                {
                    name: 'label',
                    description: null,
                    fullTypeName: 'text',
                    notNull: true,
                    defaultValue: null,
                    collation: 'pg_catalog."C"',
                    storage: 'EXTERNAL',
                    compression: 'pglz',
                },
                {
                    name: 'doubled',
                    description: null,
                    fullTypeName: 'bigint',
                    notNull: false,
                    defaultValue: null,
                    generatedExpression: '(id * 2)',
                    generatedKind: 'STORED',
                },
                {
                    name: 'note',
                    description: null,
                    fullTypeName: 'text',
                    notNull: false,
                    defaultValue: `'draft'::text`,
                },
            ],
            [],
            [],
            new Map(),
            'orders table',
            null,
            {
                engine: 'heap',
                persistence: 'unlogged',
                accessMethod: 'heap',
                tablespace: 'fast',
                reloptions: ['fillfactor=70'],
                partitionBy: 'RANGE (id)',
            },
        );

        expect(ddl).toContain('CREATE UNLOGGED TABLE public.orders');
        expect(ddl).toContain(
            'id bigint GENERATED ALWAYS AS IDENTITY '
            + '(INCREMENT BY 2 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 100 CACHE 1 NO CYCLE) NOT NULL',
        );
        expect(ddl).toContain('label text STORAGE EXTERNAL COMPRESSION pglz COLLATE pg_catalog."C" NOT NULL');
        expect(ddl).toContain('doubled bigint GENERATED ALWAYS AS ((id * 2)) STORED');
        expect(ddl).toContain(`note text DEFAULT 'draft'::text`);
        expect(ddl).toContain('PARTITION BY RANGE (id)');
        expect(ddl).toContain('WITH (fillfactor=70)');
        expect(ddl).toContain('TABLESPACE fast');
        expect(ddl).not.toContain('USING heap');
        expect(ddl).toContain(`COMMENT ON TABLE public.orders IS 'orders table';`);
    });

    it('uses a non-default access method and virtual generated columns', () => {
        const ddl = postgresqlAdvancedFeatures.ddl!.buildTableDDLFromCache(
            'TESTDB',
            'public',
            'events',
            [
                {
                    name: 'payload',
                    description: null,
                    fullTypeName: 'jsonb',
                    notNull: false,
                    defaultValue: null,
                    generatedExpression: 'jsonb_build_object()',
                    generatedKind: 'VIRTUAL',
                },
            ],
            [],
            [],
            new Map(),
            null,
            null,
            {
                engine: 'columnar',
                accessMethod: 'columnar',
            },
        );

        expect(ddl).toContain('GENERATED ALWAYS AS (jsonb_build_object()) VIRTUAL');
        expect(ddl).toContain('USING columnar');
        expect(ddl).toContain('CREATE TABLE public.events');
    });
});
