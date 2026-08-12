#!/usr/bin/env node
// @ts-check

/**
 * Backward-compatible entrypoint for older development instructions.
 *
 * Db2 is now built as a Node-API module, so its binary is intentionally not
 * compiled for an individual Electron version. Any --electron/--vscode-dir
 * arguments are ignored and may be removed from local tooling.
 */

if (process.argv.length > 2) {
    console.warn('Ignoring Electron-specific arguments: ibm_db is built as an N-API module.');
}

require('./rebuild-napi.js');
