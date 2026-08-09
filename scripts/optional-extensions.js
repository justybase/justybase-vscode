const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..');

const OPTIONAL_EXTENSIONS = Object.freeze([
    {
        id: 'db2',
        fallbackDisplayName: 'JustyBase SQL Editor (Db2)',
        directory: path.join(repoRoot, 'extensions', 'db2'),
        packageJson: path.join(repoRoot, 'extensions', 'db2', 'package.json'),
        packageLock: path.join(repoRoot, 'extensions', 'db2', 'package-lock.json'),
        tsconfig: path.join(repoRoot, 'extensions', 'db2', 'tsconfig.json'),
        srcDir: path.join(repoRoot, 'extensions', 'db2', 'src')
    },
    {
        id: 'duckdb',
        fallbackDisplayName: 'JustyBase SQL Editor (DuckDB)',
        directory: path.join(repoRoot, 'extensions', 'duckdb'),
        packageJson: path.join(repoRoot, 'extensions', 'duckdb', 'package.json'),
        packageLock: path.join(repoRoot, 'extensions', 'duckdb', 'package-lock.json'),
        tsconfig: path.join(repoRoot, 'extensions', 'duckdb', 'tsconfig.json'),
        srcDir: path.join(repoRoot, 'extensions', 'duckdb', 'src')
    },
    {
        id: 'oracle',
        fallbackDisplayName: 'JustyBase SQL Editor (Oracle)',
        directory: path.join(repoRoot, 'extensions', 'oracle'),
        packageJson: path.join(repoRoot, 'extensions', 'oracle', 'package.json'),
        packageLock: path.join(repoRoot, 'extensions', 'oracle', 'package-lock.json'),
        tsconfig: path.join(repoRoot, 'extensions', 'oracle', 'tsconfig.json'),
        srcDir: path.join(repoRoot, 'extensions', 'oracle', 'src')
    },
    {
        id: 'postgresql',
        fallbackDisplayName: 'JustyBase SQL Editor (PostgreSQL)',
        directory: path.join(repoRoot, 'extensions', 'postgresql'),
        packageJson: path.join(repoRoot, 'extensions', 'postgresql', 'package.json'),
        packageLock: path.join(repoRoot, 'extensions', 'postgresql', 'package-lock.json'),
        tsconfig: path.join(repoRoot, 'extensions', 'postgresql', 'tsconfig.json'),
        srcDir: path.join(repoRoot, 'extensions', 'postgresql', 'src')
    },
    {
        id: 'vertica',
        fallbackDisplayName: 'JustyBase SQL Editor (Vertica)',
        directory: path.join(repoRoot, 'extensions', 'vertica'),
        packageJson: path.join(repoRoot, 'extensions', 'vertica', 'package.json'),
        packageLock: path.join(repoRoot, 'extensions', 'vertica', 'package-lock.json'),
        tsconfig: path.join(repoRoot, 'extensions', 'vertica', 'tsconfig.json'),
        srcDir: path.join(repoRoot, 'extensions', 'vertica', 'src')
    },
    {
        id: 'snowflake',
        fallbackDisplayName: 'JustyBase SQL Editor (Snowflake)',
        directory: path.join(repoRoot, 'extensions', 'snowflake'),
        packageJson: path.join(repoRoot, 'extensions', 'snowflake', 'package.json'),
        packageLock: path.join(repoRoot, 'extensions', 'snowflake', 'package-lock.json'),
        tsconfig: path.join(repoRoot, 'extensions', 'snowflake', 'tsconfig.json'),
        srcDir: path.join(repoRoot, 'extensions', 'snowflake', 'src')
    },
    {
        id: 'mssql',
        fallbackDisplayName: 'JustyBase SQL Editor (MS SQL Server)',
        directory: path.join(repoRoot, 'extensions', 'mssql'),
        packageJson: path.join(repoRoot, 'extensions', 'mssql', 'package.json'),
        packageLock: path.join(repoRoot, 'extensions', 'mssql', 'package-lock.json'),
        tsconfig: path.join(repoRoot, 'extensions', 'mssql', 'tsconfig.json'),
        srcDir: path.join(repoRoot, 'extensions', 'mssql', 'src')
    },
    {
        id: 'mysql',
        fallbackDisplayName: 'JustyBase SQL Editor (MySQL)',
        directory: path.join(repoRoot, 'extensions', 'mysql'),
        packageJson: path.join(repoRoot, 'extensions', 'mysql', 'package.json'),
        packageLock: path.join(repoRoot, 'extensions', 'mysql', 'package-lock.json'),
        tsconfig: path.join(repoRoot, 'extensions', 'mysql', 'tsconfig.json'),
        srcDir: path.join(repoRoot, 'extensions', 'mysql', 'src')
    },
    {
        id: 'access',
        fallbackDisplayName: 'JustyBase SQL Editor (Microsoft Access)',
        directory: path.join(repoRoot, 'extensions', 'access'),
        packageJson: path.join(repoRoot, 'extensions', 'access', 'package.json'),
        packageLock: path.join(repoRoot, 'extensions', 'access', 'package-lock.json'),
        tsconfig: path.join(repoRoot, 'extensions', 'access', 'tsconfig.json'),
        srcDir: path.join(repoRoot, 'extensions', 'access', 'src'),
        javaBridgeDir: path.join(repoRoot, 'extensions', 'access', 'java-bridge')
    }
]);

function readManifestDisplayName(extension) {
    try {
        const manifest = JSON.parse(fs.readFileSync(extension.packageJson, 'utf8'));
        return manifest.displayName || extension.fallbackDisplayName;
    } catch {
        return extension.fallbackDisplayName;
    }
}

for (const extension of OPTIONAL_EXTENSIONS) {
    const displayName = readManifestDisplayName(extension);
    extension.displayName = displayName;
    extension.marketplaceName = displayName;
}

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
