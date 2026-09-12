import type {
  DatabaseExternalTableDdlMetadata,
  DatabaseProcedureInfo,
  DatabaseSynonymInfo,
  DatabaseTableDdlMetadata,
} from '@justybase/contracts';
import type { ApiDatabaseRuntime, ApiDatabaseRuntimeRegistry } from '../src/databaseRuntime/contracts';
import { getSchemaObjectDdlResponse, SchemaDdlUnavailableError } from '../src/schemaDdlService';
import type { StoredConnection } from '../src/store';

function profile(dbType: StoredConnection['dbType'] = 'netezza'): StoredConnection {
  return {
    id: 'connection-1',
    name: 'Netezza',
    host: 'localhost',
    port: 5480,
    database: 'SYSTEM',
    user: 'ADMIN',
    dbType,
    passwordCiphertext: '',
    passwordIv: '',
    passwordAuthTag: '',
    readOnly: true,
  };
}

function runtimeWith(
  metadata: DatabaseTableDdlMetadata,
  kind: ApiDatabaseRuntime['kind'] = 'netezza',
): jest.Mocked<ApiDatabaseRuntime> {
  return {
    kind,
    isAvailable: jest.fn().mockReturnValue(true),
    isReadOnlySql: jest.fn().mockReturnValue(true),
    normalizeDatabase: jest.fn((database: string) => database),
    execute: jest.fn(),
    listDatabases: jest.fn(),
    listSchemas: jest.fn(),
    listObjects: jest.fn(),
    listColumns: jest.fn(),
    getTableDdlMetadata: jest.fn().mockResolvedValue(metadata),
    getViewDefinition: jest.fn().mockResolvedValue('SELECT ID FROM USERS;'),
    closeConnection: jest.fn(),
    closeAll: jest.fn(),
  };
}

function registryFor(runtime: ApiDatabaseRuntime): ApiDatabaseRuntimeRegistry {
  return { forProfile: jest.fn().mockReturnValue(runtime) } as unknown as ApiDatabaseRuntimeRegistry;
}

