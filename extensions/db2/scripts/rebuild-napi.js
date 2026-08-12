#!/usr/bin/env node
// @ts-check

/**
 * Builds ibm_db as a Node-API module for the Db2 VSIX.
 *
 * Node-API modules are ABI-stable across Node and Electron runtimes that
 * support the selected N-API version. This lets one platform VSIX work with
 * the supported VS Code versions instead of binding it to one Electron build.
 */

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const DB2_EXTENSION_ROOT = path.resolve(__dirname, '..');
const IBM_DB_PACKAGE_DIR = path.join(DB2_EXTENSION_ROOT, 'node_modules', 'ibm_db');
const BINDING_GYP_PATH = path.join(IBM_DB_PACKAGE_DIR, 'binding.gyp');
const BINDING_BINARY_PATH = path.join(IBM_DB_PACKAGE_DIR, 'build', 'Release', 'odbc_bindings.node');
const RUNTIME_MARKER_PATH = path.join(IBM_DB_PACKAGE_DIR, 'build', 'Release', '.justybase-napi-runtime.json');
const NODE_GYP_SCRIPT = path.join(DB2_EXTENSION_ROOT, 'node_modules', 'node-gyp', 'bin', 'node-gyp.js');

// N-API 8 is available in Node 16.17+ and is therefore below the API level of
// the minimum supported VS Code runtime. ibm_db does not use APIs newer than it.
const NAPI_VERSION = 8;

function fail(message) {
    console.error(message);
    process.exit(1);
}

