import { createPreloadBridge } from '../src/preload/bridge';
import type { IpcInvoker } from '../src/preload/bridge';

describe('Electron SQL file preload bridge', () => {
  it('opens a file and maps cancellation to null', async () => {
    const file = { filePath: '/tmp/report.sql', fileName: 'report.sql', content: 'SELECT 1;', sizeBytes: 9, oversize: false };
    const invoke: IpcInvoker = jest.fn(async () => ({ ok: true, file }));
    await expect(createPreloadBridge(invoke).openSqlFile()).resolves.toEqual(file);
    expect(invoke).toHaveBeenCalledWith({ method: 'filesystem/open-sql' });

    const cancelled: IpcInvoker = jest.fn(async () => ({ ok: true, file: null }));
    await expect(createPreloadBridge(cancelled).openSqlFile()).resolves.toBeNull();
  });

  it('saves with the validated channel and payload', async () => {
    const saved = { filePath: '/tmp/report.sql', fileName: 'report.sql', sizeBytes: 9 };
    const invoke: IpcInvoker = jest.fn(async () => ({ ok: true, saved }));
    await expect(createPreloadBridge(invoke).saveSqlFile('/tmp/report.sql', 'SELECT 1;')).resolves.toEqual(saved);
    expect(invoke).toHaveBeenCalledWith({ method: 'filesystem/save-sql', payload: { filePath: '/tmp/report.sql', content: 'SELECT 1;' } });

    const cancelled: IpcInvoker = jest.fn(async () => ({ ok: true, saved: null }));
    await expect(createPreloadBridge(cancelled).saveSqlFileAs('report.sql', 'SELECT 1;')).resolves.toBeNull();
  });

  it('rejects malformed main responses', async () => {
    const malformed: IpcInvoker = jest.fn(async () => ({ ok: true, file: { filePath: 42 } }));
    await expect(createPreloadBridge(malformed).openSqlFile()).rejects.toThrow('Malformed SQL file');

    const failed: IpcInvoker = jest.fn(async () => ({ ok: false, code: 'IPC_OPERATION_FAILED', message: 'nope' }));
    await expect(createPreloadBridge(failed).saveSqlFile('/tmp/report.sql', 'x')).rejects.toThrow('nope');
  });
});
