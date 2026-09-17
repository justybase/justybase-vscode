import { contextBridge, ipcRenderer } from 'electron';
import { createPreloadBridge } from './bridge';
import { MENU_ACTION_CHANNEL, createMenuActionSubscription } from './menuActions';

contextBridge.exposeInMainWorld('justybaseElectron', createPreloadBridge(message => ipcRenderer.invoke('ui:request', message)));
contextBridge.exposeInMainWorld(
  'justybaseMenu',
  createMenuActionSubscription((channel, listener) => {
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  }),
);

export { MENU_ACTION_CHANNEL };
