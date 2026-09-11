import type { DatabaseTableDdlMetadata } from '@justybase/contracts';
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

function runtimeWith(metadata: DatabaseTableDdlMetadata): jest.Mocked<ApiDatabaseRuntime> {
  return {
    kind: 'netezza',
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

  it('refuses incomplete catalog metadata instead of emitting executable-looking fake DDL', async () => {
    const runtime = runtimeWith({
      columns: [{ name: 'ID', description: null, fullTypeName: '', notNull: false, defaultValue: null }],
      distributionColumns: [], organizeColumns: [], keys: [], tableComment: null,
    });
    await expect(getSchemaObjectDdlResponse(profile(), {
      connectionId: 'connection-1', database: 'MYDB', schema: 'ADMIN', objectName: 'USERS', objectType: 'TABLE',
    }, registryFor(runtime))).rejects.toBeInstanceOf(SchemaDdlUnavailableError);
  });

  it('reports unsupported object types explicitly', async () => {
    const runtime = runtimeWith({ columns: [], distributionColumns: [], organizeColumns: [], keys: [], tableComment: null });
    await expect(getSchemaObjectDdlResponse(profile(), {
      connectionId: 'connection-1', database: 'MYDB', schema: 'ADMIN', objectName: 'P_USERS', objectType: 'PROCEDURE',
    }, registryFor(runtime))).rejects.toThrow('Exact DDL for PROCEDURE');
  });
});
