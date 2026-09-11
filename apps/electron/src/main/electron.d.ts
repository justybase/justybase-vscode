declare module 'electron' {
  export const app: {
    whenReady(): Promise<void>;
    on(event: string, listener: (...args: unknown[]) => void): void;
    once(event: string, listener: (...args: unknown[]) => void): void;
    quit(): void;
    getPath(name: string): string;
  };
  export class BrowserWindow {
    public constructor(options: Record<string, unknown>);
    public loadURL(url: string): Promise<void>;
    public on(event: string, listener: (...args: unknown[]) => void): this;
    public isDestroyed(): boolean;
    public close(): void;
    public webContents: { openDevTools(): void };
  }
  export const contextBridge: { exposeInMainWorld(name: string, value: unknown): void };
  export const ipcRenderer: { invoke(channel: string, message: unknown): Promise<unknown> };
  export const ipcMain: {
    handle(channel: string, listener: (...args: unknown[]) => unknown): void;
    removeHandler(channel: string): void;
  };
  export const session: { defaultSession: { cookies: { set(details: { url: string; name: string; value: string; path: string; httpOnly: boolean }): Promise<void> } } };
}
