import { describe, expect, it } from '@jest/globals';

import { netezzaDialect } from '../../dialects/netezza';
import { buildNetezzaLiveDetails, netezzaLiveEnabled } from './netezzaLiveTestHarness';

const caPath = process.env.NZ_DEV_SSL_CA;
const describeIfLive = netezzaLiveEnabled ? describe : describe.skip;
const describeIfVerify = netezzaLiveEnabled && caPath ? describe : describe.skip;

async function connectWithMode(mode: string, ca?: string) {
    const live = buildNetezzaLiveDetails();
    const connection = netezzaDialect.createConnection({
        host: live.host,
        port: live.port,
        database: live.database,
        user: live.user,
        password: live.password,
        options: {
            netezzaSslMode: mode,
            ...(ca ? { netezzaSslRootCert: ca } : {}),
        },
    });
    await connection.connect();
    return connection;
}

async function queryScalar(connection: ReturnType<typeof netezzaDialect.createConnection>, sql: string) {
    const reader = await connection.createCommand(sql).executeReader();
    try {
        if (await reader.read()) {
            return reader.getValue(0);
        }
        return undefined;
    } finally {
        await reader.close();
    }
}

describeIfLive('Netezza TLS require mode', () => {
    it('connects and runs a query without a CA file', async () => {
        const connection = await connectWithMode('require');
        try {
            expect(await queryScalar(connection, 'select 1 as value')).toBe(1);
        } finally {
            await connection.close().catch(() => undefined);
        }
    }, 120_000);
});

describeIfVerify('Netezza TLS verify-full mode', () => {
    it('connects with the CA certificate and runs a query', async () => {
        const connection = await connectWithMode('verify-full', caPath);
        try {
            expect(await queryScalar(connection, 'select 1 as value')).toBe(1);
        } finally {
            await connection.close().catch(() => undefined);
        }
    }, 120_000);

    it('rejects verify-full without the CA certificate', async () => {
        await expect(connectWithMode('verify-full')).rejects.toThrow();
    }, 120_000);
});
