import type {
    DatabaseDialect,
    DatabaseMetadataProvider,
    DatabaseSourceSearchQueryOptions,
} from '../contracts/database';
import { getDatabaseDialectByKind, registerDatabaseDialect } from '../core/factories/databaseDialectRegistry';
import { validateDialectTraits } from '../core/dialectTraitsValidator';
import { resetDatabaseDialectTestingState } from './dialectTestUtils';
import { db2Dialect } from '../../extensions/db2/src/db2Dialect';
import { duckdbDialect } from '../../extensions/duckdb/src/duckdbDialect';
import { mssqlDialect } from '../../extensions/mssql/src/mssqlDialect';
import { mysqlDialect } from '../../extensions/mysql/src/mysqlDialect';
import { oracleDialect } from '../../extensions/oracle/src/oracleDialect';
import { postgresqlDialect } from '../../extensions/postgresql/src/postgresqlDialect';
import { snowflakeDialect } from '../../extensions/snowflake/src/snowflakeDialect';
import { verticaDialect } from '../../extensions/vertica/src/verticaDialect';

const SOURCE_SEARCH_OPTIONS: DatabaseSourceSearchQueryOptions = {
    rawTerm: 'CUSTOMERS',
    likePattern: '%CUSTOMERS%',
    useServerSideFilter: true,
};

const OPTIONAL_DIALECT_CASES: readonly {
    readonly dialect: DatabaseDialect;
    readonly expectedDefaultPort: number | undefined;
    readonly expectedConnectionFields: readonly string[];
}[] = [
    {
        dialect: db2Dialect,
        expectedDefaultPort: 50000,
        expectedConnectionFields: ['host', 'port', 'database', 'user', 'password', 'currentSchema'],
    },
    {
        dialect: oracleDialect,
        expectedDefaultPort: 1521,
        expectedConnectionFields: ['host', 'port', 'database', 'user', 'password', 'connectString'],
    },
    {
        dialect: postgresqlDialect,
        expectedDefaultPort: 5432,
        expectedConnectionFields: ['host', 'port', 'database', 'user', 'password', 'searchPath'],
    },
    {
        dialect: verticaDialect,
        expectedDefaultPort: 5433,
        expectedConnectionFields: ['host', 'port', 'database', 'user', 'password', 'searchPath', 'tlsMode'],
    },
    {
        dialect: snowflakeDialect,
        expectedDefaultPort: 443,
        expectedConnectionFields: [
            'host',
            'port',
            'database',
            'user',
            'password',
            'schema',
            'authMode',
            'warehouse',
            'role',
            'oauthToken',
            'privateKeyPath',
            'privateKeyPassphrase',
            'accessUrl',
            'sessionParameters',
        ],
    },
    {
        dialect: mssqlDialect,
        expectedDefaultPort: 1433,
        expectedConnectionFields: ['host', 'port', 'database', 'user', 'password', 'domain'],
    },
    {
        dialect: duckdbDialect,
        expectedDefaultPort: undefined,
        expectedConnectionFields: ['mode', 'database', 'schema'],
    },
    {
        dialect: mysqlDialect,
        expectedDefaultPort: 3306,
        expectedConnectionFields: ['host', 'port', 'database', 'user', 'password', 'connectTimeout'],
    },
];

function expectSqlString(query: string): void {
    expect(typeof query).toBe('string');
    expect(query.trim().length).toBeGreaterThan(0);
}

function expectMetadataProviderSmokeContract(provider: DatabaseMetadataProvider): void {
    expect(provider.defaultObjectTypes.length).toBeGreaterThan(0);
    expect(provider.defaultColumnObjectTypes.length).toBeGreaterThan(0);
    expectSqlString(provider.buildListDatabasesQuery());
    expectSqlString(provider.buildListSchemasQuery('TESTDB'));
    expectSqlString(provider.buildListTablesQuery('TESTDB', 'PUBLIC'));
    expectSqlString(provider.buildListViewsQuery('TESTDB', 'PUBLIC'));
    expectSqlString(provider.buildColumnsWithKeysQuery('TESTDB', { schema: 'PUBLIC', tableName: 'CUSTOMERS' }));
    expectSqlString(provider.buildObjectSearchQuery('TESTDB', '%CUSTOMERS%'));
    expectSqlString(provider.buildViewSourceSearchQuery('TESTDB', SOURCE_SEARCH_OPTIONS));
    expectSqlString(provider.buildProcedureSourceSearchQuery('TESTDB', SOURCE_SEARCH_OPTIONS));
}

describe.each(OPTIONAL_DIALECT_CASES)(
    '$dialect.kind optional dialect runtime',
    ({ dialect, expectedDefaultPort, expectedConnectionFields }) => {
        beforeEach(() => {
            resetDatabaseDialectTestingState();
        });

        it('registers cleanly and exposes a usable runtime contract', () => {
            const registeredDialect = registerDatabaseDialect(dialect);

            expect(registeredDialect).toBe(dialect);
            expect(getDatabaseDialectByKind(dialect.kind)).toBe(dialect);
            expect(validateDialectTraits(dialect.traits)).toEqual([]);
            expect(dialect.defaultPort).toBe(expectedDefaultPort);
            expect(dialect.connectionForm?.fields.map((field) => field.key)).toEqual(
                expect.arrayContaining(expectedConnectionFields),
            );
            expect(typeof dialect.getConnectionConstructor()).toBe('function');
        });

        it('provides metadata provider queries and SQL authoring assets that satisfy the shared contracts', () => {
            registerDatabaseDialect(dialect);

            expectMetadataProviderSmokeContract(dialect.metadataProvider);
            expect(dialect.sqlAuthoring.completionKeywords.length).toBeGreaterThan(0);
            expect(dialect.sqlAuthoring.signatures.size).toBeGreaterThan(0);
            expect(dialect.sqlAuthoring.formatter.keywords.size).toBeGreaterThan(0);
            expect(dialect.sqlAuthoring.validation.builtinFunctions.size).toBeGreaterThan(0);
            expect(Array.isArray(dialect.sqlAuthoring.qualityRules)).toBe(true);
        });
    },
);
