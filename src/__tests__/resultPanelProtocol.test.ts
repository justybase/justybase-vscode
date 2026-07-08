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
});