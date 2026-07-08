import type { DatabaseConnection, DatabaseDataReader, DatabaseDdlKeyInfo } from '../contracts/database';
import { db2AdvancedFeatures } from '../../extensions/db2/src/db2DdlGenerator';
import { db2Dialect } from '../../extensions/db2/src/db2Dialect';
import { buildConnectionString, Db2Connection } from '../../extensions/db2/src/db2Connection';
import { db2MetadataProvider } from '../../extensions/db2/src/db2SchemaProvider';
import {
    buildBatchObjectListQuery,
    buildListProceduresQuery,
    buildObjectTypeQuery,
    buildTypeGroupsQuery
} from '../../extensions/db2/src/db2SystemQueries';

function createMockReader(rows: Record<string, unknown>[]): DatabaseDataReader {
    let rowIndex = -1;
    const columns = Object.keys(rows[0] ?? {});

    return {
        fieldCount: columns.length,
        async read(): Promise<boolean> {
            rowIndex += 1;
            return rowIndex < rows.length;
        },
        async nextResult(): Promise<boolean> {
            return false;
        },
        async close(): Promise<void> {
            return;
        },
        getName(index: number): string {
            return columns[index] || '';
        },
        getTypeName(_index: number): string {
            return 'VARCHAR';
        },
        getValue(index: number): unknown {
            const columnName = columns[index];
            return columnName ? rows[rowIndex]?.[columnName] : undefined;
        }
    };
}

function createMockConnection(
    resolvers: Array<{
        match: string | RegExp;
        rows?: Record<string, unknown>[];
        error?: Error;
    }>
): DatabaseConnection {
    const resolveSql = (sql: string): Record<string, unknown>[] => {
        for (const resolver of resolvers) {
            const matches = typeof resolver.match === 'string'
                ? sql.includes(resolver.match)
                : resolver.match.test(sql);
            if (!matches) {
                continue;
            }
            if (resolver.error) {
                throw resolver.error;
            }
            return resolver.rows ?? [];
        }
        return [];
    };

    return {
        async connect(): Promise<void> {
            return;
        },
        async close(): Promise<void> {
            return;
        },
        createCommand(sql: string) {
            return {
                commandTimeout: 0,
                _recordsAffected: 0,
                async executeReader() {
                    return createMockReader(resolveSql(sql));
                },
                async cancel(): Promise<void> {
                    return;
                },
                async execute(): Promise<void> {
                    return;
                }
            };
        },
        on(_event: string, _listener: (arg: unknown) => void): void {
            return;
        },
        removeListener(_event: string, _listener: (arg: unknown) => void): void {
            return;
        }
    };
}

