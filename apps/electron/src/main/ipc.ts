import { ipcMain } from 'electron';
import type { IpcHandlers } from './ipcProtocol';
import { dispatchIpcMessage } from './ipcProtocol';

export interface IpcRegistration {
  dispose(): void;
}
/** Registers one channel and removes it deterministically on shutdown. */
export function registerIpcHandlers(handlers: IpcHandlers): IpcRegistration {
  const listener = (_event: unknown, message: unknown) => dispatchIpcMessage(message, handlers);
  ipcMain.handle('ui:request', listener);
  let disposed = false;
  return {
    dispose: () => {
      if (disposed) return;
      disposed = true;
      ipcMain.removeHandler('ui:request');
    },
  };
}
