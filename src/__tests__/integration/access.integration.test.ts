import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { describe, expect, it } from '@jest/globals';
import type { DatabaseConnectionConfig } from '../../contracts/database';
import type { ConnectionDetails } from '../../types';
import { AccessConnection } from '../../../extensions/access/src/accessConnection';
import { accessDialect } from '../../../extensions/access/src/accessDialect';
import { registerDatabaseDialect } from '../../core/factories/databaseDialectRegistry';
import { importDataToAccess } from '../../import/accessImporter';
import { exportResultSetToFile } from '../../export/resultExporter';
import type { ResultSet } from '../../types';

/**
 * Live integration test for the Microsoft Access dialect. Requires a Java 11+
 * runtime and the bundled `resources/access-bridge.jar`. The `.accdb` fixture
 * is generated at runtime by launching a single-file Java program on the bridge
 * jar classpath (which contains the UCanAccess driver), so no binary fixture is
 * committed.
 */

const EXTENSION_ROOT = path.resolve(__dirname, '..', '..', '..', 'extensions', 'access');
const BRIDGE_JAR = path.join(EXTENSION_ROOT, 'resources', 'access-bridge.jar');

function resolveJavaExecutable(): string | undefined {
    const configured = process.env.ACCESS_TEST_JAVA_PATH;
    if (configured) {
        return configured;
    }
    const javaHome = process.env.JAVA_HOME;
    if (javaHome) {
        return path.join(javaHome, 'bin', process.platform === 'win32' ? 'java.exe' : 'java');
    }
    return 'java';
}

function hasAccessRuntime(): boolean {
    if (!fs.existsSync(BRIDGE_JAR)) {
        return false;
    }
    const java = resolveJavaExecutable();
    if (!java) {
        return false;
    }
    const result = spawnSync(java, ['-version'], { stdio: 'ignore' });
    return result.status === 0;
}

const FIXTURE_SOURCE = `
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.Statement;
import java.nio.file.Files;
import java.nio.file.Paths;
import com.healthmarketscience.jackcess.ColumnBuilder;
import com.healthmarketscience.jackcess.DataType;
import com.healthmarketscience.jackcess.Database;
import com.healthmarketscience.jackcess.DatabaseBuilder;
import com.healthmarketscience.jackcess.IndexBuilder;
import com.healthmarketscience.jackcess.TableBuilder;
import com.healthmarketscience.jackcess.impl.ColumnImpl;

public class AccessFixture {
    public static void main(String[] args) throws Exception {
        String path = args[0];
        Files.deleteIfExists(Paths.get(path));
        Class.forName("net.ucanaccess.jdbc.UcanaccessDriver");
        Connection conn = DriverManager.getConnection(
            "jdbc:ucanaccess://" + path + ";newdatabaseversion=V2016;memory=false");
        Statement st = conn.createStatement();
        st.execute("CREATE TABLE Klienci (ID COUNTER PRIMARY KEY, Imie VARCHAR(50), Miasto VARCHAR(50), Wiek INTEGER, Waga DECIMAL(10,2), Aktywny BOOLEAN, Notatki MEMO, Avatar VARBINARY(100))");
        st.execute("INSERT INTO Klienci (Imie, Miasto, Wiek, Waga, Aktywny, Notatki, Avatar) VALUES ('Anna', 'Warszawa', 34, 62.5, TRUE, 'lubi ''lody''', NULL)");
        st.execute("INSERT INTO Klienci (Imie, Miasto, Wiek, Waga, Aktywny, Notatki, Avatar) VALUES ('Jan', 'Krakow', 45, 80.25, FALSE, NULL, X'010203040506')");
        st.execute("CREATE TABLE Zamowienia (ID COUNTER PRIMARY KEY, KlientID INTEGER, Produkt VARCHAR(50), Ilosc INTEGER, CenaJedn DECIMAL(10,2))");
        st.execute("INSERT INTO Zamowienia (KlientID, Produkt, Ilosc, CenaJedn) VALUES (1, 'Laptop', 1, 4999.99)");
        st.execute("INSERT INTO Zamowienia (KlientID, Produkt, Ilosc, CenaJedn) VALUES (2, 'Mysz', 2, 89.00)");
        for (int i = 1; i <= 10; i++) {
            st.execute("INSERT INTO Zamowienia (KlientID, Produkt, Ilosc, CenaJedn) VALUES (1, 'Produkt" + i + "', 1, 10.00)");
        }
        conn.close();

        if (args.length > 1 && "UNSUPPORTED_SORT_ORDER".equals(args[1])) {
            try (Database database = new DatabaseBuilder(Paths.get(path)).open()) {
                ColumnBuilder name = new ColumnBuilder("NAME", DataType.TEXT)
                    .setLengthInUnits(50);
                name.setTextSortOrder(new ColumnImpl.SortOrder((short) 1045, (byte) 0));
                new TableBuilder("SortOrderSeed")
                    .addColumn(new ColumnBuilder("ID", DataType.LONG))
                    .addColumn(name)
                    .addIndex(new IndexBuilder("SortOrderSeedNameIdx").addColumns("NAME"))
                    .toTable(database);
            }
        }
        System.out.println("FIXTURE_OK");
    }
}
`;

