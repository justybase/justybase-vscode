// Keep host and webview command validation under the same UI coverage gate.
import '../../src/__tests__/resultPanelProtocol.test';

import { asHostMessage, asWebviewMessage } from '../resultPanel/protocol.js';

it('validates Explore requests, cancellations and replies in the webview protocol', () => {
    const request = { command: 'requestExploreOperation', sourceUri: 'file:///a.sql', resultSetIndex: 0, requestId: 1, operation: { kind: 'rows' } };
    expect(asWebviewMessage(request)).toEqual(request);
    for (const patch of [{ sourceUri: '' }, { resultSetIndex: -1 }, { requestId: -1 }, { operation: null }]) {
        expect(asWebviewMessage({ ...request, ...patch })).toBeUndefined();
    }
    expect(asWebviewMessage({ command: 'cancelExploreOperation', requestId: 1 })).toBeDefined();
    expect(asWebviewMessage({ command: 'cancelExploreOperation', requestId: -1 })).toBeUndefined();
    expect(asHostMessage({ command: 'exploreOperationResult', requestId: 1 })).toBeDefined();
    expect(asHostMessage({ command: 'exploreOperationResult', requestId: -1 })).toBeUndefined();
});
