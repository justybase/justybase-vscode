describe('result panel protocol', () => {
    beforeEach(() => {
        jest.resetModules();
        delete (global as typeof globalThis & { acquireVsCodeApi?: unknown }).acquireVsCodeApi;
    });

    it('falls back when acquireVsCodeApi throws during module initialization', () => {
        (global as typeof globalThis & { acquireVsCodeApi?: () => never }).acquireVsCodeApi = () => {
            throw new Error('boom');
        };

        const protocol: {
            getHostState: () => unknown;
            setHostState: (state: unknown) => void;
            postHostMessage: (message: { command: string }) => void;
        } = require('../../media/resultPanel/protocol.js');

        expect(protocol.getHostState()).toBeUndefined();
        expect(() => protocol.setHostState({ activeSource: 'file:///demo.sql' })).not.toThrow();
        expect(() => protocol.postHostMessage({ command: 'ready' })).not.toThrow();
    });

    it('rejects unknown and malformed host messages before they reach handlers', () => {
        const protocol: {
            asHostMessage: (message: unknown) => unknown;
        } = require('../../media/resultPanel/protocol.js');

        expect(protocol.asHostMessage({ command: 'executeSql', sql: 'SELECT 1' })).toBeUndefined();
        expect(protocol.asHostMessage({ command: 'appendRows', resultSetIndex: 0 })).toBeUndefined();
        expect(protocol.asHostMessage({ command: 'switchToResultSet', resultSetIndex: -1 })).toBeUndefined();
        expect(protocol.asHostMessage({ command: 'switchToResultSet', resultSetIndex: 1 })).toEqual({
            command: 'switchToResultSet',
            resultSetIndex: 1,
        });
    });

    it('validates webview messages at the shared host boundary', () => {
        const runtime: {
            parseResultPanelWebviewMessage: (message: unknown) => unknown;
        } = require('../contracts/webviews/resultPanelRuntime');

        expect(runtime.parseResultPanelWebviewMessage({ command: 'closeSource' })).toBeUndefined();
        expect(runtime.parseResultPanelWebviewMessage({ command: 'unknown' })).toBeUndefined();
        expect(runtime.parseResultPanelWebviewMessage({
            command: 'requestResultSync',
            sourceUri: 'untitled:demo',
            reason: 'missing-shell',
        })).toEqual({
            command: 'requestResultSync',
            sourceUri: 'untitled:demo',
            reason: 'missing-shell',
        });
    });
});
