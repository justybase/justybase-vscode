import { describe, expect, it } from '@jest/globals';

import {
    createNetezzaLiveConnection,
    currentNetezzaSessionId,
    executeNetezza,
    netezzaLiveEnabled,
    readScalar,
} from './netezzaLiveTestHarness';

const sessionKillEnabled = netezzaLiveEnabled && process.env.NZ_DEV_ALLOW_SESSION_KILL === '1';
const describeIfSessionKill = sessionKillEnabled ? describe : describe.skip;

describeIfSessionKill('Netezza SqlDotnet DROP SESSION compatibility', () => {
    it('drops only a disposable victim session from a SqlDotnet control connection', async () => {
        const control = createNetezzaLiveConnection();
        const victim = createNetezzaLiveConnection();
        await control.connect();
        await victim.connect();

        try {
            const victimSessionId = await currentNetezzaSessionId(victim);
            await executeNetezza(control, `DROP SESSION ${victimSessionId}`);
            await expect(readScalar(victim, 'SELECT 42')).rejects.toThrow();
        } finally {
            await victim.close().catch(() => undefined);
            await control.close().catch(() => undefined);
        }
    }, 120_000);
});
