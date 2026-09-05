import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { DatabaseObjectSnapshot, DesignerSnapshotRequest } from '@justybase/contracts';
import { closeDuckDbDatabase, closeSqliteDatabase, executeNetezzaQuery } from '../src/netezza';
import { getDesignerSnapshotResponse, DesignerSnapshotUnavailableError } from '../src/designerSnapshotService';
import { resolveLocalDatabasePath } from '../src/localDatabaseSandbox';
import type { StoredConnection } from '../src/store';

function profile(root: string): StoredConnection {
  return {
    id: `designer-snapshot-${Date.now()}-${Math.random()}`,
    name: 'SQLite designer snapshot test',
    host: '',
    port: 0,
    database: 'designer.sqlite',
    user: '',
    dbType: 'sqlite',
    passwordCiphertext: '',
    passwordIv: '',
    passwordAuthTag: '',
    readOnly: false,
    userId: 'user-1',
    localDbRoot: root,
  };
}

function tableDefinition(snapshot: DatabaseObjectSnapshot): Extract<DatabaseObjectSnapshot['definition'], { kind: 'table' }> {
  if (snapshot.definition.kind !== 'table') throw new Error('Expected a table snapshot.');
  return snapshot.definition;
}

describe('designerSnapshotService', () => {
  it('loads SQLite columns, indexes, constraints, triggers, source DDL, and a stable fingerprint', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'justybase-designer-snapshot-'));
    const connection = profile(root);
    const databasePath = resolveLocalDatabasePath(connection.database, { root, userId: connection.userId! });
    mkdirSync(path.dirname(databasePath), { recursive: true });
    const database = new DatabaseSync(databasePath);
    database.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE customers (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL
      );
      CREATE TABLE orders (
        id INTEGER PRIMARY KEY,
        customer_id INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'new',
        created_at TEXT,
        UNIQUE (customer_id, created_at),
        CONSTRAINT orders_status_ck CHECK (length(status) > 0),
        FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE ON UPDATE CASCADE
      );
      CREATE UNIQUE INDEX orders_status_idx ON orders(status);
      CREATE TRIGGER orders_status_changed
        AFTER UPDATE OF status ON orders
        FOR EACH ROW
        WHEN NEW.status <> OLD.status
        BEGIN
          SELECT NEW.status;
        END;
      CREATE VIEW order_summary AS SELECT id, status FROM orders;
    `);
    database.close();

    const request: DesignerSnapshotRequest = {
      connectionId: connection.id,
      database: 'main',
      schema: 'main',
      objectName: 'orders',
      objectType: 'TABLE',
    };

    try {
      const response = await getDesignerSnapshotResponse(connection, request, 'test-master-key');
      const { snapshot } = response;
      const ordersDefinition = tableDefinition(snapshot);
      expect(snapshot.target).toEqual(expect.objectContaining({ objectName: 'orders', objectType: 'TABLE' }));
      expect(snapshot.sourceDdl).toContain('CREATE TABLE orders');
      expect(snapshot.fingerprint).toMatch(/^[a-f0-9]{64}$/u);
      expect(ordersDefinition.columns).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: 'id', dataType: 'INTEGER', nullable: true, ordinal: 1 }),
        expect.objectContaining({ name: 'status', dataType: 'TEXT', defaultExpression: "'new'" }),
      ]));
      expect(ordersDefinition.constraints).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: 'primaryKey', columns: ['id'] }),
        expect.objectContaining({ kind: 'check', name: 'orders_status_ck', expression: 'length(status) > 0' }),
        expect.objectContaining({ kind: 'foreignKey', columns: ['customer_id'], referencedTable: 'customers', referencedColumns: ['id'], onDelete: 'CASCADE', onUpdate: 'CASCADE' }),
      ]));
      expect(ordersDefinition.indexes).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: 'relational', name: 'orders_status_idx', unique: true, sourceDdl: expect.stringContaining('CREATE UNIQUE INDEX orders_status_idx'), columns: [{ expression: 'status' }] }),
      ]));
      expect(snapshot.definition.triggers).toEqual([
        expect.objectContaining({
          name: 'orders_status_changed',
          timing: 'AFTER',
          events: ['UPDATE'],
          level: 'ROW',
          updateColumns: ['status'],
          whenExpression: 'NEW.status <> OLD.status',
        }),
      ]);
      const viewResponse = await getDesignerSnapshotResponse(connection, {
        ...request,
        objectName: 'order_summary',
        objectType: 'VIEW',
      }, 'test-master-key');
      expect(viewResponse.snapshot.objectType).toBe('VIEW');
      expect(viewResponse.snapshot.sourceDdl).toContain('CREATE VIEW order_summary');
      expect(viewResponse.snapshot.definition).toEqual(expect.objectContaining({
        kind: 'view',
        query: 'SELECT id, status FROM orders',
        columns: expect.arrayContaining([expect.objectContaining({ name: 'status' })]),
      }));
    } finally {
      closeSqliteDatabase(connection.id);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('reports provider-backed snapshots as unavailable until an adapter is registered', async () => {
    const connection: StoredConnection = {
      id: 'netezza-snapshot',
      name: 'Netezza',
      host: 'localhost',
      port: 5480,
      database: 'SYSTEM',
      user: 'ADMIN',
      dbType: 'netezza',
      passwordCiphertext: 'ciphertext',
      passwordIv: 'iv',
      passwordAuthTag: 'tag',
      readOnly: true,
    };

    await expect(getDesignerSnapshotResponse(connection, {
      connectionId: connection.id,
      objectName: 'FACT_SALES',
      objectType: 'TABLE',
    }, 'test-master-key')).rejects.toBeInstanceOf(DesignerSnapshotUnavailableError);
  });

  it('loads DuckDB columns, constraints, indexes, source DDL, and a fingerprint when the optional runtime is installed', async () => {
    const modulePath = process.env.JUSTYBASE_DUCKDB_MODULE_PATH ?? path.join(process.cwd(), 'extensions/duckdb/node_modules/@duckdb/node-api');
    if (!existsSync(modulePath)) return;
    const connection: StoredConnection = {
      id: `duckdb-designer-snapshot-${Date.now()}-${Math.random()}`,
      name: 'DuckDB designer snapshot test',
      host: '',
      port: 0,
      database: ':memory:',
      user: '',
      dbType: 'duckdb',
      passwordCiphertext: '',
      passwordIv: '',
      passwordAuthTag: '',
      readOnly: false,
    };
    const execute = (sql: string) => executeNetezzaQuery(connection, sql, {
      masterKey: 'test-master-key',
      maxRows: 100,
      timeoutSeconds: 30,
      readOnly: false,
    }, {
      onColumns: () => undefined,
      onRows: () => undefined,
      onCommand: () => undefined,
    });

    try {
      await execute('CREATE TABLE customers (id INTEGER PRIMARY KEY, code VARCHAR UNIQUE)');
      await execute(`
        CREATE TABLE orders (
          id INTEGER PRIMARY KEY,
          customer_id INTEGER,
          status VARCHAR,
          CONSTRAINT fk_orders_customer FOREIGN KEY (customer_id) REFERENCES customers(id),
          CONSTRAINT chk_orders_status CHECK (status <> '')
        )
      `);
      await execute('CREATE UNIQUE INDEX orders_status_idx ON orders(status)');
      await execute('CREATE VIEW orders_view AS SELECT id, status FROM orders');
      const response = await getDesignerSnapshotResponse(connection, {
        connectionId: connection.id,
        database: 'memory',
        schema: 'main',
        objectName: 'orders',
        objectType: 'TABLE',
      }, 'test-master-key');
      const ordersDefinition = tableDefinition(response.snapshot);
      expect(response.snapshot.sourceDdl).toContain('CREATE TABLE orders');
      expect(response.snapshot.fingerprint).toMatch(/^[a-f0-9]{64}$/u);
      expect(ordersDefinition.columns).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: 'id', dataType: 'INTEGER', ordinal: 1, nullable: false }),
        expect.objectContaining({ name: 'status', dataType: 'VARCHAR', ordinal: 3 }),
      ]));
      expect(ordersDefinition.constraints).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: 'primaryKey', name: 'orders_id_pkey', columns: ['id'], enforced: true }),
        expect.objectContaining({ kind: 'check', name: 'orders_status_check', expression: "(status != '')", enforced: true }),
        expect.objectContaining({ kind: 'foreignKey', name: 'orders_customer_id_id_fkey', columns: ['customer_id'], referencedTable: 'customers', referencedColumns: ['id'], enforced: true }),
      ]));
      expect(ordersDefinition.indexes).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: 'relational', name: 'orders_status_idx', unique: true, sourceDdl: expect.stringContaining('CREATE UNIQUE INDEX orders_status_idx'), columns: [{ expression: 'status' }] }),
      ]));
      const viewResponse = await getDesignerSnapshotResponse(connection, {
        connectionId: connection.id,
        database: 'memory',
        schema: 'main',
        objectName: 'orders_view',
        objectType: 'VIEW',
      }, 'test-master-key');
      expect(viewResponse.snapshot.sourceDdl).toContain('CREATE VIEW orders_view');
      expect(viewResponse.snapshot.definition).toEqual(expect.objectContaining({
        kind: 'view',
        query: 'SELECT id, status FROM orders',
        columns: expect.arrayContaining([expect.objectContaining({ name: 'status' })]),
      }));
    } finally {
      await closeDuckDbDatabase(connection.id);
    }
  });
});
