import { randomBytes } from 'node:crypto';
import { BrowserWindow, ipcMain } from 'electron';
import { CREDENTIAL_PROMPT_CHANNEL } from '../credentialPromptProtocol';
import type { CredentialProvider } from './credentialBroker';

interface CredentialPromptMessage {
  readonly requestId?: unknown;
  readonly value?: unknown;
  readonly cancelled?: unknown;
}

interface PendingPrompt {
  readonly requestId: string;
  readonly resolve: (value: string | undefined) => void;
}

export interface NativeCredentialProviderOptions {
  readonly owner?: () => BrowserWindow | undefined;
  readonly preloadPath: string;
}

export interface NativeCredentialProvider extends CredentialProvider {
  dispose(): void;
}

function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

function randomRequestId(): string {
  return randomBytes(18).toString('base64url');
}

function promptHtml(requestId: string, purpose: 'login' | 'connection'): string {
  const title = purpose === 'login' ? 'Sign in to JustyBase' : 'Database credentials';
  const description = purpose === 'login' ? 'Enter the password for the local workspace.' : 'Enter the password for this database connection.';
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title>
<style>
:root { color-scheme: dark; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #1e1e1e; color: #d4d4d4; }
* { box-sizing: border-box; }
body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #1e1e1e; }
main { width: min(100% - 32px, 420px); padding: 24px; border: 1px solid #3c3c3c; border-radius: 6px; background: #252526; box-shadow: 0 12px 32px rgb(0 0 0 / 35%); }
h1 { margin: 0 0 8px; color: #f3f3f3; font-size: 16px; font-weight: 600; }
p { margin: 0 0 18px; color: #a7a7a7; font-size: 12px; line-height: 1.45; }
label { display: grid; gap: 6px; color: #cccccc; font-size: 12px; }
input { width: 100%; min-height: 32px; padding: 6px 8px; border: 1px solid #3f3f46; border-radius: 3px; color: #f3f3f3; background: #1f1f1f; font: inherit; }
input:focus { border-color: #007fd4; outline: 1px solid #007fd4; }
.actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 20px; }
button { min-height: 30px; padding: 5px 14px; border: 1px solid #3f3f46; border-radius: 3px; color: #f3f3f3; background: #313131; font: inherit; cursor: pointer; }
button.primary { border-color: #0e639c; background: #0e639c; }
button:hover { filter: brightness(1.15); }
</style></head><body data-request-id="${escapeHtml(requestId)}"><main>
<h1>${escapeHtml(title)}</h1><p>${escapeHtml(description)}</p>
<form id="credential-form"><label for="credential-value">Password<input id="credential-value" type="password" autocomplete="current-password" autofocus></label>
<div class="actions"><button id="cancel" type="button">Cancel</button><button class="primary" type="submit">Continue</button></div></form>
</main><script>
const requestId = document.body.dataset.requestId || '';
const input = document.getElementById('credential-value');
const submit = (value, cancelled) => window.justybaseCredentialPrompt.submit(requestId, value, cancelled);
document.getElementById('credential-form').addEventListener('submit', event => { event.preventDefault(); submit(input.value, false); });
document.getElementById('cancel').addEventListener('click', () => submit('', true));
</script></body></html>`;
}

function validMessage(value: unknown): value is CredentialPromptMessage {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Main-only password prompt. The application renderer receives no secret. */
export function createNativeCredentialProvider(options: NativeCredentialProviderOptions): NativeCredentialProvider {
  let prompt: BrowserWindow | undefined;
  let pending: PendingPrompt | undefined;

  const finish = (value: string | undefined): void => {
    const current = pending;
    const currentWindow = prompt;
    pending = undefined;
    prompt = undefined;
    if (currentWindow && !currentWindow.isDestroyed()) currentWindow.close();
    current?.resolve(value);
  };

  const onMessage = (_event: unknown, value: unknown): void => {
    if (!pending || !validMessage(value)) return;
    if (value.requestId !== pending.requestId) return;
    if (value.cancelled === true) {
      finish(undefined);
      return;
    }
    if (typeof value.value !== 'string') return;
    finish(value.value || undefined);
  };
  ipcMain.on(CREDENTIAL_PROMPT_CHANNEL, onMessage);

  const provider: NativeCredentialProvider = {
    request: async purpose => {
      if (pending) throw new Error('AUTH_CREDENTIAL_PROMPT_OPEN');
      const requestId = randomRequestId();
      return new Promise<string | undefined>(resolve => {
        pending = { requestId, resolve };
        const owner = options.owner?.();
        const child = new BrowserWindow({
          width: 460,
          height: 260,
          minWidth: 380,
          minHeight: 230,
          show: false,
          parent: owner && !owner.isDestroyed() ? owner : undefined,
          modal: Boolean(owner && !owner.isDestroyed()),
          title: purpose === 'login' ? 'JustyBase sign in' : 'Database credentials',
          webPreferences: {
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
            preload: options.preloadPath,
          },
        });
        prompt = child;
        child.on('ready-to-show', () => {
          if (prompt === child && !child.isDestroyed()) child.show();
        });
        child.on('closed', () => {
          if (pending?.requestId === requestId) finish(undefined);
        });
        void child.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(promptHtml(requestId, purpose))}`).catch(() => {
          if (pending?.requestId === requestId) finish(undefined);
        });
      });
    },
    dispose: () => {
      finish(undefined);
      ipcMain.removeListener(CREDENTIAL_PROMPT_CHANNEL, onMessage);
    },
  };
  return provider;
}
