/** Messages exchanged between the settings webview and the extension host. */

export type SettingsWebviewMessage =
    | { command: 'updateSetting'; key: string; value: unknown }
    | { command: 'resetSetting'; key: string }
    | { command: 'resetSection'; key: string }
    | { command: 'getSettings' }
    | { command: 'testPrompt'; key: string; value: string }
    | { command: 'openVSCodeSettings' | 'clearAutocompleteCache' | 'openConnection' | 'refreshSchema' | 'openSettings' | 'showMetadataStats' | 'openSnippetsFile' | 'getSnippets' }
    | { command: 'createSnippet'; value: { label: string; sql: string } }
    | { command: 'updateSnippet'; value: { id: string; label: string; sql: string } }
    | { command: 'deleteSnippet'; value: string };

export type SettingsHostMessage =
    | { command: 'settingsData'; data: Record<string, unknown> }
    | { command: 'settingUpdated'; key: string; value?: unknown; success: boolean; error?: string }
    | { command: 'settingReset'; key: string }
    | { command: 'sectionReset'; sectionId: string; count: number }
    | { command: 'operationFailed'; error: string }
    | { command: 'snippetsData'; userSnippets: unknown[]; predefined: unknown[] }
    | { command: 'snippetCreated'; success: boolean; error?: string }
    | { command: 'snippetUpdated'; success: boolean; id: string; error?: string }
    | { command: 'snippetDeleted'; success: boolean; id: string; error?: string }
    | { command: 'testPromptResult'; promptType: string; status: 'success' | 'error'; result?: string; error?: string };

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

/** Runtime boundary check: webview messages are untrusted input. */
export function isSettingsWebviewMessage(value: unknown): value is SettingsWebviewMessage {
    if (!isRecord(value) || typeof value.command !== 'string') return false;

    switch (value.command) {
        case 'updateSetting':
            return typeof value.key === 'string' && 'value' in value;
        case 'resetSetting':
        case 'resetSection':
            return typeof value.key === 'string';
        case 'testPrompt':
            return typeof value.key === 'string' && typeof value.value === 'string';
        case 'createSnippet': {
            const snippet = value.value;
            return isRecord(snippet) && typeof snippet.label === 'string' && typeof snippet.sql === 'string';
        }
        case 'updateSnippet': {
            const snippet = value.value;
            return isRecord(snippet) && typeof snippet.id === 'string'
                && typeof snippet.label === 'string' && typeof snippet.sql === 'string';
        }
        case 'deleteSnippet':
            return typeof value.value === 'string';
        case 'getSettings':
        case 'openVSCodeSettings':
        case 'clearAutocompleteCache':
        case 'openConnection':
        case 'refreshSchema':
        case 'openSettings':
        case 'showMetadataStats':
        case 'openSnippetsFile':
        case 'getSnippets':
            return true;
        default:
            return false;
    }
}