function getNpmCommand() {
    return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

function getCliDriverHome() {
    return path.join(IBM_DB_PACKAGE_DIR, 'installer', 'clidriver');
}

function isValidCliDriverHome(cliDriverHome) {
    if (!fs.existsSync(path.join(cliDriverHome, 'include', 'sqlcli1.h'))) {
        return false;
    }

    if (process.platform === 'win32') {
        return fs.existsSync(path.join(cliDriverHome, 'bin', 'db2cli64.dll'));
    }

    if (process.platform === 'darwin') {
        return fs.existsSync(path.join(cliDriverHome, 'lib', 'libdb2.dylib'));
    }

    return fs.existsSync(path.join(cliDriverHome, 'lib', 'libdb2.so'))
        || fs.existsSync(path.join(cliDriverHome, 'lib', 'libdb2.so.1'));
}

function ensureIbmDbInstalled() {
    const cliDriverHome = getCliDriverHome();
    if (fs.existsSync(IBM_DB_PACKAGE_DIR) && isValidCliDriverHome(cliDriverHome)) {
        return cliDriverHome;
    }

    console.log('Installing ibm_db and its bundled Db2 CLI driver before the N-API build...');
    execFileSync(getNpmCommand(), ['install', '--force', 'ibm_db@^4.0.0'], {
        cwd: DB2_EXTENSION_ROOT,
        stdio: 'inherit',
        shell: process.platform === 'win32'
    });

    if (!isValidCliDriverHome(cliDriverHome)) {
        fail(`ibm_db installation did not provide a usable bundled CLI driver: ${cliDriverHome}`);
    }

    return cliDriverHome;
}

function patchBindingGyp() {
    if (!fs.existsSync(BINDING_GYP_PATH)) {
        fail(`ibm_db binding.gyp is missing: ${BINDING_GYP_PATH}`);
    }

    const original = fs.readFileSync(BINDING_GYP_PATH, 'utf8');
    const newline = original.includes('\r\n') ? '\r\n' : '\n';
    let patched = original;

    const definesPattern = /'defines'\s*:\s*\[\s*'NAPI_DISABLE_CPP_EXCEPTIONS'(?:\s*,\s*'NAPI_VERSION=\d+')?\s*\],/;
    if (!definesPattern.test(patched)) {
        fail('Could not find ibm_db Node-API defines in binding.gyp. Refusing to build an unpinned binary.');
    }
    patched = patched.replace(
        definesPattern,
        `'defines': [ 'NAPI_DISABLE_CPP_EXCEPTIONS', 'NAPI_VERSION=${NAPI_VERSION}' ],`
    );

    if (!/['"]IS_DOWNLOADED%['"]\s*:/.test(patched)) {
        const variablesPattern = /(['"]variables['"]\s*:\s*\{\s*\r?\n)/;
        if (!variablesPattern.test(patched)) {
            fail('Could not define ibm_db IS_DOWNLOADED in binding.gyp.');
        }
        patched = patched.replace(
            variablesPattern,
            `$1        'IS_DOWNLOADED%': 'true',${newline}`,
        );
    }

    // node-gyp otherwise adds odbc32.lib before IBM CLI's db2app64.lib on
    // Windows, which would make the packaged driver depend on OS registration.
    if (process.platform === 'win32' && !patched.includes("'libraries!': ['-lodbc32.lib']")) {
        const windowsLibrariesPattern = /(db2app64\.lib'\],\s*\r?\n)(\s*'include_dirs')/m;
        if (!windowsLibrariesPattern.test(patched)) {
            fail('Could not patch ibm_db Windows ODBC link order in binding.gyp.');
        }
        patched = patched.replace(
            windowsLibrariesPattern,
            `$1            'libraries!': ['-lodbc32.lib'],${newline}$2`,
        );
    }

    fs.writeFileSync(BINDING_GYP_PATH, patched, 'utf8');
    return original;
}

function getIbmDbVersion() {
    const packageJsonPath = path.join(IBM_DB_PACKAGE_DIR, 'package.json');
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
    return String(packageJson.version);
}

function patchDarwinLibraryReference() {
    if (process.platform !== 'darwin') {
        return;
    }

    // ibm_db's macOS build links against the bare `libdb2.dylib` name. The
    // loader does not reliably honor DYLD_LIBRARY_PATH after the host starts
    // (notably in VS Code and CI), so make the packaged binding self-contained.
    execFileSync('install_name_tool', [
        '-change',
        'libdb2.dylib',
        '@loader_path/../../installer/clidriver/lib/libdb2.dylib',
        BINDING_BINARY_PATH,
    ], { stdio: 'inherit' });
}

function writeRuntimeMarker() {
    fs.mkdirSync(path.dirname(RUNTIME_MARKER_PATH), { recursive: true });
    fs.writeFileSync(
        RUNTIME_MARKER_PATH,
        JSON.stringify({
            formatVersion: 1,
            runtime: 'napi',
            napiVersion: NAPI_VERSION,
            platform: process.platform,
            arch: process.arch,
            ibmDbVersion: getIbmDbVersion(),
            builtWithNode: process.version,
            preparedAt: new Date().toISOString(),
        }, null, 2),
        'utf8',
    );
}

function main() {
    const cliDriverHome = ensureIbmDbInstalled();
    if (!fs.existsSync(NODE_GYP_SCRIPT)) {
        fail(`node-gyp is not installed at the expected path: ${NODE_GYP_SCRIPT}`);
    }

    const originalBindingGyp = patchBindingGyp();
    try {
        console.log(
            `Building ibm_db as Node-API ${NAPI_VERSION} for ${process.platform}-${process.arch} `
            + `(build host ${process.version})...`,
        );
        execFileSync(
            process.execPath,
            [NODE_GYP_SCRIPT, 'rebuild', `--arch=${process.arch}`, `--napi_build_version=${NAPI_VERSION}`],
            {
                cwd: IBM_DB_PACKAGE_DIR,
                env: {
                    ...process.env,
                    IBM_DB_HOME: cliDriverHome,
                    IS_DOWNLOADED: 'true',
                    npm_config_IS_DOWNLOADED: 'true',
                    npm_config_is_downloaded: 'true',
                    NAPI_VERSION: String(NAPI_VERSION),
                    npm_config_napi_build_version: String(NAPI_VERSION),
                },
                stdio: 'inherit',
            },
        );

        if (!fs.existsSync(BINDING_BINARY_PATH)) {
            fail(`N-API build completed but did not create ${BINDING_BINARY_PATH}`);
        }

        patchDarwinLibraryReference();
        writeRuntimeMarker();
        const size = fs.statSync(BINDING_BINARY_PATH).size;
        console.log(`Built ibm_db Node-API ${NAPI_VERSION}: ${BINDING_BINARY_PATH} (${size} bytes)`);
    } finally {
        fs.writeFileSync(BINDING_GYP_PATH, originalBindingGyp, 'utf8');
    }
}

main();
