import { PassThrough } from 'stream';
import { spawn } from 'child_process';
import { JavaBridgeClient } from '../../extensions/access/src/javaBridgeClient';

jest.mock('child_process', () => ({
    spawn: jest.fn(),
}));

const mockedSpawn = spawn as jest.Mock;

interface FakeProcess {
    stdout: PassThrough;
    stderr: PassThrough;
    stdin: PassThrough;
    once: jest.Mock;
    kill: jest.Mock;
}

function createFakeProcess(): FakeProcess {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const stdin = new PassThrough();
    return {
        stdout,
        stderr,
        stdin,
        once: jest.fn(),
        kill: jest.fn(),
    };
}

function writeJson(stream: PassThrough, payload: unknown): void {
    stream.write(`${JSON.stringify(payload)}\n`);
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
    const startedAt = Date.now();
    while (!predicate()) {
        if (Date.now() - startedAt > timeoutMs) {
            throw new Error('Timed out waiting for condition.');
        }
        await new Promise(resolve => setImmediate(resolve));
    }
}

function collectRequests(stdin: PassThrough): Record<string, unknown>[] {
    const requests: Record<string, unknown>[] = [];
    stdin.on('data', (chunk: Buffer) => {
        for (const line of chunk.toString().split('\n')) {
            const trimmed = line.trim();
            if (trimmed) {
                requests.push(JSON.parse(trimmed) as Record<string, unknown>);
            }
        }
    });
    return requests;
}

function requestId(request: Record<string, unknown>): number {
    return request.id as number;
}

async function closeClient(
    client: JavaBridgeClient,
    proc: FakeProcess,
    requests: Record<string, unknown>[],
): Promise<void> {
    const closePromise = client.close();
    await waitFor(() => requests.some(request => request.op === 'close'));
    const closeRequest = requests.find(request => request.op === 'close');
    expect(closeRequest).toBeDefined();
    writeJson(proc.stdout, { id: requestId(closeRequest as Record<string, unknown>), ok: true });
    await closePromise;
}

