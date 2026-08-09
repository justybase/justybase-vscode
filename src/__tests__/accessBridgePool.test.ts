import { AccessBridgePool } from '../../extensions/access/src/accessBridgePool';
import type { JavaBridgeClient } from '../../extensions/access/src/javaBridgeClient';

interface FakeBridge {
    start: jest.Mock;
    connect: jest.Mock;
    close: jest.Mock;
}

function createBridge(): FakeBridge {
    return {
        start: jest.fn().mockResolvedValue(undefined),
        connect: jest.fn().mockResolvedValue(undefined),
        close: jest.fn().mockResolvedValue(undefined),
    };
}

function options(password = 'secret') {
    return {
        databasePath: '/data/demo.accdb',
        javaExecutable: 'java',
        bridgeJarPath: '/bridge/access-bridge.jar',
        user: 'database-user',
        password,
    };
}

describe('AccessBridgePool', () => {
    it('deduplicates parallel acquisition and keeps the bridge alive until the last lease', async () => {
        const bridge = createBridge();
        const pool = new AccessBridgePool(() => bridge as unknown as JavaBridgeClient);

        const [first, second] = await Promise.all([
            pool.acquire(options()),
            pool.acquire(options()),
        ]);

        expect(first.bridge).toBe(second.bridge);
        expect(bridge.start).toHaveBeenCalledTimes(1);
        expect(bridge.connect).toHaveBeenCalledTimes(1);

        await first.release();
        expect(bridge.close).not.toHaveBeenCalled();

        await second.release();
        expect(bridge.close).toHaveBeenCalledTimes(1);
    });

    it('does not share bridges across files or authentication data', async () => {
        const bridges = [createBridge(), createBridge(), createBridge()];
        const pool = new AccessBridgePool(() => bridges.shift() as unknown as JavaBridgeClient);

        const first = await pool.acquire(options());
        const otherFile = await pool.acquire({ ...options(), databasePath: '/data/other.accdb' });
        const otherPassword = await pool.acquire(options('different-secret'));

        expect(new Set([first.bridge, otherFile.bridge, otherPassword.bridge]).size).toBe(3);
        await Promise.all([first.release(), otherFile.release(), otherPassword.release()]);
        expect(bridges).toHaveLength(0);
    });

    it('does not share read-only and write-enabled bridge processes', async () => {
        const bridges = [createBridge(), createBridge()];
        const pool = new AccessBridgePool(() => bridges.shift() as unknown as JavaBridgeClient);

        const readOnly = await pool.acquire(options());
        const writeEnabled = await pool.acquire({ ...options(), readOnly: false });

        expect(readOnly.bridge).not.toBe(writeEnabled.bridge);
        expect((readOnly.bridge.connect as jest.Mock)).toHaveBeenNthCalledWith(1, '/data/demo.accdb', {
            password: 'secret',
            readOnly: true,
        });
        expect((writeEnabled.bridge.connect as jest.Mock)).toHaveBeenNthCalledWith(1, '/data/demo.accdb', {
            password: 'secret',
            readOnly: false,
        });
        await Promise.all([readOnly.release(), writeEnabled.release()]);
    });

    it('removes a failed entry so a later acquisition can retry', async () => {
        const failed = createBridge();
        failed.connect.mockRejectedValueOnce(new Error('authentication failed'));
        const replacement = createBridge();
        const factory = jest.fn()
            .mockReturnValueOnce(failed as unknown as JavaBridgeClient)
            .mockReturnValueOnce(replacement as unknown as JavaBridgeClient);
        const pool = new AccessBridgePool(factory);

        await expect(pool.acquire(options())).rejects.toThrow('authentication failed');
        const lease = await pool.acquire(options());

        expect(factory).toHaveBeenCalledTimes(2);
        expect(failed.close).toHaveBeenCalledTimes(1);
        expect(lease.bridge).toBe(replacement);
        await lease.release();
    });

    it('does not close a shared bridge when one lease is released twice', async () => {
        const bridge = createBridge();
        const pool = new AccessBridgePool(() => bridge as unknown as JavaBridgeClient);

        const first = await pool.acquire(options());
        const second = await pool.acquire(options());

        await first.release();
        await first.release();
        expect(bridge.close).not.toHaveBeenCalled();

        await second.release();
        expect(bridge.close).toHaveBeenCalledTimes(1);
    });

    it('keeps an active lease alive while another shared lease is released', async () => {
        const bridge = createBridge();
        const pool = new AccessBridgePool(() => bridge as unknown as JavaBridgeClient);
        const active = await pool.acquire(options());
        const temporary = await pool.acquire(options());

        await temporary.release();
        expect(bridge.close).not.toHaveBeenCalled();

        await active.release();
        expect(bridge.close).toHaveBeenCalledTimes(1);
    });
});
