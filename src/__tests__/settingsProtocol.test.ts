import { isSettingsWebviewMessage } from '../views/settingsProtocol';

describe('settings webview protocol', () => {
    it('accepts supported setting and action messages', () => {
        expect(isSettingsWebviewMessage({ command: 'getSettings' })).toBe(true);
        expect(isSettingsWebviewMessage({
            command: 'updateSetting',
            key: 'query.rowLimit',
            value: 1000
        })).toBe(true);
        expect(isSettingsWebviewMessage({
            command: 'createSnippet',
            value: { label: 'daily', sql: 'select 1' }
        })).toBe(true);
    });

    it('rejects malformed or unknown messages before they reach command handling', () => {
        expect(isSettingsWebviewMessage({ command: 'updateSetting', key: 42, value: true })).toBe(false);
        expect(isSettingsWebviewMessage({ command: 'createSnippet', value: { label: 'daily' } })).toBe(false);
        expect(isSettingsWebviewMessage({ command: 'runArbitraryCommand' })).toBe(false);
        expect(isSettingsWebviewMessage(null)).toBe(false);
    });
});
