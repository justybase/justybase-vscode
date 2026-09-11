import { contextBridge, ipcRenderer } from 'electron';
import { createPreloadBridge } from './bridge';

contextBridge.exposeInMainWorld('justybaseElectron', createPreloadBridge(message => ipcRenderer.invoke('ui:request', message)));
