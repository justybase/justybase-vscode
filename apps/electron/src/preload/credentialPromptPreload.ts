import { contextBridge, ipcRenderer } from 'electron';
import { CREDENTIAL_PROMPT_CHANNEL } from '../credentialPromptProtocol';

contextBridge.exposeInMainWorld('justybaseCredentialPrompt', Object.freeze({
  submit: (requestId: string, value: string, cancelled: boolean): void => {
    if (typeof requestId !== 'string' || requestId.length === 0 || typeof value !== 'string' || typeof cancelled !== 'boolean') return;
    ipcRenderer.send(CREDENTIAL_PROMPT_CHANNEL, { requestId, value, cancelled });
  },
}));
