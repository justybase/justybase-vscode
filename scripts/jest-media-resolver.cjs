const fs = require('node:fs');
const path = require('node:path');

/**
 * Resolve TypeScript ESM-style `./module.js` imports inside `media/` to `.ts` sources.
 */
module.exports = (request, options) => {
    const { defaultResolver, basedir } = options;
    if (/^\.\.?\/.*\.js$/.test(request) && basedir.includes(`${path.sep}media${path.sep}`)) {
        const sourceRequest = request.replace(/\.js$/, '');
        for (const extension of ['.ts', '.tsx']) {
            const typedRequest = `${sourceRequest}${extension}`;
            const typedPath = path.resolve(basedir, typedRequest);
            if (fs.existsSync(typedPath)) {
                return defaultResolver(typedRequest, options);
            }
        }
    }
    return defaultResolver(request, options);
};