function buildFixture(tempDir: string, java: string, name = 'access-fixture', unsupportedSortOrder = false): string {
    const fixturePath = path.join(tempDir, `${name}.accdb`);
    if (fs.existsSync(fixturePath)) {
        return fixturePath;
    }
    const sourceFile = path.join(tempDir, 'AccessFixture.java');
    fs.writeFileSync(sourceFile, FIXTURE_SOURCE, 'utf8');
    const args = ['-cp', BRIDGE_JAR, sourceFile, fixturePath];
    if (unsupportedSortOrder) {
        args.push('UNSUPPORTED_SORT_ORDER');
    }
    const result = spawnSync(java, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        encoding: 'utf8',
    });
    if (result.status !== 0) {
        throw new Error(`Failed to generate Access fixture: ${result.stderr}`);
    }
    return fixturePath;
}

const describeLive = hasAccessRuntime() ? describe : describe.skip;

describeLive('Microsoft Access dialect (live)', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'access-test-'));
    const java = resolveJavaExecutable() as string;
    let fixturePath: string;

    beforeAll(() => {
        registerDatabaseDialect(accessDialect);
        fixturePath = buildFixture(tempDir, java);
    });

    afterAll(() => {
        try {
            fs.rmSync(tempDir, { recursive: true, force: true });
        } catch {
            // Best effort cleanup.
        }
    });

    function createConnection(database = fixturePath, readOnly = true): AccessConnection {
        const config: DatabaseConnectionConfig = {
            host: '',
            database,
            user: '',
            password: '',
            options: { javaPath: java, readOnly },
        };
        return new AccessConnection(config);
    }

    function connectionDetails(database: string): ConnectionDetails {
        return {
            host: '',
            database,
            user: '',
            password: '',
            options: { javaPath: java, readOnly: false },
            dbType: 'access',
        };
    }

    async function readRows(connection: AccessConnection, sql: string): Promise<unknown[][]> {
        const reader = await connection.createCommand(sql).executeReader();
        const rows: unknown[][] = [];
        try {
            while (await reader.read()) {
                const row: unknown[] = [];
                for (let index = 0; index < reader.fieldCount; index++) {
                    row.push(reader.getValue(index));
                }
                rows.push(row);
            }
            return rows;
        } finally {
            await reader.close();
        }
    }

    it('runs SELECT with correct reader semantics and typed values', async () => {
        const conn = createConnection();
        await conn.connect();
        try {
            const cmd = conn.createCommand('SELECT ID, Imie, Miasto, Waga, Aktywny, Notatki FROM Klienci WHERE ID = 1');
            const reader = await cmd.executeReader();
            expect(reader.fieldCount).toBe(6);
            expect(reader.getName(1)).toBe('Imie');
            const rows: unknown[][] = [];
            while (await reader.read()) {
                const values: unknown[] = [];
                for (let i = 0; i < reader.fieldCount; i += 1) {
                    values.push(reader.getValue(i));
                }
                rows.push(values);
            }
            expect(rows).toEqual([[1, 'Anna', 'Warszawa', 62.5, true, "lubi 'lody'"]]);
            expect(await reader.nextResult()).toBe(false);
            const schema = reader.getSchemaTable?.();
            const schemaRows = Array.isArray(schema) ? schema : schema?.Rows;
            expect(schemaRows?.[3]?.NumericScale).toBe(2);
            await reader.close();
            expect(cmd._recordsAffected).toBe(-1);
        } finally {
            await conn.close();
        }
    });

    it('executes JOIN and GROUP BY through the real SQL engine', async () => {
        const conn = createConnection();
        await conn.connect();
        try {
            const joinReader = await conn
                .createCommand("SELECT k.Imie, z.Produkt FROM Klienci k JOIN Zamowienia z ON z.KlientID = k.ID WHERE z.Produkt IN ('Laptop','Mysz') ORDER BY z.ID")
                .executeReader();
            const joinRows: string[][] = [];
            while (await joinReader.read()) {
                joinRows.push([String(joinReader.getValue(0)), String(joinReader.getValue(1))]);
            }
            await joinReader.close();
            expect(joinRows).toEqual([['Anna', 'Laptop'], ['Jan', 'Mysz']]);

            const aggReader = await conn
                .createCommand('SELECT COUNT(*) AS Cnt, SUM(Ilosc * CenaJedn) AS Total FROM Zamowienia')
                .executeReader();
            await aggReader.read();
            expect(Number(aggReader.getValue(0))).toBe(12);
            await aggReader.close();
        } finally {
            await conn.close();
        }
    });

    it('reports recordsAffected for INSERT/UPDATE/DELETE', async () => {
        const conn = createConnection(fixturePath, false);
        await conn.connect();
        try {
            const insert = conn.createCommand("INSERT INTO Klienci (Imie) VALUES ('Test')");
            await insert.execute();
            expect(insert._recordsAffected).toBe(1);

            const update = conn.createCommand("UPDATE Klienci SET Miasto = 'Zmienione' WHERE Imie = 'Test'");
            await update.execute();
            expect(update._recordsAffected).toBe(1);

            const deleteCmd = conn.createCommand("DELETE FROM Klienci WHERE Imie = 'Test'");
            await deleteCmd.execute();
            expect(deleteCmd._recordsAffected).toBe(1);
        } finally {
            await conn.close();
        }
    });

    it('routes metadata markers and compatibility commands', async () => {
        const conn = createConnection();
        await conn.connect();
        try {
            const meta = conn.createCommand('SELECT * FROM _access_metadata.tables');
            const metaReader = await meta.executeReader();
            const tables: string[] = [];
            while (await metaReader.read()) {
                tables.push(String(metaReader.getValue(0)));
            }
            await metaReader.close();
            expect(tables.sort()).toEqual(['Klienci', 'Zamowienia']);

            const sid = conn.createCommand('SELECT CURRENT_SID');
            const sidReader = await sid.executeReader();
            await sidReader.read();
            expect(String(sidReader.getValue(0))).toMatch(/^access-\d+/);
            await sidReader.close();

            const columns = await readRows(conn, 'SELECT * FROM _access_metadata.columns WHERE TABLE = \'Klienci\'');
            expect(columns.map(row => row[3])).toEqual(
                expect.arrayContaining(['ID', 'Imie', 'Miasto', 'Wiek', 'Waga', 'Aktywny', 'Notatki', 'Avatar']),
            );

            const objectType = await readRows(conn, "SELECT * FROM _access_metadata.object_type WHERE TYPE = 'TABLE'");
            expect(objectType.map(row => row[0])).toEqual(expect.arrayContaining(['Klienci', 'Zamowienia']));

            const search = await readRows(conn, "SELECT * FROM _access_metadata.object_search WHERE PATTERN = 'Klienci'");
            expect(search.some(row => row[1] === 'Klienci')).toBe(true);
        } finally {
            await conn.close();
        }
    });

    it('surfaces query errors and stays usable', async () => {
        const conn = createConnection();
        await conn.connect();
        try {
            await expect(conn.createCommand('SELECT * FROM NieIstnieje').executeReader()).rejects.toThrow();

            const after = conn.createCommand('SELECT COUNT(*) FROM Klienci');
            const reader = await after.executeReader();
            await reader.read();
            expect(Number(reader.getValue(0))).toBe(2);
            await reader.close();
        } finally {
            await conn.close();
        }
    });

    it('shares one bridge across concurrent connections and metadata access', async () => {
        const first = createConnection();
        const second = createConnection();
        try {
            await Promise.all([first.connect(), second.connect()]);

            expect(first.getBridge()).toBe(second.getBridge());

            const queryReader = await first.createCommand('SELECT COUNT(*) FROM Klienci').executeReader();
            await queryReader.read();
            expect(Number(queryReader.getValue(0))).toBe(2);
            await queryReader.close();

            const metadataReader = await second
                .createCommand('SELECT * FROM _access_metadata.tables')
                .executeReader();
            const tables: string[] = [];
            while (await metadataReader.read()) {
                tables.push(String(metadataReader.getValue(0)));
            }
            await metadataReader.close();
            expect(tables).toContain('Klienci');

            await first.close();
            const afterCloseReader = await second.createCommand('SELECT COUNT(*) FROM Zamowienia').executeReader();
            await afterCloseReader.read();
            expect(Number(afterCloseReader.getValue(0))).toBe(12);
            await afterCloseReader.close();
        } finally {
            await first.close();
            await second.close();
        }
    });

    it('cancels an in-flight query and keeps the connection usable', async () => {
        const conn = createConnection();
        await conn.connect();
        try {
            const slow = conn.createCommand('SELECT a.Imie FROM Klienci a, Klienci b, Klienci c, Klienci d, Klienci e');
            const readerPromise = slow.executeReader();
            await new Promise(resolve => setTimeout(resolve, 150));
            await slow.cancel();
            const reader = await readerPromise;
            await reader.close();

            const after = conn.createCommand('SELECT COUNT(*) FROM Klienci');
            const afterReader = await after.executeReader();
            await afterReader.read();
            expect(Number(afterReader.getValue(0))).toBe(2);
            await afterReader.close();
        } finally {
            await conn.close();
        }
    });

    it('streams large results in chunks', async () => {
        const config: DatabaseConnectionConfig = {
            host: '',
            database: fixturePath,
            user: '',
            password: '',
            options: { javaPath: java, chunkSize: 3 },
        };
        const conn = new AccessConnection(config);
        await conn.connect();
        try {
            const cmd = conn.createCommand('SELECT ID, Produkt FROM Zamowienia ORDER BY ID');
            const reader = await cmd.executeReader();
            expect(reader.fieldCount).toBe(2);
            const ids: number[] = [];
            while (await reader.read()) {
                ids.push(Number(reader.getValue(0)));
            }
            await reader.close();
            // 12 rows read fully through multiple fetchMore chunks.
            expect(ids).toHaveLength(12);
            expect(ids).toEqual(Array.from({ length: 12 }, (_, i) => i + 1));
        } finally {
            await conn.close();
        }
    });

    it('releases a partially-read cursor on close', async () => {
        const config: DatabaseConnectionConfig = {
            host: '',
            database: fixturePath,
            user: '',
            password: '',
            options: { javaPath: java, chunkSize: 3 },
        };
        const conn = new AccessConnection(config);
        await conn.connect();
        try {
            const cmd = conn.createCommand('SELECT ID, Produkt FROM Zamowienia ORDER BY ID');
            const reader = await cmd.executeReader();
            await reader.read();
            await reader.read();
            await reader.close();

            const after = conn.createCommand('SELECT COUNT(*) FROM Zamowienia');
            const afterReader = await after.executeReader();
            await afterReader.read();
            expect(Number(afterReader.getValue(0))).toBe(12);
            await afterReader.close();
        } finally {
            await conn.close();
        }
    });

    it('executes common and recursive CTEs', async () => {
        const conn = createConnection();
        await conn.connect();
        try {
            const cte = await conn
                .createCommand('WITH c AS (SELECT Miasto, COUNT(*) AS Cnt FROM Klienci GROUP BY Miasto) SELECT Miasto, Cnt FROM c ORDER BY Miasto')
                .executeReader();
            const rows: string[][] = [];
            while (await cte.read()) {
                rows.push([String(cte.getValue(0)), String(cte.getValue(1))]);
            }
            await cte.close();
            expect(rows).toEqual([['Krakow', '1'], ['Warszawa', '1']]);

            const recursive = await conn
                .createCommand('WITH RECURSIVE seq(n) AS (VALUES(1) UNION ALL SELECT n + 1 FROM seq WHERE n < 5) SELECT n FROM seq ORDER BY n')
                .executeReader();
            const seq: number[] = [];
            while (await recursive.read()) {
                seq.push(Number(recursive.getValue(0)));
            }
            await recursive.close();
            expect(seq).toEqual([1, 2, 3, 4, 5]);
        } finally {
            await conn.close();
        }
    });

    it('exposes binary columns as typed base64 values', async () => {
        const conn = createConnection();
        await conn.connect();
        try {
            const cmd = conn.createCommand('SELECT Avatar FROM Klienci WHERE ID = 2');
            const reader = await cmd.executeReader();
            expect(reader.getTypeName(0).toUpperCase()).toMatch(/BLOB|VARBINARY|BINARY/);
            await reader.read();
            // X'010203040506' -> base64 'AQIDBAUG'
            expect(reader.getValue(0)).toBe('AQIDBAUG');
            await reader.close();
        } finally {
            await conn.close();
        }
    });

    it('supports live CREATE, ALTER, metadata refresh, and DROP without stale objects', async () => {
        const database = buildFixture(tempDir, java, 'access-ddl-fixture');
        const conn = createConnection(database, false);
        await conn.connect();
        try {
            await conn.createCommand('CREATE TABLE LiveCreated (ID INTEGER, NAME VARCHAR(40))').execute();
            expect(await readRows(conn, "SELECT * FROM _access_metadata.object_type WHERE TYPE = 'TABLE'")
                .then(rows => rows.some(row => row[0] === 'LiveCreated'))).toBe(true);

            await conn.createCommand('ALTER TABLE LiveCreated ADD COLUMN ACTIVE BOOLEAN').execute();
            const columns = await readRows(conn, "SELECT * FROM _access_metadata.columns WHERE TABLE = 'LiveCreated'");
            expect(columns.map(row => row[3])).toEqual(expect.arrayContaining(['ID', 'NAME', 'ACTIVE']));

            await conn.createCommand('DROP TABLE LiveCreated').execute();
            const tables = await readRows(conn, 'SELECT * FROM _access_metadata.tables');
            expect(tables.some(row => row[0] === 'LiveCreated')).toBe(false);
            await expect(conn.createCommand('SELECT * FROM LiveCreated').executeReader())
                .rejects.toThrow(/object not found|does not exist|not found/i);
        } finally {
            await conn.close();
        }
    });

    it('imports CSV data into Access and keeps the active connection usable', async () => {
        const database = buildFixture(tempDir, java, 'access-import-fixture');
        const csvPath = path.join(tempDir, 'access-import.csv');
        fs.writeFileSync(csvPath, 'ID,NAME,ACTIVE\n101,O\'Reilly,true\n102,Ada,false\n', 'utf8');
        const conn = createConnection(database, false);
        await conn.connect();
        try {
            const result = await importDataToAccess(
                csvPath,
                'ImportedRows',
                connectionDetails(database),
                undefined,
                undefined,
                { forcedColumnTypes: { 2: 'BOOLEAN' } },
            );
            expect(result.success).toBe(true);

            const rows = await readRows(conn, 'SELECT ID, NAME, ACTIVE FROM ImportedRows ORDER BY ID');
            expect(rows).toEqual([
                [101, "O'Reilly", true],
                [102, 'Ada', false],
            ]);
        } finally {
            await conn.close();
        }
    });

    it('reopens JDBC after a SortOrder 1045 import failure', async () => {
        const database = buildFixture(tempDir, java, 'access-sort-order-1045-fixture', true);
        const csvPath = path.join(tempDir, 'access-sort-order-import.csv');
        fs.writeFileSync(csvPath, 'ID,NAME\n201,AfterError\n', 'utf8');
        const conn = createConnection(database, false);
        await conn.connect();
        try {
            const before = await readRows(conn, 'SELECT COUNT(*) FROM Klienci');
            expect(Number(before[0][0])).toBe(2);

            const result = await importDataToAccess(
                csvPath,
                'SortOrderSeed',
                connectionDetails(database),
                undefined,
                undefined,
                { appendToExistingTable: true },
            );
            expect(result.success).toBe(false);
            expect(result.message).toMatch(/SortOrder|sort order|collat|UCAExc/i);

            const after = await readRows(conn, 'SELECT COUNT(*) FROM Klienci');
            expect(Number(after[0][0])).toBe(2);
        } finally {
            await conn.close();
        }
    });

    it('blocks INSERT/UPDATE/DELETE when the database is opened read-only', async () => {
        const conn = createConnection(fixturePath, true);
        await conn.connect();
        try {
            await expect(conn.createCommand("INSERT INTO Klienci (Imie) VALUES ('Blocked')").execute())
                .rejects.toThrow(/read-only/i);
            await expect(conn.createCommand("UPDATE Klienci SET Miasto = 'X' WHERE ID = 1").execute())
                .rejects.toThrow(/read-only/i);
            await expect(conn.createCommand('DELETE FROM Klienci WHERE ID = 1').execute())
                .rejects.toThrow(/read-only/i);

            const after = await readRows(conn, 'SELECT COUNT(*) FROM Klienci');
            expect(Number(after[0][0])).toBe(2);
        } finally {
            await conn.close();
        }
    });

    it('exports a live result set to CSV through the shared exporter', async () => {
        const conn = createConnection();
        await conn.connect();
        const csvOut = path.join(tempDir, 'access-export.csv');
        try {
            const rows = await readRows(conn, 'SELECT ID, Imie FROM Klienci ORDER BY ID');
            const resultSet = {
                columns: [
                    { name: 'ID', type: 'INTEGER' },
                    { name: 'Imie', type: 'VARCHAR' },
                ],
                data: rows.map(row => [row[0], row[1]]),
                rowCount: rows.length,
            } as unknown as ResultSet;

            await exportResultSetToFile(resultSet, csvOut, { format: 'csv' });

            const exported = fs.readFileSync(csvOut, 'utf8');
            expect(exported).toContain('Anna');
            expect(exported).toContain('Jan');
        } finally {
            await conn.close();
        }
    });
});
