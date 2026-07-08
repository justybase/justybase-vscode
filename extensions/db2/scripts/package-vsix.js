const fs = require('node:fs');
const path = require('node:path');

const EXTENSION_ROOT = path.resolve(__dirname, '..');
const REPOSITORY_ROOT = path.resolve(EXTENSION_ROOT, '..', '..');
const VSCE_ROOT = path.join(REPOSITORY_ROOT, 'node_modules', '@vscode', 'vsce');

function getProductionDependencyDirectories(cwd) {
    const lockPath = path.join(cwd, 'package-lock.json');
    const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    const packageEntries = lock.packages && typeof lock.packages === 'object'
        ? Object.entries(lock.packages)
        : [];

    const dependencyDirectories = packageEntries
        .filter(([packagePath, metadata]) => packagePath.startsWith('node_modules/') && !metadata.dev)
        .map(([packagePath]) => path.join(cwd, packagePath))
        .filter(packagePath => fs.existsSync(packagePath));

    return [cwd, ...dependencyDirectories];
}

const vsceNpm = require(path.join(VSCE_ROOT, 'out', 'npm'));
const getDependencies = vsceNpm.getDependencies;

vsceNpm.getDependencies = async function getDb2PackageDependencies(cwd, dependencies, packagedDependencies) {
    const normalizedCwd = path.resolve(cwd);
    if (normalizedCwd !== EXTENSION_ROOT || dependencies === 'none') {
        return getDependencies(cwd, dependencies, packagedDependencies);
    }

    return getProductionDependencyDirectories(normalizedCwd);
};

require(path.join(VSCE_ROOT, 'out', 'main'))(process.argv);
