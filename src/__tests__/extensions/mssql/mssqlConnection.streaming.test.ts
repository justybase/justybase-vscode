import { EventEmitter } from 'events';
import {
    MsSqlConnection,
    MsSqlStreamQueue,
    MsSqlStreamingDataReader,
    type MsSqlStreamRequest,
} from '../../../../extensions/mssql/src/mssqlConnection';
import type { IColumnMetadata } from 'mssql';

type MockColumnMeta = Record<string, IColumnMetadata>;

class MockStreamRequest extends EventEmitter implements MsSqlStreamRequest {
    public stream = false;
    public cancelled = false;
    public paused = false;
    public queryCalls: string[] = [];
    private _queryResult: Promise<unknown> = Promise.resolve({});

    public cancel(): void {
        this.cancelled = true;
        this.emit('error', new Error('Canceled.'));
    }

    public pause(): boolean {
        this.paused = true;
        return true;
    }

    public resume(): boolean {
        this.paused = false;
        return true;
    }

    public query(command: string): Promise<unknown> {
        this.queryCalls.push(command);
        return this._queryResult;
    }

    public setQueryResult(result: Promise<unknown>): void {
        this._queryResult = result;
    }
}

class DelayedCancelStreamRequest extends MockStreamRequest {
    public override cancel(): void {
        this.cancelled = true;
        setImmediate(() => this.emit('error', new Error('Canceled.')));
    }
}

function createColumns(names: string[]): MockColumnMeta {
    const columns: MockColumnMeta = {};
    names.forEach((name, index) => {
        columns[name] = {
            index,
            name,
            length: 0,
            type: { name: name === 'ID' ? 'Int' : 'NVarChar' },
            nullable: true,
            caseSensitive: false,
            identity: false,
            readOnly: false,
        };
    });
    return columns;
}

function createConnectionWithRequest(request: MockStreamRequest): MsSqlConnection {
    const connection = new MsSqlConnection({
        host: 'mssql.example.local',
        port: 1433,
        database: 'TESTDB',
        user: 'sa',
        password: 'secret',
    });
    connection.createStreamRequest = () => request;
    // Bypass pool for streaming path (loadMsSql still runs; inject after connect skip).
    (connection as unknown as { _connected: boolean })._connected = true;
    return connection;
}

describe('MsSqlStreamQueue', () => {
    it('applies pause/resume backpressure around the high-water mark', async () => {
        const pauses: number[] = [];
        const resumes: number[] = [];
        const queue = new MsSqlStreamQueue(
            4,
            () => {
                pauses.push(queue.length);
            },
            () => {
                resumes.push(queue.length);
            },
        );

        for (let i = 0; i < 4; i++) {
            queue.push({ kind: 'row', values: [i] });
        }
        expect(pauses).toEqual([4]);

        await queue.take();
        await queue.take();
        expect(resumes).toEqual([2]);
    });
});

