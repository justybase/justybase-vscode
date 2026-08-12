const assert = require('node:assert/strict');
const path = require('node:path');

const REQUIRED_NAPI_VERSION = 8;

function prependEnvironmentPath(name, value) {
    const values = (process.env[name] || '').split(path.delimiter).filter(Boolean);
    if (!values.includes(value)) {
        process.env[name] = [value, ...values].join(path.delimiter);
    }
}

function configureBundledCliDriver(db2ExtensionRoot) {
    const cliDriverHome = path.join(db2ExtensionRoot, 'node_modules', 'ibm_db', 'installer', 'clidriver');
    process.env.IBM_DB_HOME = cliDriverHome;
    prependEnvironmentPath('PATH', path.join(cliDriverHome, 'bin'));
    prependEnvironmentPath('PATH', path.join(cliDriverHome, 'lib'));

    if (process.platform === 'linux') {
        prependEnvironmentPath('LD_LIBRARY_PATH', path.join(cliDriverHome, 'lib'));
    } else if (process.platform === 'darwin') {
        prependEnvironmentPath('DYLD_LIBRARY_PATH', path.join(cliDriverHome, 'lib'));
    }
}

function queryLiveDb2(ibmDb) {
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
    const connectionString = [
        `DATABASE=${process.env.DB2_LIVE_TEST_DATABASE}`,
        `HOSTNAME=${process.env.DB2_LIVE_TEST_HOST}`,
        `PORT=${port}`,
        'PROTOCOL=TCPIP',
        `UID=${process.env.DB2_LIVE_TEST_USER}`,
        `PWD=${process.env.DB2_LIVE_TEST_PASSWORD}`,
        `ClientCodepage=${process.env.DB2_LIVE_TEST_CLIENT_CODEPAGE || '1208'}`,
    ].join(';');

    const extraConnectionParts = [
        ['DB2_LIVE_TEST_CURRENT_SCHEMA', 'CURRENTSCHEMA'],
        ['DB2_LIVE_TEST_SECURITY', 'Security'],
        ['DB2_LIVE_TEST_SSL_SERVER_CERTIFICATE', 'SSLServerCertificate'],
    ]
        .filter(([environmentName]) => process.env[environmentName])
        .map(([environmentName, connectionKey]) => `${connectionKey}=${process.env[environmentName]}`);
    const fullConnectionString = [connectionString, ...extraConnectionParts].join(';');

    return new Promise((resolve, reject) => {
        ibmDb.open(fullConnectionString, (openError, connection) => {
            if (openError) {
                reject(openError);
                return;
            }
            connection.query('SELECT 1 AS VALUE FROM SYSIBM.SYSDUMMY1', (queryError, rows) => {
                connection.close(closeError => {
                    if (queryError) {
                        reject(queryError);
                    } else if (closeError) {
                        reject(closeError);
                    } else if (!Array.isArray(rows) || Number(rows[0]?.VALUE) !== 1) {
                        reject(new Error(`Unexpected DB2 smoke-query result: ${JSON.stringify(rows)}`));
                    } else {
                        resolve();
                    }
                });
            });
        });
    });
}

async function run() {
    const db2ExtensionRoot = process.env.DB2_EXTENSION_ROOT;
    assert.ok(db2ExtensionRoot, 'DB2_EXTENSION_ROOT must point to the Db2 extension root.');
    assert.ok(
        Number(process.versions.napi || 0) >= REQUIRED_NAPI_VERSION,
        `Extension Host N-API ${process.versions.napi || 'unknown'} is below ${REQUIRED_NAPI_VERSION}.`,
    );

    configureBundledCliDriver(db2ExtensionRoot);
    const modulePath = require.resolve('ibm_db', { paths: [db2ExtensionRoot] });
    const ibmDb = require(modulePath);
    assert.equal(typeof ibmDb.open, 'function', 'ibm_db must expose open().');

    await queryLiveDb2(ibmDb);
    console.log(`Db2 N-API Extension Host smoke test passed (N-API ${process.versions.napi}).`);
}

module.exports = { run };
