# CI Scripts

Public scripts used by GitHub Actions and npm build/version commands.

## Files

- [`optional-extensions.js`](optional-extensions.js) - optional extension registry helpers
- [`run-optional-extension-task.js`](run-optional-extension-task.js) - shared runner for optional extension tasks
- [`version-sync.js`](version-sync.js) - version alignment across core and optional extensions
- [`jest-media-resolver.cjs`](jest-media-resolver.cjs) - Jest resolver for `media/` TypeScript tests

## Common commands

```bash
npm run version:check
npm run build:duckdb
npm run install:postgresql
npm run package:snowflake
```