describe('DB2 runtime upgrade surfaces', () => {
    it('exposes new DB2 object groups and table-like column types', () => {
        expect(db2MetadataProvider.defaultObjectTypes).toEqual([
            'TABLE',
            'VIEW',
            'NICKNAME',
            'ALIAS',
            'PROCEDURE',
            'FUNCTION',
            'SERVER',
            'SERVER OPTION',
            'WRAPPER',
            'WRAPPER OPTION',
            'USER MAPPING',
            'PASSTHRU AUTH'
        ]);
        expect(db2MetadataProvider.defaultColumnObjectTypes).toEqual(['TABLE', 'VIEW', 'NICKNAME', 'ALIAS']);
    });

    it('keeps DB2 lookup queries aware of database, schema, and table inputs', () => {
        const query = db2MetadataProvider.buildLookupColumnsQuery({
            database: 'TESTDB',
            schema: 'DB2INST1',
            tableName: 'EM'
        });

        expect(query).toContain("'TESTDB' AS DATABASE");
        expect(query).toContain("C.TABSCHEMA = 'DB2INST1'");
        expect(query).toContain("C.TABNAME = 'EM'");
        expect(query).toContain("T.TYPE IN ('T', 'V', 'N', 'A')");
    });

    it('builds separate object queries for DB2 federated and schema-scoped groups', () => {
        expect(buildObjectTypeQuery('NICKNAME')).toContain("TYPE IN ('N')");
        expect(buildObjectTypeQuery('ALIAS')).toContain("TYPE IN ('A')");
        expect(buildObjectTypeQuery('PROCEDURE')).toContain('WITH ROUTINE_SIGNATURES');
        expect(buildObjectTypeQuery('FUNCTION')).toContain("ROUTINETYPE = 'F'");
        expect(buildObjectTypeQuery('SERVER')).toContain('FROM SYSCAT.SERVERS');
        expect(buildObjectTypeQuery('SERVER OPTION')).toContain('FROM SYSCAT.SERVEROPTIONS');
        expect(buildObjectTypeQuery('WRAPPER')).toContain('FROM SYSCAT.WRAPPERS');
        expect(buildObjectTypeQuery('WRAPPER OPTION')).toContain('FROM SYSCAT.WRAPOPTIONS');
        expect(buildObjectTypeQuery('USER MAPPING')).toContain('FROM SYSCAT.USEROPTIONS');
        expect(buildObjectTypeQuery('PASSTHRU AUTH')).toContain('FROM SYSCAT.PASSTHRUAUTH');
    });

    it('threads the requested database through DB2 object queries', () => {
        expect(buildObjectTypeQuery('TABLE', 'TESTDB')).toContain("'TESTDB' AS DATABASE");
        expect(db2MetadataProvider.buildObjectTypeQuery('TESTDB', 'TABLE')).toContain("'TESTDB' AS DATABASE");
        expect(db2MetadataProvider.buildTypeGroupsQuery('TESTDB')).toContain("SELECT 'TABLE' AS OBJTYPE");
    });

    it('advertises the expanded DB2 type groups', () => {
        const query = buildTypeGroupsQuery();

        expect(query).toContain("SELECT 'NICKNAME' AS OBJTYPE");
        expect(query).toContain("SELECT 'ALIAS' AS OBJTYPE");
        expect(query).toContain("SELECT 'SERVER' AS OBJTYPE");
        expect(query).toContain("SELECT 'SERVER OPTION' AS OBJTYPE");
        expect(query).toContain("SELECT 'WRAPPER' AS OBJTYPE");
        expect(query).toContain("SELECT 'WRAPPER OPTION' AS OBJTYPE");
        expect(query).toContain("SELECT 'FUNCTION' AS OBJTYPE");
        expect(query).toContain("SELECT 'USER MAPPING' AS OBJTYPE");
        expect(query).toContain("SELECT 'PASSTHRU AUTH' AS OBJTYPE");
    });

    it('includes aliases, nicknames, and functions in batch object export queries', () => {
        const query = buildBatchObjectListQuery('DB2INST1', ['TABLE', 'NICKNAME', 'ALIAS', 'FUNCTION']);

        expect(query).toContain("TYPE IN ('T', 'N', 'A')");
        expect(query).toContain("TABSCHEMA = 'DB2INST1'");
        expect(query).toContain("THEN 'NICKNAME'");
        expect(query).toContain("THEN 'ALIAS'");
        expect(query).toContain("ROUTINETYPE IN ('F')");
        expect(query).toContain("THEN 'FUNCTION'");
    });

    it('builds overload-safe DB2 procedure signatures from catalog metadata', () => {
        const query = buildListProceduresQuery('DB2INST1');

        expect(query).toContain('PROCEDURESIGNATURE');
        expect(query).toContain('WITH ROUTINE_SIGNATURES');
        expect(query).toContain('LISTAGG');
        expect(query).toContain("P.ROWTYPE IN ('P', 'B', 'O')");
        expect(query).toContain("R.ROUTINETYPE = 'P'");
        expect(query).toContain("R.ROUTINESCHEMA = 'DB2INST1'");
    });

    it('includes DB2 federated objects and routines in default batch export queries', () => {
        const query = buildBatchObjectListQuery();

        expect(query).toContain("TYPE IN ('T', 'V', 'N', 'A')");
        expect(query).toContain("CASE WHEN R.ROUTINETYPE = 'F' THEN 'FUNCTION' ELSE 'PROCEDURE' END AS OBJECT_TYPE");
        expect(query).toContain('WITH ROUTINE_SIGNATURES');
    });

	it('adds UTF-8 client codepage (1208) by default for proper Unicode support', () => {
		const query = buildConnectionString({
			host: 'db2.example.local',
			port: 50000,
			database: 'TESTDB',
			user: 'db2inst1',
			password: 'secret'
		});

		expect(query).toContain('ClientCodepage=1208');
	});

    it('allows overriding the DB2 client codepage from connection options', () => {
        const query = buildConnectionString({
            host: 'db2.example.local',
            port: 50000,
            database: 'TESTDB',
            user: 'db2inst1',
            password: 'secret',
            options: {
                clientCodepage: '819'
            }
        });

        expect(query).toContain('ClientCodepage=819');
    });

	it('uses UTF-8 (1208) for both legacy and explicit client codepage settings', () => {
		const legacyDefaultQuery = buildConnectionString({
			host: 'db2.example.local',
			port: 50000,
			database: 'TESTDB',
			user: 'db2inst1',
			password: 'secret',
			options: {
				clientCodepage: '1208'
			}
		});

		const explicitUtf8Query = buildConnectionString({
			host: 'db2.example.local',
			port: 50000,
			database: 'TESTDB',
			user: 'db2inst1',
			password: 'secret',
			options: {
				clientCodepage: '1208',
				clientCodepageExplicit: true
			}
		});

		expect(legacyDefaultQuery).toContain('ClientCodepage=1208');
		expect(explicitUtf8Query).toContain('ClientCodepage=1208');
	});

	it('keeps Unicode schema names intact in the DB2 connection string with UTF-8 codepage', () => {
		const query = buildConnectionString({
			host: 'db2.example.local',
			port: 50000,
			database: 'TESTDB',
			user: 'db2inst1',
			password: 'secret',
			options: {
				currentSchema: 'ZAŻÓŁĆ'
			}
		});

		expect(query).toContain('CURRENTSCHEMA=ZAŻÓŁĆ');
		expect(query).toContain('ClientCodepage=1208');
	});

    it('escapes DB2 connection string values using ODBC brace escaping rules', () => {
        const query = buildConnectionString({
            host: 'db2.example.local',
            port: 50000,
            database: 'TESTDB',
            user: 'db2=inst1',
            password: ' pa;ss}word ',
            options: {
                currentSchema: 'QA=TEAM'
            }
        });

        expect(query).toContain('UID={db2=inst1}');
        expect(query).toContain('PWD={ pa;ss}}word }');
        expect(query).toContain('CURRENTSCHEMA={QA=TEAM}');
    });

    it('keeps DDL queries working when ibm_db result handles expose close() without closeSync()', () => {
        const close = jest.fn();
        const connection = new Db2Connection({
            host: 'db2.example.local',
            port: 50000,
            database: 'TESTDB',
            user: 'db2inst1',
            password: 'secret'
        });

        const internal = connection as unknown as {
            _database: {
                querySync: (sql: string) => void;
                queryResultSync: (sql: string) => unknown;
            };
        };

        internal._database = {
            querySync: (_sql: string): void => {
                return;
            },
            queryResultSync: (_sql: string): unknown => ({
                getColumnMetadataSync: () => [{ SQL_DESC_NAME: 'DDL', SQL_DESC_TYPE_NAME: 'VARCHAR' }],
                getColumnNamesSync: () => ['DDL'],
                fetchAllSync: () => [{ DDL: 'CREATE TABLE "DB2INST1"."EM" (ID INT);' }],
                close
            })
        };

        const result = connection.executeSql('SELECT DBMS_METADATA.GET_DDL(\'TABLE\', \'EM\', \'DB2INST1\') AS DDL');
        expect(result.rows).toEqual([{ DDL: 'CREATE TABLE "DB2INST1"."EM" (ID INT);' }]);
        expect(close).toHaveBeenCalled();
    });

    it('surfaces DB2 syntax errors when row-returning execution produces no result handle', () => {
        const connection = new Db2Connection({
            host: 'db2.example.local',
            port: 50000,
            database: 'TESTDB',
            user: 'db2inst1',
            password: 'secret'
        });

        const internal = connection as unknown as {
            _database: {
                querySync: (sql: string) => unknown;
                queryResultSync: (sql: string) => unknown;
            };
        };

        internal._database = {
            querySync: (_sql: string): unknown => {
                throw new Error('SQL0104N  An unexpected token "," was found following "1".');
            },
            queryResultSync: (_sql: string): unknown => null
        };

        expect(() => connection.executeSql('SELECT 1,,2 FROM DB2INST1.V_PRODUCTS_CATEGORIES'))
            .toThrow('SQL0104N');
    });

    it('falls back to querySync rows when ibm_db does not return a result handle', () => {
        const connection = new Db2Connection({
            host: 'db2.example.local',
            port: 50000,
            database: 'TESTDB',
            user: 'db2inst1',
            password: 'secret'
        });

        const internal = connection as unknown as {
            _database: {
                querySync: (sql: string) => unknown;
                queryResultSync: (sql: string) => unknown;
            };
        };

        internal._database = {
            querySync: (_sql: string): unknown => [{ TEST_VALUE: 1 }],
            queryResultSync: (_sql: string): unknown => null
        };

        expect(connection.executeSql('SELECT 1 AS TEST_VALUE FROM SYSIBM.SYSDUMMY1')).toEqual({
            columns: [{ name: 'TEST_VALUE', typeName: '' }],
            rows: [{ TEST_VALUE: 1 }],
            recordsAffected: -1
        });
    });

    it('treats node-ibm_db querySync error payloads as execution errors instead of result rows', () => {
        const connection = new Db2Connection({
            host: 'db2.example.local',
            port: 50000,
            database: 'TESTDB',
            user: 'db2inst1',
            password: 'secret'
        });

        const internal = connection as unknown as {
            _database: {
                querySync: (sql: string) => unknown;
                queryResultSync: (sql: string) => unknown;
            };
        };

        internal._database = {
            querySync: (_sql: string): unknown =>
                '[node-ibm_db] Error in ODBCConnection::QuerySync while executing query.\t-104\t' +
                '[IBM][CLI Driver][DB2/LINUXX8664] SQL0104N  An unexpected token "," was found following "SELECT 1,".  ' +
                'Expected tokens may include:  "<space>".  SQLSTATE=42601',
            queryResultSync: (_sql: string): unknown => null
        };

        expect(() => connection.executeSql('SELECT 1,,2 FROM DB2INST1.V_PRODUCTS_CATEGORIES'))
            .toThrow('SQL0104N');
    });

    it('enables DB2 procedures in dialect capabilities and connection form', () => {
        expect(db2Dialect.capabilities.supportsProcedures).toBe(true);
        expect(db2Dialect.connectionForm?.fields.some(field => field.key === 'clientCodepage')).toBe(true);
    });

    it('quotes DB2 identifiers only when needed', () => {
        const ddlProvider = db2AdvancedFeatures.ddl;
        expect(ddlProvider).toBeDefined();

        expect(ddlProvider!.quoteNameIfNeeded('EMPLOYEES')).toBe('EMPLOYEES');
        expect(ddlProvider!.quoteNameIfNeeded('Emp')).toBe('"Emp"');
        expect(ddlProvider!.quoteNameIfNeeded('SELECT')).toBe('"SELECT"');
    });

    it('reconstructs fallback table DDL with comments, distribution, organize, and FK rules from cached metadata', () => {
        const ddlProvider = db2AdvancedFeatures.ddl;
        expect(ddlProvider).toBeDefined();

        const keysInfo = new Map<string, DatabaseDdlKeyInfo>([
            [
                'PK_EM',
                {
                    type: 'PRIMARY KEY',
                    typeChar: 'P',
                    columns: ['EMPNO'],
                    pkDatabase: null,
                    pkSchema: null,
                    pkRelation: null,
                    pkColumns: [],
                    updateType: '',
                    deleteType: ''
                }
            ],
            [
                'FK_EM_DEPT',
                {
                    type: 'FOREIGN KEY',
                    typeChar: 'F',
                    columns: ['DEPTNO'],
                    pkDatabase: null,
                    pkSchema: 'DB2INST1',
                    pkRelation: 'DEPT',
                    pkColumns: ['DEPTNO'],
                    updateType: 'A',
                    deleteType: 'C'
                }
            ]
        ]);

        const ddl = ddlProvider!.buildTableDDLFromCache(
            'TESTDB',
            'DB2INST1',
            'EM',
            [
                {
                    name: 'EMPNO',
                    description: 'Employee number',
                    fullTypeName: 'INTEGER',
                    notNull: true,
                    defaultValue: null
                },
                {
                    name: 'ENAME',
                    description: 'Employee name',
                    fullTypeName: 'VARCHAR(128)',
                    notNull: false,
                    defaultValue: null
                },
                {
                    name: 'DEPTNO',
                    description: 'Department number',
                    fullTypeName: 'INTEGER',
                    notNull: false,
                    defaultValue: null
                }
            ],
            ['EMPNO'],
            ['DEPTNO'],
            keysInfo,
            'Employees table'
        );

        expect(ddl).toContain('CREATE TABLE DB2INST1.EM');
        expect(ddl).toContain('DISTRIBUTE BY HASH (EMPNO)');
        expect(ddl).toContain('ORGANIZE BY DIMENSIONS (DEPTNO)');
        expect(ddl).toContain('ALTER TABLE DB2INST1.EM ADD CONSTRAINT PK_EM PRIMARY KEY (EMPNO);');
        expect(ddl).toContain('ALTER TABLE DB2INST1.EM ADD CONSTRAINT FK_EM_DEPT FOREIGN KEY (DEPTNO) REFERENCES DB2INST1.DEPT (DEPTNO) ON DELETE CASCADE ON UPDATE NO ACTION;');
        expect(ddl).toContain(`COMMENT ON TABLE DB2INST1.EM IS 'Employees table';`);
        expect(ddl).toContain(`COMMENT ON COLUMN DB2INST1.EM.EMPNO IS 'Employee number';`);
        expect(ddl).toContain(`COMMENT ON COLUMN DB2INST1.EM.ENAME IS 'Employee name';`);
        expect(ddl).toContain(`COMMENT ON COLUMN DB2INST1.EM.DEPTNO IS 'Department number';`);
    });

    it('reconstructs runtime fallback table DDL with checks, indexes, and partition metadata', async () => {
        const ddlProvider = db2AdvancedFeatures.ddl;
        expect(ddlProvider).toBeDefined();

        const connection = createMockConnection([
            {
                match: /GET_DDL\('TABLE'/,
                error: new Error('GET_DDL unavailable')
            },
            {
                match: 'FROM SYSCAT.COLUMNS C',
                rows: [
                    {
                        ATTNAME: 'EMPNO',
                        FORMAT_TYPE: 'INTEGER',
                        DESCRIPTION: 'Employee number',
                        IS_NOT_NULL: 1,
                        COLDEFAULT: null
                    },
                    {
                        ATTNAME: 'DEPTNO',
                        FORMAT_TYPE: 'INTEGER',
                        DESCRIPTION: 'Department number',
                        IS_NOT_NULL: 0,
                        COLDEFAULT: null
                    },
                    {
                        ATTNAME: 'HIREDATE',
                        FORMAT_TYPE: 'DATE',
                        DESCRIPTION: 'Hire date',
                        IS_NOT_NULL: 0,
                        COLDEFAULT: null
                    },
                    {
                        ATTNAME: 'UPDATED_AT',
                        FORMAT_TYPE: 'TIMESTAMP',
                        DESCRIPTION: 'Update timestamp',
                        IS_NOT_NULL: 0,
                        COLDEFAULT: 'CURRENT TIMESTAMP'
                    }
                ]
            },
            {
                match: 'FROM SYSCAT.TABCONST TC',
                rows: [
                    {
                        CONSTNAME: 'PK_EM',
                        TYPE: 'PRIMARY KEY',
                        TYPECHAR: 'P',
                        COLNAME: 'EMPNO',
                        PKSCHEMA: '',
                        PKRELATION: '',
                        PKCOLNAME: '',
                        DELETERULE: '',
                        UPDATERULE: '',
                        ENFORCED: 'Y',
                        TRUSTED: 'Y',
                        REMARKS: 'Primary key comment'
                    }
                ]
            },
            {
                match: 'FROM SYSCAT.CHECKS C',
                rows: [
                    {
                        CONSTNAME: 'CHK_EMPNO_POSITIVE',
                        TEXT: 'EMPNO > 0',
                        ENFORCED: 'N',
                        TRUSTED: 'Y',
                        REMARKS: 'Positive employee numbers only'
                    }
                ]
            },
            {
                match: 'FROM SYSCAT.INDEXES I',
                rows: [
                    {
                        INDEX_SCHEMA: 'DB2INST1',
                        INDEX_NAME: 'IX_EM_DEPT',
                        COLNAME: 'DEPTNO',
                        COLSEQ: 1,
                        COLORDER: 'A',
                        UNIQUERULE: 'D',
                        INDEXTYPE: 'REG',
                        COMPRESSION: 'Y'
                    },
                    {
                        INDEX_SCHEMA: 'DB2INST1',
                        INDEX_NAME: 'IX_EM_DEPT',
                        COLNAME: 'UPDATED_AT',
                        COLSEQ: 2,
                        COLORDER: 'I',
                        UNIQUERULE: 'D',
                        INDEXTYPE: 'REG',
                        COMPRESSION: 'Y'
                    }
                ]
            },
            {
                match: 'PARTITION_MODE',
                rows: [
                    {
                        PARTITION_MODE: 'H',
                        PROPERTY: '',
                        COMPRESSION: 'R',
                        ROWCOMPMODE: 'A',
                        TABLEORG: 'C',
                        TBSPACE: 'TS_MAIN'
                    }
                ]
            },
            {
                match: 'SELECT COALESCE(REMARKS, \'\') AS DESCRIPTION',
                rows: [
                    {
                        DESCRIPTION: 'Employees table'
                    }
                ]
            },
            {
                match: 'COALESCE(PARTKEYSEQ, 0) > 0',
                rows: [
                    {
                        COLNAME: 'EMPNO',
                        PARTKEYSEQ: 1
                    }
                ]
            },
            {
                match: 'FROM SYSCAT.DATAPARTITIONEXPRESSION',
                rows: [
                    {
                        PARTKEYSEQ: 1,
                        PARTITION_EXPRESSION: 'YEAR("HIREDATE")',
                        NULLSFIRST: 'N'
                    }
                ]
            },
            {
                match: 'FROM SYSCAT.DATAPARTITIONS',
                rows: [
                    {
                        PARTITION_NAME: 'P2024',
                        PARTITION_SEQNO: 0,
                        LOWVALUE: "'2024-01-01'",
                        HIGHVALUE: "'2024-12-31'",
                        LOWINCLUSIVE: 'Y',
                        HIGHINCLUSIVE: 'N',
                        TBSPACE: 'TS_2024'
                    }
                ]
            },
            {
                match: 'FROM SYSCAT.TRIGGERS',
                rows: [
                    {
                        TRIGGER_SCHEMA: 'DB2INST1',
                        TRIGGER_NAME: 'TRG_EM_AUDIT',
                        DEFINITION: 'CREATE TRIGGER DB2INST1.TRG_EM_AUDIT AFTER INSERT ON DB2INST1.EM REFERENCING NEW AS N FOR EACH ROW BEGIN ATOMIC INSERT INTO DB2INST1.EM_AUDIT VALUES (N.EMPNO); END'
                    }
                ]
            }
        ]);

        const ddl = await ddlProvider!.generateTableDDL(connection, 'TESTDB', 'DB2INST1', 'EM');

        expect(ddl).toContain('CREATE TABLE DB2INST1.EM');
        expect(ddl).toContain('ORGANIZE BY COLUMN IN TS_MAIN');
        expect(ddl).toContain('DISTRIBUTE BY HASH (EMPNO)');
        expect(ddl).toContain('COMPRESS YES');
        expect(ddl).toContain('PARTITION BY RANGE(YEAR("HIREDATE") NULLS LAST)');
        expect(ddl).toContain(`PARTITION P2024 STARTING FROM '2024-01-01' INCLUSIVE ENDING AT '2024-12-31' EXCLUSIVE IN TS_2024`);
        expect(ddl).toContain('ALTER TABLE DB2INST1.EM ADD CONSTRAINT PK_EM PRIMARY KEY (EMPNO) ENFORCED TRUSTED;');
        expect(ddl).toContain(`COMMENT ON CONSTRAINT DB2INST1.EM.PK_EM IS 'Primary key comment';`);
        expect(ddl).toContain('ALTER TABLE DB2INST1.EM ADD CONSTRAINT CHK_EMPNO_POSITIVE CHECK (EMPNO > 0) NOT ENFORCED TRUSTED;');
        expect(ddl).toContain(`COMMENT ON CONSTRAINT DB2INST1.EM.CHK_EMPNO_POSITIVE IS 'Positive employee numbers only';`);
        expect(ddl).toContain('CREATE INDEX DB2INST1.IX_EM_DEPT ON DB2INST1.EM (DEPTNO) INCLUDE (UPDATED_AT) COMPRESS YES;');
        expect(ddl).toContain('CREATE TRIGGER DB2INST1.TRG_EM_AUDIT AFTER INSERT ON DB2INST1.EM');
        expect(ddl).toContain(`COMMENT ON TABLE DB2INST1.EM IS 'Employees table';`);
    });

    it('retrieves view and procedure DDL through DBMS_METADATA when available', async () => {
        const ddlProvider = db2AdvancedFeatures.ddl;
        expect(ddlProvider).toBeDefined();

        const connection = createMockConnection([
            {
                match: /GET_DDL\('VIEW'/,
                rows: [
                    {
                        DDL: 'CREATE VIEW "DB2INST1"."V_EMP" AS SELECT * FROM "DB2INST1"."EM"'
                    }
                ]
            },
            {
                match: /GET_DDL\('PROCEDURE'/,
                rows: [
                    {
                        DDL: 'CREATE PROCEDURE "DB2INST1"."P_LOAD"() LANGUAGE SQL BEGIN END'
                    }
                ]
            }
        ]);

        await expect(ddlProvider!.generateViewDDL(connection, 'TESTDB', 'DB2INST1', 'V_EMP'))
            .resolves.toContain('CREATE VIEW "DB2INST1"."V_EMP" AS SELECT * FROM "DB2INST1"."EM";');
        await expect(ddlProvider!.generateProcedureDDL(connection, 'TESTDB', 'DB2INST1', 'P_LOAD'))
            .resolves.toContain('CREATE PROCEDURE "DB2INST1"."P_LOAD"() LANGUAGE SQL BEGIN END;');
    });

    it('still builds fallback table DDL when optional metadata catalog lookups fail', async () => {
        const ddlProvider = db2AdvancedFeatures.ddl;
        expect(ddlProvider).toBeDefined();

        const connection = createMockConnection([
            {
                match: /GET_DDL\('TABLE'/,
                error: new Error('GET_DDL unavailable')
            },
            {
                match: 'FROM SYSCAT.COLUMNS C',
                rows: [
                    {
                        ATTNAME: 'EMPNO',
                        FORMAT_TYPE: 'INTEGER',
                        DESCRIPTION: 'Employee number',
                        IS_NOT_NULL: 1,
                        COLDEFAULT: null
                    }
                ]
            },
            {
                match: 'FROM SYSCAT.DATAPARTITIONEXPRESSION',
                error: new Error('[node-ibm_db] Error in ODBCConnection::QuerySync while executing query.')
            }
        ]);

        await expect(ddlProvider!.generateTableDDL(connection, 'TESTDB', 'DB2INST1', 'EM'))
            .resolves.toContain('CREATE TABLE DB2INST1.EM');
    });

    it('falls back to catalog text for view DDL when DBMS_METADATA does not return a definition', async () => {
        const ddlProvider = db2AdvancedFeatures.ddl;
        expect(ddlProvider).toBeDefined();

        const connection = createMockConnection([
            {
                match: /GET_DDL\('VIEW', 'V_PRODUCTS_CATEGORIES'/,
                rows: []
            },
            {
                match: 'FROM SYSCAT.VIEWS',
                rows: [
                    {
                        SCHEMA: 'DB2INST1',
                        VIEW_NAME: 'V_PRODUCTS_CATEGORIES',
                        VIEW_TEXT: `SELECT P.PRODUCTNAME, C.CATEGORYNAME
FROM DB2INST1.PRODUCTS P
JOIN DB2INST1.CATEGORIES C ON C.CATEGORYID = P.CATEGORYID`
                    }
                ]
            }
        ]);

        await expect(ddlProvider!.generateViewDDL(connection, 'TESTDB', 'DB2INST1', 'V_PRODUCTS_CATEGORIES'))
            .resolves.toContain(`CREATE VIEW DB2INST1.V_PRODUCTS_CATEGORIES AS SELECT P.PRODUCTNAME, C.CATEGORYNAME
FROM DB2INST1.PRODUCTS P
JOIN DB2INST1.CATEGORIES C ON C.CATEGORYID = P.CATEGORYID;`);
    });

    it('falls back to catalog text for procedure DDL when DBMS_METADATA does not return a definition', async () => {
        const ddlProvider = db2AdvancedFeatures.ddl;
        expect(ddlProvider).toBeDefined();

        const connection = createMockConnection([
            {
                match: /GET_DDL\('PROCEDURE', 'P_LOAD'/,
                rows: []
            },
            {
                match: 'FROM SYSCAT.ROUTINES R',
                rows: [
                    {
                        SCHEMA: 'DB2INST1',
                        PROCEDURE_NAME: 'P_LOAD',
                        SPECIFICNAME: 'P_LOAD_1',
                        PROCEDURE_SIGNATURE: 'P_LOAD(INTEGER)',
                        PROCEDURE_TEXT: 'CREATE PROCEDURE DB2INST1.P_LOAD(IN P_ID INTEGER) LANGUAGE SQL BEGIN END'
                    }
                ]
            }
        ]);

        await expect(ddlProvider!.generateProcedureDDL(connection, 'TESTDB', 'DB2INST1', 'P_LOAD(INTEGER)'))
            .resolves.toContain('SET SCHEMA DB2INST1;');
        await expect(ddlProvider!.generateProcedureDDL(connection, 'TESTDB', 'DB2INST1', 'P_LOAD(INTEGER)'))
            .resolves.toContain('CREATE PROCEDURE DB2INST1.P_LOAD(IN P_ID INTEGER) LANGUAGE SQL BEGIN END;');
    });
});
