import { AccessConnection, validateJavaExecutablePath, verifyAccessBridgeJar } from '../../extensions/access/src/accessConnection';
import { accessMetadataProvider } from '../../extensions/access/src/accessSchemaProvider';
import type { DatabaseConnectionConfig } from '../contracts/database';
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createHash } from 'crypto';

function createConnection(): AccessConnection {
    const config: DatabaseConnectionConfig = {
        host: '',
        database: '/data/klienci.accdb',
        user: '',
        password: '',
        options: { javaPath: 'java' },
    };
    return new AccessConnection(config);
}

async function rawResult(connection: AccessConnection, sql: string): Promise<{
    columns: { name: string; type: string }[];
    rows: unknown[][];
    recordsAffected: number;
}> {
    const execution = connection.executeRaw(sql);
    if ('requestId' in execution) {
        return execution.result;
    }
    return execution;
}

describe('AccessConnection compatibility commands', () => {
    it('uses the configured VS Code Java path when connection options omit one', () => {
        const get = jest.fn().mockReturnValue('/custom/java');
        (vscode.workspace.getConfiguration as jest.Mock).mockReturnValueOnce({ get });
        const connection = new AccessConnection({
            host: '',
            database: '/data/klienci.accdb',
            user: '',
        });

        expect((connection as unknown as { _javaExecutable: string })._javaExecutable).toBe('/custom/java');
    });

    it('synthesizes CURRENT_SID locally', async () => {
        const connection = createConnection();
        const result = await rawResult(connection, 'SELECT CURRENT_SID');

        expect(result.columns[0].name).toBe('CURRENT_SID');
        expect(result.rows[0][0]).toMatch(/^access-\d+/);
    });

    it('synthesizes CURRENT_CATALOG and CURRENT_SCHEMA locally', async () => {
        const connection = createConnection();

        const catalog = await rawResult(connection, 'SELECT CURRENT_CATALOG');
        expect(catalog.rows[0][0]).toBe('default');

        const schema = await rawResult(connection, 'SELECT CURRENT_SCHEMA');
        expect(schema.rows[0][0]).toBe('default');

        const both = await rawResult(connection, 'SELECT CURRENT_CATALOG, CURRENT_SCHEMA');
        expect(both.columns.map(column => column.name)).toEqual(['CURRENT_CATALOG', 'CURRENT_SCHEMA']);
    });

    it('no-ops SET CATALOG and SET SCHEMA', async () => {
        const connection = createConnection();

        const setCatalog = await rawResult(connection, 'SET CATALOG other');
        expect(setCatalog.rows).toEqual([]);
        expect(setCatalog.recordsAffected).toBe(0);

        const setSchema = await rawResult(connection, 'SET SCHEMA other');
        expect(setSchema.rows).toEqual([]);
    });

    it('returns an empty result for blank sql', async () => {
        const connection = createConnection();
        const result = await rawResult(connection, '   ');

        expect(result.columns).toEqual([]);
        expect(result.rows).toEqual([]);
    });

    it('passes object type markers to the bridge', async () => {
        const connection = createConnection();
        const metadata = jest.fn().mockResolvedValue({
            kind: 'metadata',
            columns: [],
            rows: [],
        });
        (connection as unknown as { _bridge: unknown })._bridge = { metadata };

        await rawResult(connection, accessMetadataProvider.buildObjectTypeQuery('default', 'VIEW'));

        expect(metadata).toHaveBeenCalledWith('object_type', { table: 'VIEW', serverSide: false });
    });

    it('routes metadata markers with escaped table names and server-side flags', async () => {
        const connection = createConnection();
        const metadata = jest.fn().mockResolvedValue({
            kind: 'metadata',
            columns: [],
            rows: [],
        });
        (connection as unknown as { _bridge: unknown })._bridge = { metadata };

        await rawResult(connection, "SELECT * FROM _access_metadata.columns WHERE TABLE = 'O''Reilly'");
        await rawResult(connection, "SELECT * FROM _access_metadata.view_source_search WHERE PATTERN = 'Orders' AND SERVER_SIDE = 1");

        expect(metadata).toHaveBeenNthCalledWith(1, 'columns', {
            table: "O'Reilly",
            serverSide: false,
        });
        expect(metadata).toHaveBeenNthCalledWith(2, 'view_source_search', {
            table: 'Orders',
            serverSide: true,
        });
    });

    it('rejects bridge access after the connection has been closed', async () => {
        const connection = createConnection();

        await expect(Promise.resolve().then(() => connection.getBridge()))
            .rejects.toThrow('connection is not open');
    });

    it('defaults to read-only and blocks writes before they reach the bridge', async () => {
        const connection = createConnection();
        const query = jest.fn();
        (connection as unknown as { _bridge: unknown })._bridge = { query };

        await expect(rawResult(connection, 'UPDATE Klienci SET Imie = \'blocked\'')).rejects.toThrow(/read-only/);
        expect(query).not.toHaveBeenCalled();
    });

    it('allows writes only when readOnly is explicitly false', async () => {
        const connection = new AccessConnection({
            host: '',
            database: '/data/klienci.accdb',
            user: '',
            options: { javaPath: 'java', readOnly: false },
        });
        const query = jest.fn().mockReturnValue({
            columns: [],
            rows: [],
            recordsAffected: 1,
            cancelled: false,
        });
        (connection as unknown as { _bridge: unknown })._bridge = { query };

        await rawResult(connection, 'UPDATE Klienci SET Imie = \'allowed\'');
        expect(query).toHaveBeenCalledWith('UPDATE Klienci SET Imie = \'allowed\'', undefined, undefined);
    });

    it('rejects Java arguments and invalid bridge checksums', () => {
        expect(() => validateJavaExecutablePath('java --version')).toThrow(/absolute path/);
        expect(() => validateJavaExecutablePath('/tmp/node')).toThrow(/java/);

        const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'access-jar-check-'));
        const jarPath = path.join(directory, 'access-bridge.jar');
        const bytes = Buffer.from('test-jar');
        fs.writeFileSync(jarPath, bytes);
        fs.writeFileSync(`${jarPath}.sha256`, `${createHash('sha256').update(bytes).digest('hex')}  access-bridge.jar\n`);
        expect(() => verifyAccessBridgeJar(jarPath)).not.toThrow();
        fs.writeFileSync(`${jarPath}.sha256`, `${'0'.repeat(64)}  access-bridge.jar\n`);
        expect(() => verifyAccessBridgeJar(jarPath)).toThrow(/checksum mismatch/);
        fs.rmSync(directory, { recursive: true, force: true });
    });

    it('accepts an executable path containing spaces', () => {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'access-java-path-'));
        const javaPath = path.join(directory, 'Java Runtime', 'bin', 'java');
        fs.mkdirSync(path.dirname(javaPath), { recursive: true });
        fs.writeFileSync(javaPath, 'java');
        fs.chmodSync(javaPath, 0o755);

        expect(validateJavaExecutablePath(javaPath)).toBe(javaPath);

        fs.rmSync(directory, { recursive: true, force: true });
    });
});

