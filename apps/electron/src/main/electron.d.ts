declare module 'electron' {
  export const app: {
    whenReady(): Promise<void>;
    on(event: string, listener: (...args: unknown[]) => void): void;
    once(event: string, listener: (...args: unknown[]) => void): void;
    quit(): void;
    getPath(name: string): string;
    getName(): string;
    getVersion(): string;
    readonly isPackaged: boolean;
    requestSingleInstanceLock(): boolean;
    setAsDefaultProtocolClient(protocol: string): boolean;
  };
  export class BrowserWindow {
    public constructor(options: Record<string, unknown>);
    public loadURL(url: string): Promise<void>;
    public show(): void;
    public focus(): void;
    public on(event: string, listener: (...args: unknown[]) => void): this;
    public isDestroyed(): boolean;
    public close(): void;
    public webContents: { openDevTools(): void; send(channel: string, message: unknown): void };
    public static getAllWindows(): BrowserWindow[];
    public static getFocusedWindow(): BrowserWindow | null;
  }
  export const contextBridge: { exposeInMainWorld(name: string, value: unknown): void };
  export const ipcRenderer: {
    invoke(channel: string, message: unknown): Promise<unknown>;
    send(channel: string, message: unknown): void;
    on(channel: string, listener: (event: unknown, message: unknown) => void): void;
    removeListener(channel: string, listener: (event: unknown, message: unknown) => void): void;
  };
  export const ipcMain: {
    handle(channel: string, listener: (...args: unknown[]) => void): void;
    removeHandler(channel: string): void;
    on(channel: string, listener: (...args: unknown[]) => void): this;
    removeListener(channel: string, listener: (...args: unknown[]) => void): this;
  };
  export const session: { defaultSession: { cookies: { set(details: { url: string; name: string; value: string; path: string; httpOnly: boolean }): Promise<void> } } };
  export const dialog: {
    showMessageBox(owner: unknown, options: Record<string, unknown>): Promise<{ response: number; checkboxChecked: boolean }>;
  };
  export const crashReporter: { start(options: Record<string, unknown>): void };
  export const autoUpdater: {
    on(event: string, listener: (...args: unknown[]) => void): void;
    setFeedURL(options: { url: string }): void;
    checkForUpdates(): void;
    quitAndInstall(): void;
  };
  export const Menu: {
    buildFromTemplate(template: readonly Record<string, unknown>[]): unknown;
    setApplicationMenu(menu: unknown): void;
  };
}
