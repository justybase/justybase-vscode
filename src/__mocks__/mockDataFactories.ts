
/**
 * Helper functions to generate mock data for Netezza system views
 */

export const MockDataFactory = {
    createDatabaseRow: (name: string, owner: string = 'ADMIN') => ({
        DATABASE: name,
        OWNER: owner,
        CREATEDATE: new Date().toISOString()
    }),

    createSchemaRow: (name: string, owner: string = 'ADMIN') => ({
        SCHEMA: name,
        OWNER: owner,
        CREATEDATE: new Date().toISOString()
    }),

    createObjectDataRow: (
        name: string,
        schema: string,
        database: string,
        type: 'TABLE' | 'VIEW' | 'PROCEDURE' | 'EXTERNAL TABLE',
        description: string = ''
    ) => ({
        OBJNAME: name,
        SCHEMA: schema,
        DBNAME: database,
        OBJTYPE: type,
        DESCRIPTION: description,
        OBJID: Math.floor(Math.random() * 100000)
    }),

    createColumnRow: (
        attName: string,
        objId: number,
        type: string = 'VARCHAR(100)',
        description: string = ''
    ) => ({
        ATTNAME: attName,
        OBJID: objId,
        FORMAT_TYPE: type,
        DESCRIPTION: description,
        ATTNUM: 1,
        ATTNOTNULL: false,
        COLDEFAULT: null
    }),

    createViewRow: (
        name: string,
        schema: string,
        database: string,
        definition: string
    ) => ({
        VIEWNAME: name,
        SCHEMA: schema,
        DATABASE: database,
        DEFINITION: definition,
        OWNER: 'ADMIN',
        OBJID: Math.floor(Math.random() * 100000)
    }),

    createProcedureRow: (
        name: string,
        schema: string,
        database: string,
        source: string,
        signature: string = ''
    ) => ({
        PROCEDURE: name,
        SCHEMA: schema,
        DATABASE: database,
        PROCEDURESOURCE: source,
        PROCEDURESIGNATURE: signature || `${name}()`,
        RETURNS: 'INTEGER',
        OWNER: 'ADMIN'
    })
};