describe('MsSqlConnection async streaming', () => {
    it('streams rows through request events without buffering the full result', async () => {
        const request = new MockStreamRequest();
        const connection = createConnectionWithRequest(request);
        const command = connection.createCommand('SELECT ID, NAME FROM EMP');

        const executePromise = command.executeReader();

        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(request.stream).toBe(true);
        expect(request.queryCalls).toEqual(['SELECT ID, NAME FROM EMP']);

        request.emit('recordset', createColumns(['ID', 'NAME']));
        request.emit('row', { ID: 1, NAME: 'Alice' });
        request.emit('row', { ID: 2, NAME: 'Bob' });
        request.emit('done', { rowsAffected: [2] });

        const reader = await executePromise;
        expect(reader.fieldCount).toBe(2);
        expect(reader.getName(0)).toBe('ID');
        expect(reader.getTypeName(0)).toBe('Int');

        await expect(reader.read()).resolves.toBe(true);
        expect(reader.getValue(0)).toBe(1);
        expect(reader.getValue(1)).toBe('Alice');

        await expect(reader.read()).resolves.toBe(true);
        expect(reader.getValue(0)).toBe(2);
        expect(reader.getValue(1)).toBe('Bob');

        await expect(reader.read()).resolves.toBe(false);
        await reader.close();
    });

    it('allows the event loop to run while waiting for the first recordset', async () => {
        const request = new MockStreamRequest();
        const connection = createConnectionWithRequest(request);
        const executePromise = connection.createCommand('SELECT 1 AS X').executeReader();

        let immediateRan = false;
        await new Promise<void>((resolve) => {
            setImmediate(() => {
                immediateRan = true;
                resolve();
            });
        });
        expect(immediateRan).toBe(true);

        request.emit('recordset', createColumns(['X']));
        request.emit('row', { X: 1 });
        request.emit('done', { rowsAffected: [1] });

        const reader = await executePromise;
        await expect(reader.read()).resolves.toBe(true);
        expect(reader.getValue(0)).toBe(1);
        await reader.close();
    });

    it('rejects executeReader when cancelled before the first recordset', async () => {
        const request = new MockStreamRequest();
        request.setQueryResult(new Promise(() => undefined));
        const connection = createConnectionWithRequest(request);
        const command = connection.createCommand('SELECT ID FROM EMP');

        const executePromise = command.executeReader();
        await new Promise<void>((resolve) => setImmediate(resolve));
        await command.cancel();

        await expect(executePromise).rejects.toThrow('Query cancelled.');
        expect(request.cancelled).toBe(true);
    });

    it('stops further reads after cancel mid-stream (soft cancel parity)', async () => {
        const request = new MockStreamRequest();
        const connection = createConnectionWithRequest(request);
        const command = connection.createCommand('SELECT ID, NAME FROM EMP');
        const executePromise = command.executeReader();

        await new Promise<void>((resolve) => setImmediate(resolve));
        request.emit('recordset', createColumns(['ID', 'NAME']));
        request.emit('row', { ID: 1, NAME: 'Alice' });
        request.emit('row', { ID: 2, NAME: 'Bob' });
        request.emit('row', { ID: 3, NAME: 'Carol' });

        const reader = await executePromise;
        await expect(reader.read()).resolves.toBe(true);
        expect(reader.getValue(0)).toBe(1);

        await command.cancel();
        await expect(reader.read()).resolves.toBe(false);
        expect(request.cancelled).toBe(true);
    });

    it('keeps the cancellation error listener until an asynchronous cancel settles', async () => {
        const request = new DelayedCancelStreamRequest();
        const connection = createConnectionWithRequest(request);
        const executePromise = connection.createCommand('SELECT ID FROM EMP').executeReader();

        await new Promise<void>((resolve) => setImmediate(resolve));
        request.emit('recordset', createColumns(['ID']));
        request.emit('row', { ID: 1 });

        const reader = await executePromise;
        await expect(reader.read()).resolves.toBe(true);
        await reader.close();
        await new Promise<void>((resolve) => setImmediate(resolve));

        expect(request.listenerCount('error')).toBe(0);
    });

    it('supports nextResult for multiple recordsets', async () => {
        const request = new MockStreamRequest();
        const connection = createConnectionWithRequest(request);
        const executePromise = connection
            .createCommand('SELECT 1 AS A; SELECT 2 AS B')
            .executeReader();

        await new Promise<void>((resolve) => setImmediate(resolve));
        request.emit('recordset', createColumns(['A']));
        request.emit('row', { A: 1 });
        request.emit('recordset', createColumns(['B']));
        request.emit('row', { B: 2 });
        request.emit('done', { rowsAffected: [1, 1] });

        const reader = await executePromise;
        await expect(reader.read()).resolves.toBe(true);
        expect(reader.getValue(0)).toBe(1);
        await expect(reader.read()).resolves.toBe(false);

        await expect(reader.nextResult()).resolves.toBe(true);
        expect(reader.getName(0)).toBe('B');
        await expect(reader.read()).resolves.toBe(true);
        expect(reader.getValue(0)).toBe(2);
        await expect(reader.read()).resolves.toBe(false);
        await reader.close();
    });

    it('closes empty DML streams without requiring a recordset', async () => {
        const request = new MockStreamRequest();
        const connection = createConnectionWithRequest(request);
        const executePromise = connection
            .createCommand('UPDATE T SET X = 1')
            .executeReader();

        await new Promise<void>((resolve) => setImmediate(resolve));
        request.emit('done', { rowsAffected: [3] });

        const reader = await executePromise;
        expect(reader.fieldCount).toBe(0);
        await expect(reader.read()).resolves.toBe(false);
        expect((reader as MsSqlStreamingDataReader).rowsAffected).toBe(3);
        await reader.close();
    });
});
