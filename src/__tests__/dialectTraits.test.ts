import {
    createDatabaseCapabilities,
    createDatabaseDialectTraits,
    type DatabaseCommand,
    type DatabaseConnection,
    type DatabaseConnectionConfig,
    type DatabaseConnectionStaticConstructor,
    type DatabaseDialect,
    type DatabaseKind,
    SUPPORTED_DATABASE_KINDS,
} from '../contracts/database';
import { beforeEach, describe, expect, it } from '@jest/globals';
import { registerDatabaseDialect } from '../core/factories/databaseDialectRegistry';
import { applyGeneratedIdentifierCase, getDatabaseDialectTraits } from '../core/dialectTraits';
import { validateDialectTraits } from '../core/dialectTraitsValidator';
import { sqliteMetadataProvider } from '../dialects/sqlite/metadata/provider';
import { sqliteSqlAuthoring } from '../dialects/sqlite/sql/authoring';
import { resetDatabaseDialectTestingState } from './dialectTestUtils';

const REPRESENTATIVE_VALID_IDENTIFIERS: Readonly<Record<DatabaseKind, readonly string[]>> = {
    netezza: ['TABLE_NAME', 'ĄĘŚĆĘŃÓŁŻŹ'],
    oracle: ['TABLE_NAME'],
    postgresql: ['table_name'],
    vertica: ['table_name'],
    snowflake: ['TABLE_NAME'],
    sqlite: ['table_name', 'TableName'],
    duckdb: ['table_name', 'TableName'],
    db2: ['TABLE_NAME'],
    mssql: ['TABLE_NAME'],
    mysql: ['table_name', 'TableName'],
};

class MockDialectConnection implements DatabaseConnection {
    constructor(_config: DatabaseConnectionConfig) {}

    async connect(): Promise<void> {}

    async close(): Promise<void> {}

    createCommand(_sql: string): DatabaseCommand {
        return {
            commandTimeout: 0,
            async executeReader() {
                throw new Error('Not implemented for tests.');
            },
            async cancel() {},
            async execute() {},
            _recordsAffected: 0,
        };
    }

    on(_event: string, _listener: (arg: unknown) => void): void {}

    removeListener(_event: string, _listener: (arg: unknown) => void): void {}
}

const mockConnectionConstructor = MockDialectConnection as unknown as DatabaseConnectionStaticConstructor;

function matchesPattern(pattern: RegExp, value: string): boolean {
    const safePattern = new RegExp(pattern.source, pattern.flags.replace(/[gy]/g, ''));
    return safePattern.test(value);
}

describe('dialectTraits', () => {
    beforeEach(() => {
        resetDatabaseDialectTestingState();
    });

    describe.each(SUPPORTED_DATABASE_KINDS)('%s dialect contract', (kind) => {
        it('has all required trait categories', () => {
            const traits = getDatabaseDialectTraits(kind);

            expect(traits.identifiers).toBeDefined();
            expect(traits.qualification).toBeDefined();
            expect(traits.completion).toBeDefined();
            expect(traits.objects).toBeDefined();
        });

        it('accepts representative identifiers and rejects invalid ones', () => {
            const pattern = getDatabaseDialectTraits(kind).identifiers.unquotedIdentifierPattern;

            for (const sample of REPRESENTATIVE_VALID_IDENTIFIERS[kind]) {
                expect(matchesPattern(pattern, sample)).toBe(true);
            }
            expect(matchesPattern(pattern, '123invalid')).toBe(false);
            expect(matchesPattern(pattern, '')).toBe(false);
        });

        it('passes trait validation rules', () => {
            expect(validateDialectTraits(getDatabaseDialectTraits(kind))).toEqual([]);
        });

        it('keeps qualification settings consistent', () => {
            const { qualification } = getDatabaseDialectTraits(kind);

            if (qualification.twoPartNameStyle === 'database-object') {
                expect(qualification.supportsThreePartName).toBe(false);
            }
        });

        it('keeps completion settings consistent', () => {
            const { qualification, completion } = getDatabaseDialectTraits(kind);

            if (completion.singleDotPathNamespace === 'schema-or-database') {
                expect(completion.supportsDoubleDotPath).toBe(true);
                expect(qualification.twoPartNameStyle).toBe('schema-object');
            }
            if (qualification.twoPartNameStyle === 'database-object') {
                expect(completion.singleDotPathNamespace).toBe('database');
            }
        });
    });

    it('rejects invalid trait combinations during dialect registration', () => {
        const invalidDialect: DatabaseDialect = {
            kind: 'db2',
            displayName: 'Broken Db2',
            capabilities: createDatabaseCapabilities(),
            traits: createDatabaseDialectTraits({
                qualification: {
                    twoPartNameStyle: 'database-object',
                    supportsThreePartName: true,
                },
                completion: {
                    singleDotPathNamespace: 'schema-or-database',
                    supportsDoubleDotPath: false,
                },
            }),
            metadataProvider: sqliteMetadataProvider,
            sqlAuthoring: sqliteSqlAuthoring,
            getConnectionConstructor(): DatabaseConnectionStaticConstructor {
                return mockConnectionConstructor;
            },
            createConnection(config: DatabaseConnectionConfig): DatabaseConnection {
                return new MockDialectConnection(config);
            },
        };

        expect(() => registerDatabaseDialect(invalidDialect)).toThrow(/Invalid traits for dialect 'db2'/);
    });

    it('applies dialect-specific generated identifier casing', () => {
        expect(applyGeneratedIdentifierCase('Import_20260321_5750', 'netezza')).toBe('IMPORT_20260321_5750');
        expect(applyGeneratedIdentifierCase('Import_20260321_5750', 'postgresql')).toBe('import_20260321_5750');
        expect(applyGeneratedIdentifierCase('Import_20260321_5750', 'vertica')).toBe('import_20260321_5750');
        expect(applyGeneratedIdentifierCase('Import_20260321_5750', 'sqlite')).toBe('IMPORT_20260321_5750');
        expect(applyGeneratedIdentifierCase('Import_20260321_5750', 'duckdb')).toBe('import_20260321_5750');
    });

    it('treats Netezza single-dot paths as schema-qualified', () => {
        expect(getDatabaseDialectTraits('netezza').completion.singleDotPathNamespace).toBe('schema');
    });
});
