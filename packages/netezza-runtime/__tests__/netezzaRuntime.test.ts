import type { DatabaseQueryCallbacks } from '@justybase/contracts';
import { isReadOnlySql, NetezzaRuntime, type NetezzaDriverConnection } from '../src';

interface TestReaderData {
  columns: string[];
  rows: unknown[][];
}

function connectionForMetadata(resolve: (sql: string) => TestReaderData): NetezzaDriverConnection {
  const connection = {
    close: jest.fn(async () => undefined),
    createCommand: jest.fn((sql: string) => ({
      _recordsAffected: 0,
      commandTimeout: 0,
      cancel: jest.fn(async () => undefined),
      executeNonQuery: jest.fn(async () => 0),
      executeReader: jest.fn(async () => {
        const data = resolve(sql);
        let rowIndex = -1;
        return {
          fieldCount: data.columns.length,
          getName: (index: number) => data.columns[index] ?? `COLUMN_${index}`,
          getTypeName: () => 'VARCHAR',
          getValue: (index: number) => data.rows[rowIndex]?.[index],
          read: async () => { rowIndex += 1; return rowIndex < data.rows.length; },
          close: async () => undefined,
        };
      }),
    })),
  };
  return connection as unknown as NetezzaDriverConnection;
}

describe('Netezza runtime boundary', () => {
  const target = { connectionId: 'nz', details: { host: 'host', port: 5480, database: 'db', user: 'user', password: 'secret' } };
  const options = { maxRows: 10, timeoutSeconds: 1 };
  const callbacks: DatabaseQueryCallbacks = { onColumns: () => undefined, onRows: () => undefined, onCommand: () => undefined };

  it('cancels before connecting and cleans up a throwing callback', async () => {
    const factory = jest.fn<Promise<NetezzaDriverConnection>, []>();
    const runtime = new NetezzaRuntime({ connectionFactory: factory });
    await expect(runtime.execute(target, 'SELECT 1', options, {
      ...callbacks, onCommand: command => { void command.cancel(); },
    })).rejects.toThrow('cancelled');
    await expect(runtime.execute(target, 'SELECT 1', options, {
      ...callbacks, onCommand: () => { throw new Error('callback failed'); },
    })).rejects.toThrow('callback failed');
    await runtime.closeAll();
    expect(factory).not.toHaveBeenCalled();
  });

  it('drains connecting operations and honors the per-query database', async () => {
    let resolveConnection!: (connection: NetezzaDriverConnection) => void;
    const pendingConnection = new Promise<NetezzaDriverConnection>(resolve => { resolveConnection = resolve; });
    const factory = jest.fn(async () => pendingConnection);
    const runtime = new NetezzaRuntime({ connectionFactory: factory });
    const execution = runtime.execute(target, 'SELECT 1', { ...options, database: 'other' }, callbacks);
    const rejection = expect(execution).rejects.toThrow('cancelled');
    let drained = false;
    const closing = runtime.closeAll().then(() => { drained = true; });
    await Promise.resolve();
    expect(drained).toBe(false);
    const close = jest.fn(async () => undefined);
    const createCommand = jest.fn();
    resolveConnection({ close, createCommand } as unknown as NetezzaDriverConnection);
    await rejection;
    await closing;
    expect(factory).toHaveBeenCalledWith({ ...target.details, database: 'other' });
    expect(close).toHaveBeenCalledTimes(1);
    expect(createCommand).not.toHaveBeenCalled();
  });

  it.each(['SET TRANSACTION READ ONLY', 'reader', 'reader.close'])('rolls back and closes after failure in %s', async failure => {
    const commands: string[] = [];
    const close = jest.fn(async () => undefined);
    const connection = {
      close,
      createCommand: (sql: string) => {
        commands.push(sql);
        return {
          cancel: async () => undefined,
          executeNonQuery: async () => { if (sql === failure) throw new Error(failure); },
          executeReader: async () => {
            if (failure === 'reader') throw new Error(failure);
            return { fieldCount: 0, read: async () => false, close: async () => { throw new Error('reader.close'); } };
          },
        };
      },
    } as unknown as NetezzaDriverConnection;
    const runtime = new NetezzaRuntime({ connectionFactory: async () => connection });
    await expect(runtime.execute(target, 'SELECT 1', { ...options, readOnly: true }, callbacks)).rejects.toThrow(failure);
    expect(commands.at(-1)).toBe('ROLLBACK');
    expect(close).toHaveBeenCalledTimes(1);
    await runtime.closeAll();
  });

  it('keeps read-only classification independent from the driver', () => {
    expect(isReadOnlySql('SELECT 1; SHOW DATABASE')).toBe(true);
    expect(isReadOnlySql('SELECT 1; INSERT INTO T VALUES (1)')).toBe(false);
  });

  it('owns a connection and drains it on close', async () => {
    const close = jest.fn(async () => undefined);
    const reader = {
      fieldCount: 1,
      getName: () => 'VALUE',
      getTypeName: () => 'INTEGER',
      getValue: () => 7,
      read: jest.fn(async () => true).mockResolvedValueOnce(true).mockResolvedValueOnce(false),
      close: jest.fn(async () => undefined),
    };
    const command = {
      _recordsAffected: 0,
      commandTimeout: 0,
      executeReader: jest.fn(async () => reader),
      executeNonQuery: jest.fn(async () => 0),
      cancel: jest.fn(async () => undefined),
    };
    const connection = {
      createCommand: jest.fn(() => command),
      close,
    } as unknown as NetezzaDriverConnection;
    const runtime = new NetezzaRuntime({ connectionFactory: async () => connection });
    const rows: unknown[][] = [];
    const callbacks: DatabaseQueryCallbacks = {
      onColumns: () => undefined,
      onRows: values => rows.push(...values),
      onCommand: () => undefined,
    };

    await runtime.execute({ connectionId: 'nz-1', details: { host: 'host', port: 5480, database: 'db', user: 'user', password: 'secret' } }, 'SELECT 7', { maxRows: 10, timeoutSeconds: 1 }, callbacks);
    await runtime.closeConnection('nz-1');

    expect(rows).toEqual([[7]]);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('keeps declared numeric type and scale in the portable result metadata', async () => {
    const close = jest.fn(async () => undefined);
    const reader = {
      fieldCount: 1,
      getName: () => 'AMOUNT',
      getTypeName: () => 'NUMERIC',
      getDeclaredTypeName: () => 'NUMERIC(12,2)',
      getColumnMetadata: () => ({ numericScale: 2 }),
      getValue: () => '1234.50',
      read: jest.fn(async () => true).mockResolvedValueOnce(true).mockResolvedValueOnce(false),
      close: jest.fn(async () => undefined),
    };
    const command = {
      _recordsAffected: 0,
      commandTimeout: 0,
      executeReader: jest.fn(async () => reader),
      executeNonQuery: jest.fn(async () => 0),
      cancel: jest.fn(async () => undefined),
    };
    const connection = { createCommand: jest.fn(() => command), close } as unknown as NetezzaDriverConnection;
    const runtime = new NetezzaRuntime({ connectionFactory: async () => connection });
    const columns: unknown[] = [];

    await runtime.execute(target, 'SELECT amount FROM records', { ...options, readOnly: true }, {
      onColumns: values => columns.push(...values),
      onRows: () => undefined,
      onCommand: () => undefined,
    });
    await runtime.closeAll();

    expect(columns).toEqual([{ name: 'AMOUNT', type: 'NUMERIC(12,2)', scale: 2 }]);
  });

  it('loads all catalog fields required by the canonical table DDL', async () => {
    const factoryCalls: Array<{ database: string }> = [];
    const metadataQueries: string[] = [];
    const factory = jest.fn(async (details: { database: string }) => {
      factoryCalls.push({ database: details.database });
      return connectionForMetadata(sql => {
        metadataQueries.push(sql);
        if (sql.includes('_V_RELATION_COLUMN')) {
          return {
            columns: ['OBJID', 'ATTNUM', 'ATTNAME', 'DESCRIPTION', 'FULL_TYPE', 'ATTNOTNULL', 'COLDEFAULT'],
            rows: [
              [42, 1, 'ID', 'Primary key', 'INTEGER', 't', null],
              [42, 2, 'NAME', null, 'VARCHAR(80)', 'f', "'unknown'"],
            ],
          };
        }
        if (sql.includes('_V_TABLE_DIST_MAP')) return { columns: ['ATTNAME'], rows: [['ID']] };
        if (sql.includes('_V_TABLE_ORGANIZE_COLUMN')) return { columns: ['ATTNAME'], rows: [['NAME']] };
        if (sql.includes('_V_RELATION_KEYDATA')) {
          return {
            columns: ['CONSTRAINTNAME', 'CONTYPE', 'ATTNAME', 'PKDATABASE', 'PKSCHEMA', 'PKRELATION', 'PKATTNAME', 'UPDT_TYPE', 'DEL_TYPE'],
            rows: [
              ['PK_USERS', 'p', 'ID', null, null, null, null, 'NO ACTION', 'NO ACTION'],
              ['FK_USERS_OWNER', 'f', 'NAME', 'MYDB', 'ADMIN', 'OWNERS', 'NAME', 'CASCADE', 'RESTRICT'],
            ],
          };
        }
        if (sql.includes('_V_OBJECT_DATA')) return { columns: ['DESCRIPTION'], rows: [["Owner's users"]] };
        throw new Error(`Unexpected metadata SQL: ${sql}`);
      });
    });
    const runtime = new NetezzaRuntime({ connectionFactory: factory });

    await expect(runtime.getTableDdlMetadata(
      { connectionId: 'ddl', details: { host: 'host', port: 5480, database: 'SYSTEM', user: 'user', password: 'secret' } },
      'MYDB',
      'ADMIN',
      'USERS',
    )).resolves.toEqual({
      columns: [
        { name: 'ID', description: 'Primary key', fullTypeName: 'INTEGER', notNull: true, defaultValue: null },
        { name: 'NAME', description: null, fullTypeName: 'VARCHAR(80)', notNull: false, defaultValue: "'unknown'" },
      ],
      distributionColumns: ['ID'],
      organizeColumns: ['NAME'],
      keys: [
        {
          name: 'PK_USERS',
          info: {
            type: 'PRIMARY KEY', typeChar: 'p', columns: ['ID'], pkDatabase: null, pkSchema: null,
            pkRelation: null, pkColumns: [], updateType: 'NO ACTION', deleteType: 'NO ACTION',
          },
        },
        {
          name: 'FK_USERS_OWNER',
          info: {
            type: 'FOREIGN KEY', typeChar: 'f', columns: ['NAME'], pkDatabase: 'MYDB', pkSchema: 'ADMIN',
            pkRelation: 'OWNERS', pkColumns: ['NAME'], updateType: 'CASCADE', deleteType: 'RESTRICT',
          },
        },
      ],
      tableComment: "Owner's users",
      metadataComplete: true,
    });
    expect(factoryCalls).toHaveLength(1);
    expect(factoryCalls.every(call => call.database === 'MYDB')).toBe(true);
    expect(metadataQueries[0]).toContain("D.DBNAME = 'MYDB'");
    expect(metadataQueries[0]).toContain("D.OBJTYPE IN ('TABLE', 'VIEW', 'EXTERNAL TABLE')");
    await runtime.closeAll();
  });

  it('switches the catalog connection to the requested database for view source', async () => {
    const factoryCalls: Array<{ database: string }> = [];
    const runtime = new NetezzaRuntime({
      connectionFactory: jest.fn(async (details: { database: string }) => {
        factoryCalls.push({ database: details.database });
        return connectionForMetadata(sql => {
          expect(sql).toContain('MYDB.._V_VIEW');
          return { columns: ['DEFINITION'], rows: [['SELECT ID FROM USERS;']] };
        });
      }),
    });

    await expect(runtime.getViewDefinition(
      { connectionId: 'view', details: { host: 'host', port: 5480, database: 'SYSTEM', user: 'user', password: 'secret' } },
      'MYDB',
      'ADMIN',
      'V_USERS',
    )).resolves.toBe('SELECT ID FROM USERS;');
    expect(factoryCalls).toEqual([{ database: 'MYDB' }]);
    await runtime.closeAll();
  });
});
