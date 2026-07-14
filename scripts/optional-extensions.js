const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..');

const OPTIONAL_EXTENSIONS = Object.freeze([
    {
        id: 'db2',
        displayName: 'Db2 Support',
        marketplaceName: 'Db2 Tools (justybase)',
        directory: path.join(repoRoot, 'extensions', 'db2'),
        packageJson: path.join(repoRoot, 'extensions', 'db2', 'package.json'),
        packageLock: path.join(repoRoot, 'extensions', 'db2', 'package-lock.json'),
        tsconfig: path.join(repoRoot, 'extensions', 'db2', 'tsconfig.json'),
        srcDir: path.join(repoRoot, 'extensions', 'db2', 'src')
    },
    {
        id: 'duckdb',
        displayName: 'DuckDB Support',
        marketplaceName: 'DuckDB Tools (justybase)',
        directory: path.join(repoRoot, 'extensions', 'duckdb'),
        packageJson: path.join(repoRoot, 'extensions', 'duckdb', 'package.json'),
        packageLock: path.join(repoRoot, 'extensions', 'duckdb', 'package-lock.json'),
        tsconfig: path.join(repoRoot, 'extensions', 'duckdb', 'tsconfig.json'),
        srcDir: path.join(repoRoot, 'extensions', 'duckdb', 'src')
    },
    {
        id: 'oracle',
        displayName: 'Oracle Support',
        marketplaceName: 'Oracle Tools (justybase)',
        directory: path.join(repoRoot, 'extensions', 'oracle'),
        packageJson: path.join(repoRoot, 'extensions', 'oracle', 'package.json'),
        packageLock: path.join(repoRoot, 'extensions', 'oracle', 'package-lock.json'),
        tsconfig: path.join(repoRoot, 'extensions', 'oracle', 'tsconfig.json'),
        srcDir: path.join(repoRoot, 'extensions', 'oracle', 'src')
    },
    {
        id: 'postgresql',
        displayName: 'PostgreSQL Support',
        marketplaceName: 'PostgreSQL Tools (justybase)',
        directory: path.join(repoRoot, 'extensions', 'postgresql'),
        packageJson: path.join(repoRoot, 'extensions', 'postgresql', 'package.json'),
        packageLock: path.join(repoRoot, 'extensions', 'postgresql', 'package-lock.json'),
        tsconfig: path.join(repoRoot, 'extensions', 'postgresql', 'tsconfig.json'),
        srcDir: path.join(repoRoot, 'extensions', 'postgresql', 'src')
    },
    {
        id: 'vertica',
        displayName: 'Vertica Support',
        marketplaceName: 'Vertica Tools (justybase)',
        directory: path.join(repoRoot, 'extensions', 'vertica'),
        packageJson: path.join(repoRoot, 'extensions', 'vertica', 'package.json'),
        packageLock: path.join(repoRoot, 'extensions', 'vertica', 'package-lock.json'),
        tsconfig: path.join(repoRoot, 'extensions', 'vertica', 'tsconfig.json'),
        srcDir: path.join(repoRoot, 'extensions', 'vertica', 'src')
    },
    {
        id: 'snowflake',
        displayName: 'Snowflake Support',
        marketplaceName: 'Snowflake Tools (justybase)',
        directory: path.join(repoRoot, 'extensions', 'snowflake'),
        packageJson: path.join(repoRoot, 'extensions', 'snowflake', 'package.json'),
        packageLock: path.join(repoRoot, 'extensions', 'snowflake', 'package-lock.json'),
        tsconfig: path.join(repoRoot, 'extensions', 'snowflake', 'tsconfig.json'),
        srcDir: path.join(repoRoot, 'extensions', 'snowflake', 'src')
    },
    {
        id: 'mssql',
        displayName: 'MS SQL Server Support',
        marketplaceName: 'MSSQL Tools (justybase)',
        directory: path.join(repoRoot, 'extensions', 'mssql'),
        packageJson: path.join(repoRoot, 'extensions', 'mssql', 'package.json'),
        packageLock: path.join(repoRoot, 'extensions', 'mssql', 'package-lock.json'),
        tsconfig: path.join(repoRoot, 'extensions', 'mssql', 'tsconfig.json'),
        srcDir: path.join(repoRoot, 'extensions', 'mssql', 'src')
    },
    {
        id: 'mysql',
        displayName: 'MySQL Support',
        marketplaceName: 'MySQL Tools (justybase)',
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
