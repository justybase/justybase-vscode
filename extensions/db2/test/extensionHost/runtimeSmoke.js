const assert = require('node:assert/strict');

async function queryLiveDb2(Db2DatabaseConnection) {
    if (process.env.DB2_VSCODE_RUNTIME_LIVE !== 'true') {
        return Promise.resolve();
    }

    const required = [
        'DB2_LIVE_TEST_HOST',
        'DB2_LIVE_TEST_DATABASE',
        'DB2_LIVE_TEST_USER',
        'DB2_LIVE_TEST_PASSWORD',
    ];
    const missing = required.filter(name => !process.env[name]);
    if (missing.length > 0) {
        return Promise.reject(
            new Error(`DB2_VSCODE_RUNTIME_LIVE=true requires: ${missing.join(', ')}`),
        );
    }

    const port = process.env.DB2_LIVE_TEST_PORT || '50000';
    const options = {};
    for (const [environmentName, optionName] of [
        ['DB2_LIVE_TEST_CURRENT_SCHEMA', 'currentSchema'],
        ['DB2_LIVE_TEST_SECURITY', 'security'],
        ['DB2_LIVE_TEST_SSL_SERVER_CERTIFICATE', 'sslServerCertificate'],
    ]) {
        if (process.env[environmentName]) options[optionName] = process.env[environmentName];
    }
    if (process.env.DB2_LIVE_TEST_CONNECT_TIMEOUT) {
        options.connectTimeout = Number(process.env.DB2_LIVE_TEST_CONNECT_TIMEOUT);
    }

    const connection = new Db2DatabaseConnection({
        host: process.env.DB2_LIVE_TEST_HOST,
        port: Number(port),
        database: process.env.DB2_LIVE_TEST_DATABASE,
        user: process.env.DB2_LIVE_TEST_USER,
        password: process.env.DB2_LIVE_TEST_PASSWORD,
        options,
    });
    try {
        await connection.connect();
        const reader = await connection.createCommand('SELECT 1 AS VALUE FROM SYSIBM.SYSDUMMY1').executeReader();
        try {
            assert.equal(await reader.read(), true);
            assert.equal(Number(reader.getValue(0)), 1);
            assert.equal(await reader.read(), false);
        } finally {
            await reader.close();
        }
    } finally {
        await connection.close();
    }
}

async function run() {
    const { Db2DatabaseConnection } = require('@justybase/db2/compat');
    assert.equal(typeof Db2DatabaseConnection, 'function', 'Db2DatabaseConnection export must load.');
    assert.equal(typeof Db2DatabaseConnection.prototype.createCommand, 'function');
    await queryLiveDb2(Db2DatabaseConnection);
    console.log('Db2 TypeScript driver Extension Host smoke test passed.');
}

module.exports = { run };
