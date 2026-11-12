import * as vscode from 'vscode';

export interface CopilotPromptPreviewOptions {
    /** Human-readable operation name shown as the preview heading. */
    operation: string;
    /** The exact prompt the user can copy into their Copilot Chat thread. */
    prompt: string;
    /** Short, user-facing summary of the sections contained in the prompt. */
    items: readonly string[];
}

export type CopilotPromptPreviewResult = 'copied' | 'closed';

let activePreviewClose: (() => void) | undefined;

/**
 * Shows the exact prompt an AI action prepared. The extension never hands the
 * prompt to Copilot or any other service: the user copies it and pastes it
 * into their own chat thread. Closing the preview reports `closed`; pressing
 * Copy reports `copied` and closes the panel.
 */
export async function showCopilotPromptPreview(
    options: CopilotPromptPreviewOptions,
): Promise<CopilotPromptPreviewResult> {
    // Only one preview at a time: a repeated request closes the previous one.
    activePreviewClose?.();

    return await new Promise<CopilotPromptPreviewResult>((resolve) => {
        const panel = vscode.window.createWebviewPanel(
            'justybase.copilotPromptPreview',
            'Copilot prompt preview',
            { viewColumn: vscode.ViewColumn.Beside, preserveFocus: false },
            { enableScripts: true, retainContextWhenHidden: true },
        );

        let settled = false;
        const finish = (result: CopilotPromptPreviewResult): void => {
            if (settled) {
                return;
            }
            settled = true;
            activePreviewClose = undefined;
            panel.dispose();
            resolve(result);
        };

        activePreviewClose = () => finish('closed');
        panel.webview.html = getCopilotPromptPreviewHtml(
            options,
            createNonce(),
            panel.webview.cspSource,
        );

        panel.webview.onDidReceiveMessage((message: unknown) => {
            if (!message || typeof message !== 'object') {
                return;
            }
            const type = (message as { type?: unknown }).type;
            if (type === 'copied') {
                finish('copied');
                return;
            }
            if (type === 'close') {
                finish('closed');
            }
        });

        panel.onDidDispose(() => {
            if (settled) {
                return;
            }
            settled = true;
            activePreviewClose = undefined;
            resolve('closed');
        });
    });
}

export function getCopilotPromptPreviewHtml(
    options: CopilotPromptPreviewOptions,
    nonce: string,
    cspSource: string,
): string {
    const operation = escapeHtml(options.operation);
    const items = options.items.map(item => `<li>${escapeHtml(item)}</li>`).join('');
    const prompt = escapeHtml(options.prompt);
    const size = options.prompt.length.toLocaleString('en-US');

    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
<title>Copilot prompt preview</title>
<style>
  :root {
    --border: var(--vscode-widget-border, var(--vscode-panel-border, rgba(128, 128, 128, .35)));
    --muted: var(--vscode-descriptionForeground);
    --surface: var(--vscode-editorWidget-background, var(--vscode-editor-background));
    --accent: var(--vscode-textLink-foreground, var(--vscode-focusBorder));
  }
  * { box-sizing: border-box; }
  html, body { height: 100%; }
  body {
    margin: 0;
    color: var(--vscode-foreground);
    background: var(--vscode-editor-background);
    font-family: var(--vscode-font-family);
    font-size: 13px;
    line-height: 1.5;
    -webkit-font-smoothing: antialiased;
  }
  .shell {
    display: flex;
    flex-direction: column;
    gap: 14px;
    height: 100%;
    padding: 20px 22px 16px;
  }
  .eyebrow {
    color: var(--muted);
    font-size: 10.5px;
    font-weight: 700;
    letter-spacing: .08em;
    text-transform: uppercase;
  }
  h1 { margin: 2px 0 0; font-size: 19px; font-weight: 600; letter-spacing: -.01em; }
  .lede { margin: 6px 0 0; max-width: 78ch; color: var(--muted); font-size: 12.5px; }
  .notice {
    margin: 0;
    padding: 8px 11px;
    border: 1px solid var(--border);
    border-left: 3px solid var(--vscode-editorWarning-foreground, var(--accent));
    border-radius: 6px;
    background: var(--surface);
    font-size: 12px;
  }
  .panel {
    display: flex;
    flex-direction: column;
    min-height: 0;
    flex: 1 1 auto;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--surface);
    overflow: hidden;
  }
  .panel-head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 12px;
    padding: 10px 12px;
    border-bottom: 1px solid var(--border);
  }
  .panel-head h2 { margin: 0; font-size: 11px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; color: var(--muted); }
  .size { color: var(--muted); font-size: 11px; font-variant-numeric: tabular-nums; }
  .items { margin: 8px 12px 0; padding: 0 0 0 18px; color: var(--muted); font-size: 11.5px; }
  pre {
    flex: 1 1 auto;
    min-height: 180px;
    margin: 10px 12px 12px;
    padding: 10px 12px;
    overflow: auto;
    border-radius: 6px;
    background: var(--vscode-textCodeBlock-background);
    color: var(--vscode-foreground);
    font-family: var(--vscode-editor-font-family);
    font-size: 12px;
    line-height: 1.55;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    tab-size: 4;
  }
  pre:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 2px; }
  .footer {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 10px 16px;
  }
  .footer-note { color: var(--muted); font-size: 11.5px; }
  .actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-left: auto; }
  button {
    font-family: inherit;
    font-size: 12px;
    border-radius: 4px;
    cursor: pointer;
    padding: 5px 12px;
    border: 1px solid transparent;
  }
  button:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 2px; }
  .primary {
    color: var(--vscode-button-foreground);
    background: var(--vscode-button-background);
    border-color: var(--vscode-button-border, transparent);
    font-weight: 500;
  }
  .primary:hover { background: var(--vscode-button-hoverBackground); }
  .secondary {
    color: var(--vscode-button-secondaryForeground);
    background: var(--vscode-button-secondaryBackground);
  }
  .secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
  .copy-status { color: var(--muted); font-size: 11.5px; }