describe('accessMetadataProvider', () => {
    it('routes metadata queries through the _access_metadata marker catalog', () => {
        expect(accessMetadataProvider.buildListTablesQuery('default')).toContain('_access_metadata.tables');
        expect(accessMetadataProvider.buildListViewsQuery('default')).toContain('_access_metadata.views');
        expect(accessMetadataProvider.buildListDatabasesQuery()).toContain('_access_metadata.databases');
        expect(accessMetadataProvider.buildTypeGroupsQuery('default')).toContain('_access_metadata.type_groups');
        expect(accessMetadataProvider.buildListProceduresQuery('default')).toContain('_access_metadata.procedures');
    });

    it('embeds the table name in column markers', () => {
        const query = accessMetadataProvider.buildColumnsWithKeysQuery('default', {
            schema: 'default',
            tableName: 'Klienci',
            objTypes: ['TABLE', 'VIEW'],
        });

        expect(query).toContain("TABLE = 'Klienci'");
        expect(query).toContain('_access_metadata.columns');
    });

    it('embeds the search pattern in object search markers', () => {
        const query = accessMetadataProvider.buildObjectSearchQuery('default', '%KLI%');
        expect(query).toContain("PATTERN = '%KLI%'");
        expect(query).toContain('_access_metadata.object_search');
    });

    it('produces source-search markers with server-side filtering flag', () => {
        const serverSide = accessMetadataProvider.buildViewSourceSearchQuery('default', {
            rawTerm: 'CUSTOMERS',
            likePattern: '%CUSTOMERS%',
            useServerSideFilter: true,
        });
        expect(serverSide).toContain('SERVER_SIDE = 1');

        const clientSide = accessMetadataProvider.buildViewSourceSearchQuery('default', {
            rawTerm: 'CUSTOMERS',
            likePattern: '%CUSTOMERS%',
            useServerSideFilter: false,
        });
        expect(clientSide).toContain('SERVER_SIDE = 0');
    });

    it('filters object type queries to a single normalized type', () => {
        const query = accessMetadataProvider.buildObjectTypeQuery('default', 'view');
        expect(query).toContain("TYPE = 'VIEW'");
    });

    it('escapes marker literals and filters unsupported column object types', () => {
        const columns = accessMetadataProvider.buildColumnsWithKeysQuery('default', {
            tableName: "O'Reilly",
            objTypes: ['TABLE', 'INDEX', 'VIEW'],
        });
        const search = accessMetadataProvider.buildObjectSearchQuery('default', "O'Reilly");

        expect(columns).toContain("TABLE = 'O''Reilly'");
        expect(columns).toContain("OBJTYPES = 'TABLE,VIEW'");
        expect(columns).not.toContain('INDEX');
        expect(search).toContain("PATTERN = 'O''Reilly'");
    });

    it('uses a safe table marker when no column table name is provided', () => {
        expect(accessMetadataProvider.buildColumnsWithKeysQuery('default')).toBe(
            "SELECT * FROM _access_metadata.columns WHERE TABLE = '' AND OBJTYPES = 'TABLE,VIEW'",
        );
    });
});
