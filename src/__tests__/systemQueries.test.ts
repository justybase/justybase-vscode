/**
 * Unit tests for metadata/systemQueries.ts
 * Tests for NZ_QUERIES and NZ_SYSTEM_VIEWS constants
 */

import { NZ_QUERIES, NZ_SYSTEM_VIEWS, NZ_OBJECT_TYPES, NZ_CONSTRAINT_TYPES, qualifySystemView } from '../metadata/systemQueries';

describe('metadata/systemQueries', () => {
    describe('NZ_SYSTEM_VIEWS constants', () => {
        it('should define all required system views', () => {
            expect(NZ_SYSTEM_VIEWS.DATABASE).toBe('_V_DATABASE');
            expect(NZ_SYSTEM_VIEWS.SCHEMA).toBe('_V_SCHEMA');
            expect(NZ_SYSTEM_VIEWS.TABLE).toBe('_V_TABLE');
            expect(NZ_SYSTEM_VIEWS.VIEW).toBe('_V_VIEW');
            expect(NZ_SYSTEM_VIEWS.PROCEDURE).toBe('_V_PROCEDURE');
            expect(NZ_SYSTEM_VIEWS.OBJECT_DATA).toBe('_V_OBJECT_DATA');
            expect(NZ_SYSTEM_VIEWS.RELATION_COLUMN).toBe('_V_RELATION_COLUMN');
            expect(NZ_SYSTEM_VIEWS.EXTERNAL).toBe('_V_EXTERNAL');
            expect(NZ_SYSTEM_VIEWS.EXTOBJECT).toBe('_V_EXTOBJECT');
        });

        it('should define key constraint and distribution views', () => {
            expect(NZ_SYSTEM_VIEWS.RELATION_KEYDATA).toBe('_V_RELATION_KEYDATA');
            expect(NZ_SYSTEM_VIEWS.TABLE_DIST_MAP).toBe('_V_TABLE_DIST_MAP');
            expect(NZ_SYSTEM_VIEWS.TABLE_ORGANIZE_COLUMN).toBe('_V_TABLE_ORGANIZE_COLUMN');
        });
    });

    describe('NZ_OBJECT_TYPES constants', () => {
        it('should define common object types', () => {
            expect(NZ_OBJECT_TYPES.TABLE).toBe('TABLE');
            expect(NZ_OBJECT_TYPES.VIEW).toBe('VIEW');
            expect(NZ_OBJECT_TYPES.PROCEDURE).toBe('PROCEDURE');
            expect(NZ_OBJECT_TYPES.EXTERNAL_TABLE).toBe('EXTERNAL TABLE');
            expect(NZ_OBJECT_TYPES.SEQUENCE).toBe('SEQUENCE');
        });
    });

    describe('NZ_CONSTRAINT_TYPES constants', () => {
        it('should define constraint type codes', () => {
            expect(NZ_CONSTRAINT_TYPES.PRIMARY_KEY).toBe('p');
            expect(NZ_CONSTRAINT_TYPES.FOREIGN_KEY).toBe('f');
            expect(NZ_CONSTRAINT_TYPES.UNIQUE).toBe('u');
        });
    });

    describe('qualifySystemView helper', () => {
        it('should qualify view with database name using two-dot syntax', () => {
            const result = qualifySystemView('MYDB', NZ_SYSTEM_VIEWS.TABLE);
            expect(result).toBe('MYDB.._V_TABLE');
        });

        it('should uppercase database name', () => {
            const result = qualifySystemView('mydb', NZ_SYSTEM_VIEWS.VIEW);
            expect(result).toBe('MYDB.._V_VIEW');
        });

        it('should work with all system views', () => {
            expect(qualifySystemView('DB1', NZ_SYSTEM_VIEWS.OBJECT_DATA)).toBe('DB1.._V_OBJECT_DATA');
            expect(qualifySystemView('DB2', NZ_SYSTEM_VIEWS.RELATION_COLUMN)).toBe('DB2.._V_RELATION_COLUMN');
            expect(qualifySystemView('DB3', NZ_SYSTEM_VIEWS.PROCEDURE)).toBe('DB3.._V_PROCEDURE');
        });
    });

    describe('NZ_QUERIES.LIST_DATABASES', () => {
        it('should be a valid SQL query', () => {
            expect(NZ_QUERIES.LIST_DATABASES).toContain('SELECT');
            expect(NZ_QUERIES.LIST_DATABASES).toContain('DATABASE');
            expect(NZ_QUERIES.LIST_DATABASES).toContain(NZ_SYSTEM_VIEWS.DATABASE);
        });
    });

    describe('NZ_QUERIES.listSchemas', () => {
        it('should generate query with database prefix', () => {
            const query = NZ_QUERIES.listSchemas('TESTDB');
            expect(query).toContain('TESTDB.._V_SCHEMA');
            expect(query).toContain('SELECT');
            expect(query).toContain('SCHEMA');
        });

        it('should uppercase database name', () => {
            const query = NZ_QUERIES.listSchemas('testdb');
            expect(query).toContain('TESTDB.._V_SCHEMA');
        });
    });

    describe('NZ_QUERIES.getTableColumns', () => {
        it('should generate query with proper filters', () => {
            const query = NZ_QUERIES.getTableColumns('MYDB', 'ADMIN', 'CUSTOMERS');
            expect(query).toContain('MYDB.._V_RELATION_COLUMN');
            expect(query).toContain("UPPER(D.SCHEMA) = 'ADMIN'");
            expect(query).toContain("UPPER(D.OBJNAME) = 'CUSTOMERS'");
        });

        it('should preserve exact case for lowercase identifiers', () => {
            const query = NZ_QUERIES.getTableColumns('mydb', 'admin', 'customers');
            expect(query).toContain('MYDB.._V_RELATION_COLUMN');
            expect(query).toContain("D.SCHEMA = 'admin'");
            expect(query).toContain("D.OBJNAME = 'customers'");
        });

        it('should keep exact case for quoted identifiers', () => {
            const query = NZ_QUERIES.getTableColumns('MYDB', '"lower_schema"', '"lower_case_name"');
            expect(query).toContain("D.SCHEMA = 'lower_schema'");
            expect(query).toContain("D.OBJNAME = 'lower_case_name'");
        });
    });

    describe('NZ_QUERIES.getDistributionKeys', () => {
        it('should generate query for distribution columns', () => {
            const query = NZ_QUERIES.getDistributionKeys('MYDB', 'ADMIN', 'ORDERS');
            expect(query).toContain('MYDB.._V_TABLE_DIST_MAP');
            expect(query).toContain("UPPER(SCHEMA) = 'ADMIN'");
            expect(query).toContain("UPPER(TABLENAME) = 'ORDERS'");
            expect(query).toContain('DISTSEQNO');
        });
    });

    describe('NZ_QUERIES.getOrganizeColumns', () => {
        it('should generate query for organize columns', () => {
            const query = NZ_QUERIES.getOrganizeColumns('MYDB', 'ADMIN', 'ORDERS');
            expect(query).toContain('MYDB.._V_TABLE_ORGANIZE_COLUMN');
            expect(query).toContain("UPPER(SCHEMA) = 'ADMIN'");
            expect(query).toContain("UPPER(TABLENAME) = 'ORDERS'");
            expect(query).toContain('ORGSEQNO');
        });
    });

    describe('NZ_QUERIES.getTableKeys', () => {
        it('should generate query for key constraints', () => {
            const query = NZ_QUERIES.getTableKeys('MYDB', 'ADMIN', 'ORDERS');
            expect(query).toContain('MYDB.._V_RELATION_KEYDATA');
            expect(query).toContain("UPPER(X.SCHEMA) = 'ADMIN'");
            expect(query).toContain("UPPER(X.RELATION) = 'ORDERS'");
            expect(query).toContain('CONSTRAINTNAME');
            expect(query).toContain('CONTYPE');
        });
    });

    describe('NZ_QUERIES.getObjectComment', () => {
        it('should generate query with DBNAME filter', () => {
            const query = NZ_QUERIES.getObjectComment('MYDB', 'ADMIN', 'ORDERS');
            expect(query).toContain('MYDB.._V_OBJECT_DATA');
            expect(query).toContain("DBNAME = 'MYDB'");
            expect(query).toContain("UPPER(SCHEMA) = 'ADMIN'");
            expect(query).toContain("UPPER(OBJNAME) = 'ORDERS'");
            expect(query).toContain('DESCRIPTION');
        });

        it('should include object type filter when provided', () => {
            const query = NZ_QUERIES.getObjectComment('MYDB', 'ADMIN', 'ORDERS', 'TABLE');
            expect(query).toContain("OBJTYPE = 'TABLE'");
        });
    });

    describe('NZ_QUERIES.getTableOwner', () => {
        it('should generate owner query with case-aware filters', () => {
            const query = NZ_QUERIES.getTableOwner('MYDB', 'ADMIN', 'ORDERS');
            expect(query).toContain('MYDB.._V_TABLE');
            expect(query).toContain("UPPER(SCHEMA) = 'ADMIN'");
            expect(query).toContain("UPPER(TABLENAME) = 'ORDERS'");
        });

        it('should keep exact case for quoted schema/table in owner query', () => {
            const query = NZ_QUERIES.getTableOwner('MYDB', '"lower_schema"', '"lower_table"');
            expect(query).toContain("SCHEMA = 'lower_schema'");
            expect(query).toContain("TABLENAME = 'lower_table'");
        });
    });

    describe('NZ_QUERIES.getViewDefinition', () => {
        it('should generate query for view definition', () => {
            const query = NZ_QUERIES.getViewDefinition('MYDB', 'MY_VIEW');
            expect(query).toContain('MYDB.._V_VIEW');
            expect(query).toContain("UPPER(VIEWNAME) = 'MY_VIEW'");
            expect(query).toContain('DEFINITION');
        });

        it('should include schema filter when provided', () => {
            const query = NZ_QUERIES.getViewDefinition('MYDB', 'MY_VIEW', 'ADMIN');
            expect(query).toContain("UPPER(SCHEMA) = 'ADMIN'");
        });
    });

    describe('NZ_QUERIES.getProcedureDefinition', () => {
        it('should generate query for procedure definition', () => {
            const query = NZ_QUERIES.getProcedureDefinition('MYDB', 'MY_PROC');
            expect(query).toContain('MYDB.._V_PROCEDURE');
            expect(query).toContain("UPPER(PROCEDURE) = 'MY_PROC'");
            expect(query).toContain('PROCEDURESOURCE');
        });
    });

    describe('NZ_QUERIES.findTableSchema', () => {
        it('should generate query to find schema for a table', () => {
            const query = NZ_QUERIES.findTableSchema('MYDB', 'ORDERS');
            expect(query).toContain('MYDB.._V_OBJECT_DATA');
            expect(query).toContain("DBNAME = 'MYDB'");
            expect(query).toContain("UPPER(OBJNAME) = 'ORDERS'");
            expect(query).toContain('LIMIT 1');
        });
    });

    describe('NZ_QUERIES.searchTables', () => {
        it('should generate search query with pattern', () => {
            const query = NZ_QUERIES.searchTables('%ORDER%', 'MYDB');
            expect(query).toContain('MYDB.._V_TABLE');
            expect(query).toContain("TABLENAME) LIKE '%ORDER%'");
            expect(query).toContain('LIMIT 1000');
        });

        it('should generate global search query when no database specified', () => {
            const query = NZ_QUERIES.searchTables('%ORDER%');
            expect(query).toContain('_V_OBJECT_DATA');
            expect(query).toContain("OBJNAME) LIKE '%ORDER%'");
            expect(query).toContain('DBNAME AS DATABASE');
        });
    });

    describe('NZ_QUERIES.searchColumns', () => {
        it('should generate column search query', () => {
            const query = NZ_QUERIES.searchColumns('MYDB', '%ID%');
            expect(query).toContain('MYDB.._V_TABLE');
            expect(query).toContain('MYDB.._V_RELATION_COLUMN');
            expect(query).toContain("ATTNAME) LIKE '%ID%'");
            expect(query).toContain('LIMIT 1000');
        });
    });

    describe('NZ_QUERIES.listColumnsWithKeys', () => {
        it('should generate query with PK/FK info', () => {
            const query = NZ_QUERIES.listColumnsWithKeys('MYDB');
            expect(query).toContain('IS_DISTRIBUTION_KEY');
            expect(query).toContain('_V_TABLE_DIST_MAP');
            expect(query).toContain('MYDB.._V_RELATION_COLUMN');
            expect(query).toContain('MYDB.._V_OBJECT_DATA');
            expect(query).toContain('MYDB.._V_RELATION_KEYDATA');
            expect(query).toContain('IS_PK');
            expect(query).toContain('IS_FK');
        });

        it('should use OBJID-based joins for KEYDATA and DIST_MAP', () => {
            const query = NZ_QUERIES.listColumnsWithKeys('MYDB');
            expect(query).toContain('K.OBJID = O.OBJID');
            expect(query).toContain('D.OBJID = O.OBJID');
            expect(query).not.toContain('UPPER(K.RELATION)');
            expect(query).not.toContain('UPPER(D.TABLENAME)');
        });

        it('should filter by schema when provided', () => {
            const query = NZ_QUERIES.listColumnsWithKeys('MYDB', { schema: 'ADMIN' });
            expect(query).toContain("UPPER(O.SCHEMA) = 'ADMIN'");
        });

        it('should filter by table name when provided', () => {
            const query = NZ_QUERIES.listColumnsWithKeys('MYDB', { tableName: 'ORDERS' });
            expect(query).toContain("UPPER(O.OBJNAME) = 'ORDERS'");
        });

        it('should keep exact case for quoted schema/table filters', () => {
            const query = NZ_QUERIES.listColumnsWithKeys('MYDB', {
                schema: '"lower_schema"',
                tableName: '"lower_table"'
            });
            expect(query).toContain("O.SCHEMA = 'lower_schema'");
            expect(query).toContain("O.OBJNAME = 'lower_table'");
        });
    });

    describe('NZ_QUERIES.listTablesAndViews', () => {
        it('should include synonyms and synonym references in the prefetch query', () => {
            const query = NZ_QUERIES.listTablesAndViews(['MYDB']);
            expect(query).toContain("O.OBJTYPE IN ('TABLE', 'VIEW', 'EXTERNAL TABLE', 'SYNONYM'");
            expect(query).toContain("'SEQUENCE'");
            expect(query).toContain("'MATERIALIZED VIEW'");
            expect(query).toContain("'SYSTEM VIEW'");
            expect(query).toContain('MYDB.._V_SYNONYM');
            expect(query).toContain('REFOBJNAME');
        });

        it('should use OBJID-based join for SYNONYM', () => {
            const query = NZ_QUERIES.listTablesAndViews(['MYDB']);
            expect(query).toContain('S.OBJID = O.OBJID');
            expect(query).not.toContain('UPPER(S.DATABASE)');
            expect(query).not.toContain('UPPER(S.SYNONYM_NAME)');
        });
    });

    describe('NZ_QUERIES.listObjectsOfType', () => {
        it('should generate query for tables', () => {
            const query = NZ_QUERIES.listObjectsOfType('MYDB', 'TABLE');
            expect(query).toContain('MYDB.._V_OBJECT_DATA');
            expect(query).toContain("DBNAME = 'MYDB'");
            expect(query).toContain("OBJTYPE = 'TABLE'");
        });

        it('should handle procedures specially', () => {
            const query = NZ_QUERIES.listObjectsOfType('MYDB', 'PROCEDURE');
            expect(query).toContain('MYDB.._V_PROCEDURE');
            expect(query).toContain('PROCEDURESIGNATURE AS OBJNAME');
        });

        it('should filter by schema when provided', () => {
            const query = NZ_QUERIES.listObjectsOfType('MYDB', 'VIEW', 'ADMIN');
            expect(query).toContain("UPPER(SCHEMA) = 'ADMIN'");
        });

        it('should keep exact case for quoted schema in listObjectsOfType', () => {
            const query = NZ_QUERIES.listObjectsOfType('MYDB', 'VIEW', '"lower_schema"');
            expect(query).toContain("SCHEMA = 'lower_schema'");
        });
    });

    describe('NZ_QUERIES.getExternalTables', () => {
        it('should join external tables with data objects', () => {
            const query = NZ_QUERIES.getExternalTables('MYDB');
            expect(query).toContain('MYDB.._V_EXTERNAL');
            expect(query).toContain('MYDB.._V_EXTOBJECT');
            expect(query).toContain('EXTOBJNAME AS DATAOBJECT');
        });

        it('should use RELID-based join for EXTOBJECT', () => {
            const query = NZ_QUERIES.getExternalTables('MYDB');
            expect(query).toContain('E1.RELID = E2.OBJID');
            expect(query).not.toContain('E1.DATABASE = E2.DATABASE');
        });

        it('should filter by schema when provided', () => {
            const query = NZ_QUERIES.getExternalTables('MYDB', 'ADMIN');
            expect(query).toContain("UPPER(E1.SCHEMA) = 'ADMIN'");
        });
    });

    describe('NZ_QUERIES.listProcedures/listViews', () => {
        it('should use case-aware schema filter for listProcedures', () => {
            const query = NZ_QUERIES.listProcedures('MYDB', 'ADMIN');
            expect(query).toContain("UPPER(SCHEMA) = 'ADMIN'");
        });

        it('should keep exact case for quoted schema in listProcedures', () => {
            const query = NZ_QUERIES.listProcedures('MYDB', '"lower_schema"');
            expect(query).toContain("SCHEMA = 'lower_schema'");
        });

        it('should use case-aware schema filter for listViews', () => {
            const query = NZ_QUERIES.listViews('MYDB', 'ADMIN');
            expect(query).toContain("UPPER(SCHEMA) = 'ADMIN'");
        });

        it('should keep exact case for quoted schema in listViews', () => {
            const query = NZ_QUERIES.listViews('MYDB', '"lower_schema"');
            expect(query).toContain("SCHEMA = 'lower_schema'");
        });
    });

    describe('NZ_QUERIES.getForeignKeyRelationships', () => {
        it('should generate FK query for ERD', () => {
            const query = NZ_QUERIES.getForeignKeyRelationships('MYDB', 'ADMIN');
            expect(query).toContain('MYDB.._V_RELATION_KEYDATA');
            expect(query).toContain("CONTYPE = 'f'");
            expect(query).toContain("UPPER(X.SCHEMA) = 'ADMIN'");
            expect(query).toContain('PKRELATION');
            expect(query).toContain('PKATTNAME');
        });
    });

    describe('NZ_QUERIES.findDependentViews', () => {
        it('should search in view definitions', () => {
            const query = NZ_QUERIES.findDependentViews('MYDB', 'CUSTOMERS');
            expect(query).toContain('MYDB.._V_VIEW');
            expect(query).toContain("DEFINITION) LIKE '%CUSTOMERS%'");
            expect(query).toContain("VIEWNAME != 'CUSTOMERS'");
        });
    });

    describe('NZ_QUERIES.findDependentProcedures', () => {
        it('should search in procedure sources', () => {
            const query = NZ_QUERIES.findDependentProcedures('MYDB', 'CUSTOMERS');
            expect(query).toContain('MYDB.._V_PROCEDURE');
            expect(query).toContain("PROCEDURESOURCE) LIKE '%CUSTOMERS%'");
        });
    });
});
