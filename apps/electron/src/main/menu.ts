import type { BrowserWindow, MenuItemConstructorOptions } from 'electron';

/** Main-process menu actions; the focused window is routed at click time. */
export interface ProductMenuActions {
  readonly newWindow: () => void;
  readonly openFile: (window: BrowserWindow | null) => void;
  readonly saveFile: (window: BrowserWindow | null) => void;
  readonly saveFileAs: (window: BrowserWindow | null) => void;
}

export interface ProductMenuOptions {
  readonly appName: string;
  readonly platform: NodeJS.Platform;
  readonly isDev: boolean;
  readonly actions: ProductMenuActions;
}

function asBrowserWindow(window: unknown): BrowserWindow | null {
  return window instanceof Object && 'webContents' in (window as Record<string, unknown>) ? (window as BrowserWindow) : null;
}

function fileMenu(actions: ProductMenuActions): MenuItemConstructorOptions {
  return {
    label: 'File',
    submenu: [
      { label: 'New Window', accelerator: 'CmdOrCtrl+N', click: () => actions.newWindow() },
      { type: 'separator' },
      {
        label: 'Open SQL File…',
        accelerator: 'CmdOrCtrl+O',
        click: (_item, focusedWindow) => actions.openFile(asBrowserWindow(focusedWindow)),
      },
      {
        label: 'Save',
        accelerator: 'CmdOrCtrl+S',
        click: (_item, focusedWindow) => actions.saveFile(asBrowserWindow(focusedWindow)),
      },
      {
        label: 'Save As…',
        accelerator: 'CmdOrCtrl+Shift+S',
        click: (_item, focusedWindow) => actions.saveFileAs(asBrowserWindow(focusedWindow)),
      },
      { type: 'separator' },
      { role: 'close' },
    ],
  };
}

/**
 * Builds the product application menu as pure data. File actions are pushed
 * to the focused renderer through the validated menu-action channel, so the
 * menu owns no document state; roles own clipboard/window behaviour.
 */
export function buildAppMenuTemplate(options: ProductMenuOptions): MenuItemConstructorOptions[] {
  const template: MenuItemConstructorOptions[] = [];
  if (options.platform === 'darwin') {
    template.push({
      label: options.appName,
      submenu: [{ role: 'about' }, { type: 'separator' }, { role: 'services' }, { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }, { role: 'quit' }],
    });
  }
  template.push(fileMenu(options.actions));
  template.push({ label: 'Edit', submenu: [{ role: 'editMenu' }] });
  if (options.isDev) {
    template.push({
      label: 'View',
      submenu: [{ role: 'reload' }, { role: 'forceReload' }, { role: 'toggleDevTools' }, { type: 'separator' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'togglefullscreen' }],
    });
  } else {
    template.push({
      label: 'View',
      submenu: [{ role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'togglefullscreen' }],
    });
  }
  template.push({ label: 'Window', submenu: [{ role: 'windowMenu' }] });
  return template;
}
