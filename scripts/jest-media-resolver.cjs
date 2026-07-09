const fs = require('node:fs');
const path = require('node:path');

/**
 * Resolve TypeScript ESM-style `./module.js` imports inside `media/` to `.ts` sources.
 */
module.exports = (request, options) => {
    const { defaultResolver, basedir } = options;
    if (/^\.\.?\/.*\.js$/.test(request) && basedir.includes(`${path.sep}media${path.sep}`)) {
        const tsRequest = request.replace(/\.js$/, '.ts');
        const tsPath = path.resolve(basedir, tsRequest);
        if (fs.existsSync(tsPath)) {
            return defaultResolver(tsRequest, options);
        }
    }
    return defaultResolver(request, options);
};
