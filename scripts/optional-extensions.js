const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..');

const OPTIONAL_EXTENSIONS = Object.freeze([
    {
        id: 'db2',
        displayName: 'Db2 Support',
        marketplaceName: 'JustyBase Db2 Support',
        directory: path.join(repoRoot, 'extensions', 'db2'),
        packageJson: path.join(repoRoot, 'extensions', 'db2', 'package.json'),
        packageLock: path.join(repoRoot, 'extensions', 'db2', 'package-lock.json'),
        tsconfig: path.join(repoRoot, 'extensions', 'db2', 'tsconfig.json'),
        srcDir: path.join(repoRoot, 'extensions', 'db2', 'src')
    },
    {
        id: 'duckdb',
        displayName: 'DuckDB Support',
        marketplaceName: 'JustyBase DuckDB Support',
        directory: path.join(repoRoot, 'extensions', 'duckdb'),
        packageJson: path.join(repoRoot, 'extensions', 'duckdb', 'package.json'),
        packageLock: path.join(repoRoot, 'extensions', 'duckdb', 'package-lock.json'),
        tsconfig: path.join(repoRoot, 'extensions', 'duckdb', 'tsconfig.json'),
        srcDir: path.join(repoRoot, 'extensions', 'duckdb', 'src')
    },
    {
        id: 'oracle',
        displayName: 'Oracle Support',
        marketplaceName: 'JustyBase Oracle Support',
        directory: path.join(repoRoot, 'extensions', 'oracle'),
        packageJson: path.join(repoRoot, 'extensions', 'oracle', 'package.json'),
        packageLock: path.join(repoRoot, 'extensions', 'oracle', 'package-lock.json'),
        tsconfig: path.join(repoRoot, 'extensions', 'oracle', 'tsconfig.json'),
        srcDir: path.join(repoRoot, 'extensions', 'oracle', 'src')
    },
    {
        id: 'postgresql',
        displayName: 'PostgreSQL Support',
        marketplaceName: 'JustyBase PostgreSQL Support',
        directory: path.join(repoRoot, 'extensions', 'postgresql'),
        packageJson: path.join(repoRoot, 'extensions', 'postgresql', 'package.json'),
        packageLock: path.join(repoRoot, 'extensions', 'postgresql', 'package-lock.json'),
        tsconfig: path.join(repoRoot, 'extensions', 'postgresql', 'tsconfig.json'),
        srcDir: path.join(repoRoot, 'extensions', 'postgresql', 'src')
    },
    {
        id: 'vertica',
        displayName: 'Vertica Support',
        marketplaceName: 'JustyBase Vertica Support',
        directory: path.join(repoRoot, 'extensions', 'vertica'),
        packageJson: path.join(repoRoot, 'extensions', 'vertica', 'package.json'),
        packageLock: path.join(repoRoot, 'extensions', 'vertica', 'package-lock.json'),
        tsconfig: path.join(repoRoot, 'extensions', 'vertica', 'tsconfig.json'),
        srcDir: path.join(repoRoot, 'extensions', 'vertica', 'src')
    },
    {
        id: 'snowflake',
        displayName: 'Snowflake Support',
        marketplaceName: 'JustyBase Snowflake Support',
        directory: path.join(repoRoot, 'extensions', 'snowflake'),
        packageJson: path.join(repoRoot, 'extensions', 'snowflake', 'package.json'),
        packageLock: path.join(repoRoot, 'extensions', 'snowflake', 'package-lock.json'),
        tsconfig: path.join(repoRoot, 'extensions', 'snowflake', 'tsconfig.json'),
        srcDir: path.join(repoRoot, 'extensions', 'snowflake', 'src')
    },
    {
        id: 'mssql',
        displayName: 'MS SQL Server Support',
        marketplaceName: 'JustyBase MS SQL Server Support',
        directory: path.join(repoRoot, 'extensions', 'mssql'),
        packageJson: path.join(repoRoot, 'extensions', 'mssql', 'package.json'),
        packageLock: path.join(repoRoot, 'extensions', 'mssql', 'package-lock.json'),
        tsconfig: path.join(repoRoot, 'extensions', 'mssql', 'tsconfig.json'),
        srcDir: path.join(repoRoot, 'extensions', 'mssql', 'src')
    },
    {
        id: 'mysql',
        displayName: 'MySQL Support',
        marketplaceName: 'JustyBase MySQL Support',
        directory: path.join(repoRoot, 'extensions', 'mysql'),
        packageJson: path.join(repoRoot, 'extensions', 'mysql', 'package.json'),
        packageLock: path.join(repoRoot, 'extensions', 'mysql', 'package-lock.json'),
        tsconfig: path.join(repoRoot, 'extensions', 'mysql', 'tsconfig.json'),
        srcDir: path.join(repoRoot, 'extensions', 'mysql', 'src')
    }
]);

function getOptionalExtension(id) {
    return OPTIONAL_EXTENSIONS.find(extension => extension.id === id);
}

function optionalExtensionExists(extension) {
    return fs.existsSync(extension.directory);
}

function listPresentOptionalExtensions() {
    return OPTIONAL_EXTENSIONS.filter(optionalExtensionExists);
}

module.exports = {
    OPTIONAL_EXTENSIONS,
    getOptionalExtension,
    listPresentOptionalExtensions,
    optionalExtensionExists,
    repoRoot
};