describe('schema DDL service', () => {
  it('returns exact shared Netezza table DDL without reconstructing types', async () => {
    const runtime = runtimeWith({
      columns: [
        { name: 'ID', description: null, fullTypeName: 'NUMERIC(18,0)', notNull: true, defaultValue: null },
        { name: 'CREATED_AT', description: 'Creation time', fullTypeName: 'TIMESTAMP(6)', notNull: false, defaultValue: 'CURRENT_TIMESTAMP' },
      ],
      distributionColumns: ['ID'],
      organizeColumns: ['CREATED_AT'],
      keys: [{ name: 'PK_USERS', info: {
        type: 'PRIMARY KEY', typeChar: 'p', columns: ['ID'], pkDatabase: null, pkSchema: null,
        pkRelation: null, pkColumns: [], updateType: 'NO ACTION', deleteType: 'NO ACTION',
      } }],
      tableComment: 'Users',
    });

    const result = await getSchemaObjectDdlResponse(profile(), {
      connectionId: 'connection-1',
      database: 'MYDB',
      schema: 'ADMIN',
      objectName: 'USERS',
      objectType: 'TABLE',
    }, registryFor(runtime));

    expect(result).toEqual(expect.objectContaining({ success: true, ddlFidelity: 'exact' }));
    expect(result.ddlCode).toContain('ID NUMERIC(18,0) NOT NULL');
    expect(result.ddlCode).toContain('CREATED_AT TIMESTAMP(6) DEFAULT CURRENT_TIMESTAMP');
    expect(result.ddlCode).toContain('DISTRIBUTE ON (ID)');
    expect(result.ddlCode).toContain('ORGANIZE ON (CREATED_AT)');
    expect(result.ddlCode).toContain('ADD CONSTRAINT PK_USERS PRIMARY KEY (ID)');
    expect(result.ddlCode).toContain("COMMENT ON TABLE MYDB.ADMIN.USERS IS 'Users'");
    expect(result.ddlCode).not.toContain('VARCHAR(1)');
    expect(runtime.getTableDdlMetadata).toHaveBeenCalledWith(profile(), 'MYDB', 'ADMIN', 'USERS');
  });

  it('returns exact view source through the shared view formatter', async () => {
    const runtime = runtimeWith({ columns: [], distributionColumns: [], organizeColumns: [], keys: [], tableComment: null });
    const result = await getSchemaObjectDdlResponse(profile(), {
      connectionId: 'connection-1', database: 'MYDB', schema: 'ADMIN', objectName: 'V_USERS', objectType: 'VIEW',
    }, registryFor(runtime));

    expect(result.ddlCode).toBe('CREATE OR REPLACE VIEW MYDB.ADMIN.V_USERS AS\nSELECT ID FROM USERS;');
    expect(runtime.getViewDefinition).toHaveBeenCalledWith(profile(), 'MYDB', 'ADMIN', 'V_USERS');
  });

  it('returns exact procedure DDL through the shared formatter', async () => {
    const runtime = runtimeWith({ columns: [], distributionColumns: [], organizeColumns: [], keys: [], tableComment: null });
    const metadata: DatabaseProcedureInfo = {
      schema: 'ADMIN',
      procedureSource: 'BEGIN\n  RETURN 1;\nEND;',
      objId: 42,
      returns: 'INTEGER',
      executeAsOwner: false,
      description: 'User procedure',
      procedureSignature: 'P_USERS()',
      procedureName: 'P_USERS',
      arguments: null,
    };
    runtime.getProcedureDdlMetadata = jest.fn().mockResolvedValue(metadata);

    const result = await getSchemaObjectDdlResponse(profile(), {
      connectionId: 'connection-1', database: 'MYDB', schema: 'ADMIN', objectName: 'P_USERS()', objectType: 'PROCEDURE',
    }, registryFor(runtime));

    expect(result).toEqual(expect.objectContaining({ success: true, ddlFidelity: 'exact' }));
    expect(result.ddlCode).toContain('CREATE OR REPLACE PROCEDURE MYDB.ADMIN.P_USERS()');
    expect(result.ddlCode).toContain('LANGUAGE NZPLSQL AS');
    expect(result.ddlCode).toContain("COMMENT ON PROCEDURE P_USERS IS 'User procedure';");
    expect(runtime.getProcedureDdlMetadata).toHaveBeenCalledWith(profile(), 'MYDB', 'ADMIN', 'P_USERS()');
  });

  it('returns exact external-table DDL with catalog options and columns', async () => {
    const runtime = runtimeWith({ columns: [], distributionColumns: [], organizeColumns: [], keys: [], tableComment: null });
    const metadata: DatabaseExternalTableDdlMetadata = {
      info: {
        schema: 'ADMIN', tableName: 'EXT_USERS', dataObject: '/tmp/users.csv', delimiter: '|', encoding: 'INTERNAL',
        timeStyle: null, remoteSource: 'LOCAL', skipRows: 1, maxErrors: 2, escapeChar: null, logDir: null,
        decimalDelim: null, quotedValue: null, nullValue: null, crInString: null, truncString: null, ctrlChars: null,
        ignoreZero: null, timeExtraZeros: null, y2Base: null, fillRecord: null, compress: null, includeHeader: null,
        lfInString: null, dateStyle: null, dateDelim: null, timeDelim: null, boolStyle: null, format: 'TEXT',
        socketBufSize: null, recordDelim: null, maxRows: null, requireQuotes: null, recordLength: null,
        dateTimeDelim: null, rejectFile: null,
      },
      columns: [{ name: 'ID', description: null, fullTypeName: 'INTEGER', notNull: true, defaultValue: null }],
      metadataComplete: true,
    };
    runtime.getExternalTableDdlMetadata = jest.fn().mockResolvedValue(metadata);

    const result = await getSchemaObjectDdlResponse(profile(), {
      connectionId: 'connection-1', database: 'MYDB', schema: 'ADMIN', objectName: 'EXT_USERS', objectType: 'EXTERNAL TABLE',
    }, registryFor(runtime));

    expect(result.ddlCode).toContain('CREATE EXTERNAL TABLE MYDB.ADMIN.EXT_USERS');
    expect(result.ddlCode).toContain('SKIPROWS 1');
    expect(result.ddlCode).toContain('ID INTEGER NOT NULL');
    expect(result.ddlFidelity).toBe('exact');
    expect(runtime.getExternalTableDdlMetadata).toHaveBeenCalledWith(profile(), 'MYDB', 'ADMIN', 'EXT_USERS');
  });

  it('returns exact synonym DDL with the runtime-resolved target', async () => {
    const runtime = runtimeWith({ columns: [], distributionColumns: [], organizeColumns: [], keys: [], tableComment: null });
    const metadata: DatabaseSynonymInfo = {
      schema: 'ADMIN', synonymName: 'S_USERS', referenceObjectName: 'MYDB.ADMIN.USERS', owner: 'ADMIN', description: null,
    };
    runtime.getSynonymDdlMetadata = jest.fn().mockResolvedValue(metadata);

    const result = await getSchemaObjectDdlResponse(profile(), {
      connectionId: 'connection-1', database: 'MYDB', schema: 'ADMIN', objectName: 'S_USERS', objectType: 'SYNONYM',
    }, registryFor(runtime));

    expect(result.ddlCode).toBe('CREATE SYNONYM MYDB.ADMIN.S_USERS FOR MYDB.ADMIN.USERS;');
    expect(result.ddlFidelity).toBe('exact');
    expect(runtime.getSynonymDdlMetadata).toHaveBeenCalledWith(profile(), 'MYDB', 'ADMIN', 'S_USERS');
  });

  it('refuses an external table when typed columns are incomplete', async () => {
    const runtime = runtimeWith({ columns: [], distributionColumns: [], organizeColumns: [], keys: [], tableComment: null });
    runtime.getExternalTableDdlMetadata = jest.fn().mockResolvedValue({
      info: {} as DatabaseExternalTableDdlMetadata['info'],
      columns: [{ name: 'ID', description: null, fullTypeName: '', notNull: false, defaultValue: null }],
      metadataComplete: true,
    });

    await expect(getSchemaObjectDdlResponse(profile(), {
      connectionId: 'connection-1', database: 'MYDB', schema: 'ADMIN', objectName: 'EXT_USERS', objectType: 'EXTERNAL TABLE',
    }, registryFor(runtime))).rejects.toBeInstanceOf(SchemaDdlUnavailableError);
  });

  it('refuses incomplete catalog metadata instead of emitting executable-looking fake DDL', async () => {
    const runtime = runtimeWith({
      columns: [{ name: 'ID', description: null, fullTypeName: '', notNull: false, defaultValue: null }],
      distributionColumns: [], organizeColumns: [], keys: [], tableComment: null,
    });
    await expect(getSchemaObjectDdlResponse(profile(), {
      connectionId: 'connection-1', database: 'MYDB', schema: 'ADMIN', objectName: 'USERS', objectType: 'TABLE',
    }, registryFor(runtime))).rejects.toBeInstanceOf(SchemaDdlUnavailableError);
  });

  it('refuses DDL when an ancillary catalog query failed', async () => {
    const runtime = runtimeWith({
      columns: [{ name: 'ID', description: null, fullTypeName: 'INTEGER', notNull: false, defaultValue: null }],
      distributionColumns: [], organizeColumns: [], keys: [], tableComment: null, metadataComplete: false,
    });
    await expect(getSchemaObjectDdlResponse(profile(), {
      connectionId: 'connection-1', database: 'MYDB', schema: 'ADMIN', objectName: 'USERS', objectType: 'TABLE',
    }, registryFor(runtime))).rejects.toBeInstanceOf(SchemaDdlUnavailableError);
  });

  it('reconstructs SQLite table DDL from the shared metadata contract', async () => {
    const runtime = runtimeWith({ columns: [], distributionColumns: [], organizeColumns: [], keys: [], tableComment: null }, 'sqlite');
    runtime.listColumns.mockResolvedValue([
      { name: 'id', type: 'INTEGER', isPk: true },
      { name: 'label', type: 'TEXT', isPk: false },
    ]);

    const result = await getSchemaObjectDdlResponse(profile('sqlite'), {
      connectionId: 'connection-1', database: 'main', schema: 'main', objectName: 'users', objectType: 'TABLE',
    }, registryFor(runtime));

    expect(result).toEqual(expect.objectContaining({ success: true, ddlFidelity: 'reconstructed' }));
    expect(result.ddlCode).toContain('CREATE TABLE main.users');
    expect(result.ddlCode).toContain('PRIMARY KEY (id)');
    expect(result.warnings).toEqual(expect.arrayContaining([expect.stringContaining('generic metadata')]));
    expect(runtime.listColumns).toHaveBeenCalledWith(profile('sqlite'), 'main', 'main', 'users');
    expect(runtime.getTableDdlMetadata).not.toHaveBeenCalled();
  });

  it('reconstructs a DuckDB view from catalog source SQL', async () => {
    const runtime = runtimeWith({ columns: [], distributionColumns: [], organizeColumns: [], keys: [], tableComment: null }, 'duckdb');
    runtime.listObjects.mockResolvedValue([{
      name: 'v_users', database: 'analytics', schema: 'main', objectType: 'VIEW',
      viewSql: 'CREATE VIEW v_users AS SELECT id FROM users;',
    }]);

    const result = await getSchemaObjectDdlResponse(profile('duckdb'), {
      connectionId: 'connection-1', database: 'analytics', schema: 'main', objectName: 'V_USERS', objectType: 'VIEW',
    }, registryFor(runtime));

    expect(result.ddlCode).toBe('CREATE VIEW v_users AS SELECT id FROM users;');
    expect(result.ddlFidelity).toBe('reconstructed');
    expect(runtime.listObjects).toHaveBeenCalledWith(profile('duckdb'), 'analytics', 'main');
  });

  it('does not use a Netezza DDL builder for an unavailable runtime kind', async () => {
    const runtime = runtimeWith({ columns: [], distributionColumns: [], organizeColumns: [], keys: [], tableComment: null });
    await expect(getSchemaObjectDdlResponse(profile('sqlite'), {
      connectionId: 'connection-1', database: 'main', schema: 'main', objectName: 'users', objectType: 'TABLE',
    }, registryFor(runtime))).rejects.toBeInstanceOf(SchemaDdlUnavailableError);
    expect(runtime.getTableDdlMetadata).not.toHaveBeenCalled();
  });

  it('refuses an incomplete generic table instead of emitting fake DDL', async () => {
    const runtime = runtimeWith({ columns: [], distributionColumns: [], organizeColumns: [], keys: [], tableComment: null }, 'duckdb');
    runtime.listColumns.mockResolvedValue([{ name: 'id', type: '' }]);
    await expect(getSchemaObjectDdlResponse(profile('duckdb'), {
      connectionId: 'connection-1', database: 'main', schema: 'main', objectName: 'users', objectType: 'TABLE',
    }, registryFor(runtime))).rejects.toThrow('no declared type');
  });

  it('reports unsupported object types explicitly', async () => {
    const runtime = runtimeWith({ columns: [], distributionColumns: [], organizeColumns: [], keys: [], tableComment: null });
    await expect(getSchemaObjectDdlResponse(profile(), {
      connectionId: 'connection-1', database: 'MYDB', schema: 'ADMIN', objectName: 'P_USERS', objectType: 'PROCEDURE',
    }, registryFor(runtime))).rejects.toThrow('Exact DDL for PROCEDURE');
  });
});
