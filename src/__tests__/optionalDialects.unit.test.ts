import type {
    DatabaseDialect,
    DatabaseMetadataProvider,
    DatabaseSourceSearchQueryOptions,
} from '../contracts/database';
import { getDatabaseDialectByKind, registerDatabaseDialect } from '../core/factories/databaseDialectRegistry';
import { validateDialectTraits } from '../core/dialectTraitsValidator';
import { resetDatabaseDialectTestingState } from './dialectTestUtils';
import { allAvailableDialects } from '../dialects';
import { db2Dialect } from '../../extensions/db2/src/db2Dialect';
import { duckdbDialect } from '../../extensions/duckdb/src/duckdbDialect';
import { mssqlDialect } from '../../extensions/mssql/src/mssqlDialect';
import { mysqlDialect } from '../../extensions/mysql/src/mysqlDialect';
import { oracleDialect } from '../../extensions/oracle/src/oracleDialect';
import { postgresqlDialect } from '../../extensions/postgresql/src/postgresqlDialect';
import { snowflakeDialect } from '../../extensions/snowflake/src/snowflakeDialect';
import { verticaDialect } from '../../extensions/vertica/src/verticaDialect';
import { accessDialect } from '../../extensions/access/src/accessDialect';
import { clickhouseDialect } from '../../extensions/clickhouse/src/clickhouseDialect';

const SOURCE_SEARCH_OPTIONS: DatabaseSourceSearchQueryOptions = {
    rawTerm: 'CUSTOMERS',
    likePattern: '%CUSTOMERS%',
    useServerSideFilter: true,
};

const OPTIONAL_DIALECT_CASES: readonly {
    readonly dialect: DatabaseDialect;
    readonly expectedDefaultPort: number | undefined;
    readonly expectedConnectionFields: readonly string[];
    readonly supportsRawTcpTunnel?: boolean;
}[] = [
    {
        dialect: db2Dialect,
        expectedDefaultPort: 50000,
        expectedConnectionFields: ['host', 'port', 'database', 'user', 'password', 'currentSchema'],
        supportsRawTcpTunnel: true,
    },
    {
        dialect: oracleDialect,
        expectedDefaultPort: 1521,
        expectedConnectionFields: ['host', 'port', 'database', 'user', 'password', 'connectString'],
        supportsRawTcpTunnel: true,
    },
    {
        dialect: postgresqlDialect,
        expectedDefaultPort: 5432,
        expectedConnectionFields: ['host', 'port', 'database', 'user', 'password', 'searchPath'],
        supportsRawTcpTunnel: true,
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
        supportsRawTcpTunnel: true,
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
        supportsRawTcpTunnel: true,
    },
    {
        dialect: accessDialect,
        expectedDefaultPort: undefined,
        expectedConnectionFields: ['filePath', 'password'],
    },
    {
        dialect: clickhouseDialect,
        expectedDefaultPort: 8123,
        expectedConnectionFields: [
            'host',
            'port',
            'database',
            'user',
            'password',
            'protocol',
            'tlsMode',
            'requestTimeout',
            'tlsServerName',
        ],
        supportsRawTcpTunnel: true,
    },
];

describe('database tunnel dialect advertisements', () => {
    it('advertises the tunnel in the core login-panel stubs for network dialects only', () => {
        const advertisedKinds = allAvailableDialects
            .filter((dialect) => dialect.supportsRawTcpTunnel)
            .map((dialect) => dialect.kind);

        expect(advertisedKinds).toEqual([
            'netezza',
            'oracle',
            'postgresql',
            'db2',
            'mssql',
            'mysql',
            'clickhouse',
        ]);

        for (const kind of ['sqlite', 'duckdb', 'file', 'access', 'vertica', 'snowflake'] as const) {
            expect(allAvailableDialects.find((dialect) => dialect.kind === kind)?.supportsRawTcpTunnel).toBeUndefined();
        }
    });
});

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
    ({ dialect, expectedDefaultPort, expectedConnectionFields, supportsRawTcpTunnel }) => {
        beforeEach(() => {
            resetDatabaseDialectTestingState();
        });

        it('registers cleanly and exposes a usable runtime contract', () => {
            const registeredDialect = registerDatabaseDialect(dialect);

            expect(registeredDialect).toBe(dialect);
            expect(getDatabaseDialectByKind(dialect.kind)).toBe(dialect);
            expect(validateDialectTraits(dialect.traits)).toEqual([]);
            expect(dialect.defaultPort).toBe(expectedDefaultPort);
            expect(dialect.supportsRawTcpTunnel).toBe(supportsRawTcpTunnel);
            const fieldKeys = dialect.connectionForm?.fields.map((field) => field.key);
            if (dialect.kind === 'access') {
                expect(fieldKeys).toEqual(['filePath', 'password', 'readOnly']);
            } else {
                expect(fieldKeys).toEqual(expect.arrayContaining(expectedConnectionFields));
            }
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