describe('JavaBridgeClient', () => {
    afterEach(() => {
        mockedSpawn.mockReset();
    });

    it('starts, connects, runs a query and maps the result', async () => {
        const proc = createFakeProcess();
        mockedSpawn.mockReturnValue(proc);
        const requests = collectRequests(proc.stdin);

        const client = new JavaBridgeClient({
            javaExecutable: 'java',
            bridgeJarPath: '/bridge/access-bridge.jar',
        });

        const startPromise = client.start();
        await waitFor(() => requests.length >= 1);
        expect(requests[0].op).toBe('ping');
        writeJson(proc.stdout, { id: requestId(requests[0]), ok: true });
        await startPromise;

        const connectPromise = client.connect('/tmp/demo.accdb');
        await waitFor(() => requests.length >= 2);
        expect(requests[1].op).toBe('connect');
        expect(requests[1].path).toBe('/tmp/demo.accdb');
        expect(requests[1].readOnly).toBe(true);
        writeJson(proc.stdout, { id: requestId(requests[1]), ok: true });
        await connectPromise;

        const pending = client.query('SELECT * FROM T');
        await waitFor(() => requests.length >= 3);
        expect(requests[2].op).toBe('query');
        expect(requests[2].sql).toBe('SELECT * FROM T');

        writeJson(proc.stdout, {
            id: requestId(requests[2]),
            ok: true,
            kind: 'query',
            columns: [{ name: 'ID', type: 'INTEGER' }],
            rows: [[1]],
            recordsAffected: -1,
        });

        const result = await pending.result;
        expect(result.kind).toBe('query');
        expect(result.columns[0].name).toBe('ID');
        expect(result.rows).toEqual([[1]]);
        expect(result.cancelled).toBe(false);

        await closeClient(client, proc, requests);
    });

    it('forwards an optional Access password without logging it', async () => {
        const proc = createFakeProcess();
        mockedSpawn.mockReturnValue(proc);
        const requests = collectRequests(proc.stdin);
        const client = new JavaBridgeClient({ javaExecutable: 'java', bridgeJarPath: '/x.jar' });

        const startPromise = client.start();
        await waitFor(() => requests.length >= 1);
        writeJson(proc.stdout, { id: requestId(requests[0]), ok: true });
        await startPromise;

        const password = 'do-not-log-this-password';
        const connectPromise = client.connect('/tmp/protected.accdb', { password });
        await waitFor(() => requests.length >= 2);
        expect(requests[1]).toMatchObject({
            op: 'connect',
            path: '/tmp/protected.accdb',
            password,
        });
        writeJson(proc.stdout, { id: requestId(requests[1]), ok: true });
        await connectPromise;

        expect(JSON.stringify(requests)).toContain(password);
        await closeClient(client, proc, requests);
    });

    it('rejects the query promise when the bridge reports an error', async () => {
        const proc = createFakeProcess();
        mockedSpawn.mockReturnValue(proc);
        const requests = collectRequests(proc.stdin);

        const client = new JavaBridgeClient({ javaExecutable: 'java', bridgeJarPath: '/x.jar' });

        const startPromise = client.start();
        await waitFor(() => requests.length >= 1);
        writeJson(proc.stdout, { id: requestId(requests[0]), ok: true });
        await startPromise;

        const pending = client.query('SELECT broken');
        await waitFor(() => requests.length >= 2);
        writeJson(proc.stdout, {
            id: requestId(requests[1]),
            ok: false,
            error: 'Syntax error in query.',
        });

        await expect(pending.result).rejects.toThrow('Syntax error in query.');
        await closeClient(client, proc, requests);
    });

    it('maps update responses and preserves affected-row counts', async () => {
        const proc = createFakeProcess();
        mockedSpawn.mockReturnValue(proc);
        const requests = collectRequests(proc.stdin);
        const client = new JavaBridgeClient({ javaExecutable: 'java', bridgeJarPath: '/x.jar' });

        const startPromise = client.start();
        await waitFor(() => requests.length >= 1);
        writeJson(proc.stdout, { id: requestId(requests[0]), ok: true });
        await startPromise;

        const pending = client.query('UPDATE T SET VALUE = 1');
        await waitFor(() => requests.length >= 2);
        writeJson(proc.stdout, {
            id: requestId(requests[1]),
            ok: true,
            kind: 'update',
            recordsAffected: 3,
        });

        await expect(pending.result).resolves.toMatchObject({
            kind: 'update',
            recordsAffected: 3,
        });
        await closeClient(client, proc, requests);
    });

    it('routes metadata requests and maps metadata responses', async () => {
        const proc = createFakeProcess();
        mockedSpawn.mockReturnValue(proc);
        const requests = collectRequests(proc.stdin);
        const client = new JavaBridgeClient({ javaExecutable: 'java', bridgeJarPath: '/x.jar' });

        const startPromise = client.start();
        await waitFor(() => requests.length >= 1);
        writeJson(proc.stdout, { id: requestId(requests[0]), ok: true });
        await startPromise;

        const pending = client.metadata('columns', { table: "O'Reilly", serverSide: true });
        await waitFor(() => requests.length >= 2);
        expect(requests[1]).toMatchObject({
            op: 'metadata',
            kind: 'columns',
            table: "O'Reilly",
            serverSide: true,
        });
        writeJson(proc.stdout, {
            id: requestId(requests[1]),
            ok: true,
            kind: 'metadata',
            columns: [{ name: 'NAME', type: 'TEXT' }],
            rows: [["O'Reilly"]],
        });

        await expect(pending).resolves.toEqual({
            kind: 'metadata',
            columns: [{ name: 'NAME', type: 'TEXT' }],
            rows: [["O'Reilly"]],
        });
        await closeClient(client, proc, requests);
    });

    it('makes close idempotent and does not send a second close request', async () => {
        const proc = createFakeProcess();
        mockedSpawn.mockReturnValue(proc);
        const requests = collectRequests(proc.stdin);
        const client = new JavaBridgeClient({ javaExecutable: 'java', bridgeJarPath: '/x.jar' });

        const startPromise = client.start();
        await waitFor(() => requests.length >= 1);
        writeJson(proc.stdout, { id: requestId(requests[0]), ok: true });
        await startPromise;

        const closePromise = client.close();
        await waitFor(() => requests.length >= 2);
        expect(requests[1].op).toBe('close');
        writeJson(proc.stdout, { id: requestId(requests[1]), ok: true });
        await closePromise;
        await client.close();

        expect(requests.filter(request => request.op === 'close')).toHaveLength(1);
        expect(proc.kill).toHaveBeenCalledTimes(1);
    });

    it('forwards cancellation with the original query id', async () => {
        const proc = createFakeProcess();
        mockedSpawn.mockReturnValue(proc);
        const requests = collectRequests(proc.stdin);

        const client = new JavaBridgeClient({ javaExecutable: 'java', bridgeJarPath: '/x.jar' });

        const startPromise = client.start();
        await waitFor(() => requests.length >= 1);
        writeJson(proc.stdout, { id: requestId(requests[0]), ok: true });
        await startPromise;

        const pending = client.query('SELECT * FROM BigTable');
        await waitFor(() => requests.length >= 2);
        const queryRequest = requests[1];

        const cancelPromise = client.cancel(requestId(queryRequest));
        await waitFor(() => requests.length >= 3);
        expect(requests[2].op).toBe('cancel');
        expect(requests[2].queryId).toBe(requestId(queryRequest));
        writeJson(proc.stdout, { id: requestId(requests[2]), ok: true });
        await cancelPromise;

        writeJson(proc.stdout, {
            id: requestId(queryRequest),
            ok: true,
            kind: 'query',
            columns: [],
            rows: [],
            recordsAffected: -1,
            cancelled: true,
        });

        const result = await pending.result;
        expect(result.cancelled).toBe(true);
        await closeClient(client, proc, requests);
    });

    it('streams a cursor through fetchMore and closes it', async () => {
        const proc = createFakeProcess();
        mockedSpawn.mockReturnValue(proc);
        const requests = collectRequests(proc.stdin);

        const client = new JavaBridgeClient({ javaExecutable: 'java', bridgeJarPath: '/x.jar' });

        const startPromise = client.start();
        await waitFor(() => requests.length >= 1);
        writeJson(proc.stdout, { id: requestId(requests[0]), ok: true });
        await startPromise;

        const pending = client.query('SELECT * FROM BigTable', undefined, 2);
        await waitFor(() => requests.length >= 2);
        expect(requests[1].chunkSize).toBe(2);
        const queryRequest = requests[1];
        const cursorId = requestId(queryRequest);

        writeJson(proc.stdout, {
            id: cursorId,
            ok: true,
            kind: 'query',
            columns: [{ name: 'A', type: 'INTEGER' }],
            rows: [[1], [2]],
            recordsAffected: -1,
            cursorId,
            hasMore: true,
        });

        const first = await pending.result;
        expect(first.hasMore).toBe(true);
        expect(first.cursorId).toBe(cursorId);
        expect(first.rows).toEqual([[1], [2]]);

        const fetchPromise = client.fetchMore(cursorId, 2);
        await waitFor(() => requests.length >= 3);
        expect(requests[2].op).toBe('fetchMore');
        expect(requests[2].cursorId).toBe(cursorId);
        writeJson(proc.stdout, { id: requestId(requests[2]), ok: true, kind: 'fetch', rows: [[3]], hasMore: false });

        const chunk = await fetchPromise;
        expect(chunk.rows).toEqual([[3]]);
        expect(chunk.hasMore).toBe(false);

        await closeClient(client, proc, requests);
    });

    it('closes an open cursor explicitly', async () => {
        const proc = createFakeProcess();
        mockedSpawn.mockReturnValue(proc);
        const requests = collectRequests(proc.stdin);

        const client = new JavaBridgeClient({ javaExecutable: 'java', bridgeJarPath: '/x.jar' });

        const startPromise = client.start();
        await waitFor(() => requests.length >= 1);
        writeJson(proc.stdout, { id: requestId(requests[0]), ok: true });
        await startPromise;

        const pending = client.query('SELECT * FROM T');
        await waitFor(() => requests.length >= 2);
        const cursorId = requestId(requests[1]);
        writeJson(proc.stdout, {
            id: cursorId,
            ok: true,
            kind: 'query',
            columns: [],
            rows: [],
            recordsAffected: -1,
            cursorId,
            hasMore: true,
        });
        await pending.result;

        const closePromise = client.closeCursor(cursorId);
        await waitFor(() => requests.length >= 3);
        expect(requests[2].op).toBe('closeCursor');
        expect(requests[2].cursorId).toBe(cursorId);
        writeJson(proc.stdout, { id: requestId(requests[2]), ok: true });
        await closePromise;

        await closeClient(client, proc, requests);
    });

    it('rejects pending requests when the process exits unexpectedly', async () => {
        const proc = createFakeProcess();
        mockedSpawn.mockReturnValue(proc);
        const requests = collectRequests(proc.stdin);

        const client = new JavaBridgeClient({ javaExecutable: 'java', bridgeJarPath: '/x.jar' });

        const startPromise = client.start();
        await waitFor(() => requests.length >= 1);
        writeJson(proc.stdout, { id: requestId(requests[0]), ok: true });
        await startPromise;

        const pending = client.query('SELECT 1');
        await waitFor(() => requests.length >= 2);

        const exitHandler = proc.once.mock.calls.find(([event]) => event === 'exit')?.[1];
        expect(exitHandler).toBeDefined();
        (exitHandler as (code: number | null, signal: string | null) => void)(1, null);

        await expect(pending.result).rejects.toThrow(/exited unexpectedly/);
    });

    it('fails start() with a helpful message when java is not on PATH', async () => {
        const proc = createFakeProcess();
        mockedSpawn.mockReturnValue(proc);

        const client = new JavaBridgeClient({ javaExecutable: 'java', bridgeJarPath: '/x.jar' });

        const startPromise = client.start();
        const errorHandler = proc.once.mock.calls.find(([event]) => event === 'error')?.[1];
        expect(errorHandler).toBeDefined();
        const errnoError = new Error('spawn java ENOENT');
        (errnoError as NodeJS.ErrnoException).code = 'ENOENT';
        (errorHandler as (error: Error) => void)(errnoError);

        await expect(startPromise).rejects.toThrow(/justybase.access.javaPath/);
    });
});
