import { asHostMessage, asWebviewMessage } from '../protocol';
test('queue protocol accepts only bounded actions and valid request identities', () => {
    expect(asHostMessage({command:'sqlQueueState',lanesJson:'[]'})).toBeDefined();
    expect(asHostMessage({command:'sqlQueueState',lanesJson:5})).toBeUndefined();
    for(const action of ['pause','resume','clear','cancel','remove']) {
        expect(asWebviewMessage({command:'sqlQueueAction',sourceKey:'lane',action})).toBeDefined();
        expect(asWebviewMessage({command:'sqlQueueAction',sourceKey:'lane',action,jobId:'job'})).toBeDefined();
    }
    expect(asWebviewMessage({command:'sqlQueueAction',sourceKey:'lane',action:'drop'})).toBeUndefined();
    expect(asWebviewMessage({command:'sqlQueueAction',sourceKey:'',action:'pause'})).toBeUndefined();
    expect(asWebviewMessage({command:'sqlQueueAction',sourceKey:'lane',action:'pause',jobId:5})).toBeUndefined();
});