</style>
</head>
<body>
<div class="shell">
  <header>
    <div class="eyebrow">Copilot prompt</div>
    <h1>${operation}</h1>
    <p class="lede">JustyBase does not send this prompt anywhere. Copy it and paste it into your own Copilot Chat thread — you decide when and where it is shared.</p>
  </header>
  <p class="notice">The payload can contain SQL, error text, object names and table DDL. Review it before pasting; Copilot’s own retention, model and organization policies still apply.</p>
  <section class="panel" aria-label="Prompt to copy">
    <div class="panel-head">
      <h2>Payload</h2>
      <span class="size">${size} characters</span>
    </div>
    <ul class="items">${items}</ul>
    <pre id="prompt" tabindex="0">${prompt}</pre>
  </section>
  <footer class="footer">
    <span class="footer-note" id="copy-status" role="status" aria-live="polite">Nothing is transmitted by this action.</span>
    <div class="actions">
      <button type="button" class="secondary" id="close">Close</button>
      <button type="button" class="primary" id="copy">Copy prompt</button>
    </div>
  </footer>
</div>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const prompt = document.getElementById('prompt');
  const copyStatus = document.getElementById('copy-status');
  const reportCopied = () => vscode.postMessage({ type: 'copied' });
  const reportFailure = () => {
    copyStatus.textContent = 'Copy failed - select the text and copy it manually.';
  };
  document.getElementById('copy').addEventListener('click', () => {
    const text = prompt.textContent || '';
    const fallbackCopy = () => {
      const area = document.createElement('textarea');
      area.value = text;
      area.style.position = 'fixed';
      area.style.opacity = '0';
      document.body.appendChild(area);
      area.select();
      const copied = document.execCommand('copy');
      area.remove();
      if (copied) {
        reportCopied();
      } else {
        reportFailure();
      }
    };
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      navigator.clipboard.writeText(text).then(reportCopied, fallbackCopy);
      return;
    }
    fallbackCopy();
  });
  document.getElementById('close').addEventListener('click', () => {
    vscode.postMessage({ type: 'close' });
  });
</script>
</body>
</html>`;
}

function escapeHtml(value: string): string {
    return value.replace(/[&<>"']/g, char => {
        switch (char) {
            case '&': return '&amp;';
            case '<': return '&lt;';
            case '>': return '&gt;';
            case '"': return '&quot;';
            default: return '&#39;';
        }
    });
}

function createNonce(): string {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let nonce = '';
    for (let index = 0; index < 32; index += 1) {
        nonce += alphabet.charAt(Math.floor(Math.random() * alphabet.length));
    }
    return nonce;
}
