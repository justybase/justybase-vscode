'use strict';

/**
 * Map `@justybase/access-file` specifiers to the package sources.
 *
 * The Access extension imports the published package name, whose entry point is
 * `dist/index.js`.  Cross-check scripts run through `tsx` and otherwise load
 * their own modules from `packages/access-file/src`, so on a clean checkout
 * (no `dist/`) the extension import fails with MODULE_NOT_FOUND before a single
 * statement is replayed.  Mapping the specifier keeps every module in one copy
 * and makes the gates runnable straight after `npm ci`.
 */
const path = require('node:path');

const ACCESS_FILE_PACKAGE = '@justybase/access-file';
const ACCESS_FILE_SOURCE = path.resolve(__dirname, '..', 'packages', 'access-file', 'src');

/**
 * @param {string} request Module specifier being resolved.
 * @returns {string | undefined} Absolute source path, or `undefined` to leave
 *   the specifier to the default resolver.
 */
function resolveAccessFileSource(request) {
    if (typeof request !== 'string') return undefined;
    if (request !== ACCESS_FILE_PACKAGE && !request.startsWith(`${ACCESS_FILE_PACKAGE}/`)) {
        return undefined;
    }
    const subpath = request.slice(ACCESS_FILE_PACKAGE.length).replace(/^\/+/u, '');
    return subpath.length === 0 ? ACCESS_FILE_SOURCE : path.join(ACCESS_FILE_SOURCE, subpath);
}

/**
 * Install a `Module._load` hook that resolves the package name to its sources.
 *
 * @param {NodeModule | { _load: Function }} [ModuleLike] Defaults to `node:module`.
 * @returns {() => void} Restores the previous loader.
 */
function installAccessFileSourceHook(ModuleLike = require('node:module')) {
    const originalLoad = ModuleLike._load;
    ModuleLike._load = function load(request, parent, isMain) {
        const source = resolveAccessFileSource(request);
        if (source !== undefined) return originalLoad.call(this, source, parent, isMain);
        return originalLoad.call(this, request, parent, isMain);
    };
    return () => {
        ModuleLike._load = originalLoad;
    };
}

module.exports = {
    ACCESS_FILE_PACKAGE,
    ACCESS_FILE_SOURCE,
    installAccessFileSourceHook,
    resolveAccessFileSource,
};
