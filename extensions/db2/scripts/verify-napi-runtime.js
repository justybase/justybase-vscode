#!/usr/bin/env node
// @ts-check

/** Validates the native Db2 runtime before it is packed or used in CI. */

const fs = require('node:fs');
const path = require('node:path');

const DB2_EXTENSION_ROOT = path.resolve(__dirname, '..');
const IBM_DB_PACKAGE_DIR = path.join(DB2_EXTENSION_ROOT, 'node_modules', 'ibm_db');
const BINDING_BINARY_PATH = path.join(IBM_DB_PACKAGE_DIR, 'build', 'Release', 'odbc_bindings.node');
const RUNTIME_MARKER_PATH = path.join(IBM_DB_PACKAGE_DIR, 'build', 'Release', '.justybase-napi-runtime.json');
const REQUIRED_NAPI_VERSION = 8;

function fail(message) {
    console.error(`Db2 N-API runtime verification failed: ${message}`);
    process.exit(1);
}

function prependEnvironmentPath(name, value) {
    const values = (process.env[name] || '').split(path.delimiter).filter(Boolean);
    if (!values.includes(value)) {
        process.env[name] = [value, ...values].join(path.delimiter);
    }
}

function configureBundledCliDriver() {
    const cliDriverHome = path.join(IBM_DB_PACKAGE_DIR, 'installer', 'clidriver');
    process.env.IBM_DB_HOME = cliDriverHome;
    prependEnvironmentPath('PATH', path.join(cliDriverHome, 'bin'));
    prependEnvironmentPath('PATH', path.join(cliDriverHome, 'lib'));

    if (process.platform === 'linux') {
        prependEnvironmentPath('LD_LIBRARY_PATH', path.join(cliDriverHome, 'lib'));
    } else if (process.platform === 'darwin') {
        prependEnvironmentPath('DYLD_LIBRARY_PATH', path.join(cliDriverHome, 'lib'));
    }
}

function main() {
    const hostNapiVersion = Number(process.versions.napi || 0);
    if (hostNapiVersion < REQUIRED_NAPI_VERSION) {
        fail(`host N-API ${hostNapiVersion || 'unknown'} is below required ${REQUIRED_NAPI_VERSION}`);
    }
    if (!fs.existsSync(BINDING_BINARY_PATH)) {
        fail(`native binding is missing: ${BINDING_BINARY_PATH}`);
    }
    if (!fs.existsSync(RUNTIME_MARKER_PATH)) {
        fail(`runtime marker is missing: ${RUNTIME_MARKER_PATH}`);
    }

    let marker;
    try {
        marker = JSON.parse(fs.readFileSync(RUNTIME_MARKER_PATH, 'utf8'));
    } catch (error) {
        fail(`runtime marker is invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
    }

    if (
        marker.runtime !== 'napi'
        || marker.napiVersion !== REQUIRED_NAPI_VERSION
        || marker.platform !== process.platform
        || marker.arch !== process.arch
    ) {
        fail(`unexpected runtime marker: ${JSON.stringify(marker)}`);
    }

    configureBundledCliDriver();
    let ibmDb;
    try {
        ibmDb = require('ibm_db');
    } catch (error) {
        fail(`ibm_db could not be loaded: ${error instanceof Error ? error.stack || error.message : String(error)}`);
    }

    if (!ibmDb || typeof ibmDb.open !== 'function') {
        fail('ibm_db loaded but does not expose its open function.');
    }

    console.log(
        `Db2 N-API runtime verified: N-API ${marker.napiVersion}, ${marker.platform}-${marker.arch}, ibm_db ${marker.ibmDbVersion}`,
    );
}

main();
