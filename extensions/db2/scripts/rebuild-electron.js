// @ts-check
/**
 * Rebuilds the ibm_db native module for the Electron runtime used by VS Code
 * using @electron/rebuild, which correctly targets the Electron ABI instead
 * of the system Node ABI.
 *
 * Usage:
 *   node scripts/rebuild-electron.js                 — auto-detect from local VS Code install
 *   node scripts/rebuild-electron.js --electron 39.6.0  — explicit Electron version
 *   node scripts/rebuild-electron.js --vscode-dir "C:\Users\name\AppData\Local\Programs\Microsoft VS Code"
 *
 * Prerequisites:
 *   npm install (in extensions/db2) — ibm_db and @electron/rebuild must be installed
 *   Visual Studio Build Tools + Python (for native compilation)
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const DB2_EXT_ROOT = path.resolve(__dirname, '..');
const IBM_DB_PACKAGE_DIR = path.join(DB2_EXT_ROOT, 'node_modules', 'ibm_db');
const BINDING_BINARY_PATH = path.join(IBM_DB_PACKAGE_DIR, 'build', 'Release', 'odbc_bindings.node');
const ELECTRON_RUNTIME_MARKER_PATH = path.join(IBM_DB_PACKAGE_DIR, 'build', 'Release', '.justybase-electron-runtime.json');
const ELECTRON_HEADER_URL = 'https://www.electronjs.org/headers';
const NODE_GYP_SCRIPT = path.join(DB2_EXT_ROOT, 'node_modules', 'node-gyp', 'bin', 'node-gyp.js');
const DEFAULT_NODE_GYP_MSVS_VERSION = '2022';
const VSWHERE_PATH = process.platform === 'win32'
    ? path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Microsoft Visual Studio', 'Installer', 'vswhere.exe')
    : undefined;

function parseMajorVersion(version) {
    const majorVersion = Number(String(version).split('.')[0]);
    return Number.isFinite(majorVersion) ? majorVersion : undefined;
}

function parseEnvironmentBlock(output) {
    /** @type {Record<string, string>} */
    const environment = {};

    for (const line of output.split(/\r?\n/)) {
        const separatorIndex = line.indexOf('=');
        if (separatorIndex <= 0) {
            continue;
        }

        const key = line.slice(0, separatorIndex).trim();
        if (!key) {
            continue;
        }

        environment[key] = line.slice(separatorIndex + 1);
    }

    return environment;
}

function parseNumericSuffix(value) {
    const match = /^v(\d+)$/i.exec(value);
    return match ? Number(match[1]) : Number.NaN;
}

function sortVersionStringsDescending(values) {
    return [...values].sort((left, right) => {
        const rightVersion = parseNumericSuffix(right);
        const leftVersion = parseNumericSuffix(left);

        if (Number.isFinite(rightVersion) && Number.isFinite(leftVersion) && rightVersion !== leftVersion) {
            return rightVersion - leftVersion;
        }

        return right.localeCompare(left);
    });
}

function readElectronRuntimeMarker() {
    if (!fs.existsSync(ELECTRON_RUNTIME_MARKER_PATH)) {
        return undefined;
    }

    try {
        return JSON.parse(fs.readFileSync(ELECTRON_RUNTIME_MARKER_PATH, 'utf8'));
    } catch {
        return undefined;
    }
}

function hasPreparedElectronRuntime(electronVersion) {
    const marker = readElectronRuntimeMarker();
    return Boolean(
        marker
        && marker.electronVersion === electronVersion
        && fs.existsSync(BINDING_BINARY_PATH)
    );
}

function writeElectronRuntimeMarker(electronVersion, metadata = {}) {
    fs.mkdirSync(path.dirname(ELECTRON_RUNTIME_MARKER_PATH), { recursive: true });
    fs.writeFileSync(
        ELECTRON_RUNTIME_MARKER_PATH,
        JSON.stringify({
            electronVersion,
            preparedAt: new Date().toISOString(),
            ...metadata
        }, null, 2),
        'utf8'
    );
}

function removeElectronRuntimeMarker() {
    if (fs.existsSync(ELECTRON_RUNTIME_MARKER_PATH)) {
        fs.unlinkSync(ELECTRON_RUNTIME_MARKER_PATH);
    }
}

function findLatestVisualStudioCppInstallation() {
    if (process.platform !== 'win32' || !VSWHERE_PATH || !fs.existsSync(VSWHERE_PATH)) {
        return undefined;
    }

    try {
        const output = execFileSync(
            VSWHERE_PATH,
            ['-latest', '-products', '*', '-requires', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64', '-format', 'json'],
            {
                encoding: 'utf8',
                stdio: ['ignore', 'pipe', 'pipe']
            }
        );
        const parsed = JSON.parse(output);
        const installation = Array.isArray(parsed) ? parsed[0] : undefined;
        if (!installation?.installationPath || !installation?.installationVersion) {
            return undefined;
        }

        return {
            installationPath: path.resolve(installation.installationPath),
            installationVersion: String(installation.installationVersion),
            majorVersion: parseMajorVersion(installation.installationVersion),
            displayName: installation.displayName || installation.installationName || 'Visual Studio'
        };
    } catch {
        return undefined;
    }
}

function getInstalledPlatformToolsets(visualStudioPath) {
    const msbuildVcRoot = path.join(visualStudioPath, 'MSBuild', 'Microsoft', 'VC');
    if (!fs.existsSync(msbuildVcRoot)) {
        return [];
    }

    const platformName = process.arch === 'arm64' ? 'ARM64' : 'x64';
    const vcVersionDirectories = sortVersionStringsDescending(
        fs.readdirSync(msbuildVcRoot, { withFileTypes: true })
            .filter(entry => entry.isDirectory() && /^v\d+$/i.test(entry.name))
            .map(entry => entry.name)
    );

    for (const vcVersionDirectory of vcVersionDirectories) {
        const toolsetRoot = path.join(msbuildVcRoot, vcVersionDirectory, 'Platforms', platformName, 'PlatformToolsets');
        if (!fs.existsSync(toolsetRoot)) {
            continue;
        }

        const toolsets = sortVersionStringsDescending(
            fs.readdirSync(toolsetRoot, { withFileTypes: true })
                .filter(entry => entry.isDirectory() && /^v\d+$/i.test(entry.name))
                .map(entry => entry.name)
        );

        if (toolsets.length > 0) {
            return toolsets;
        }
    }

    return [];
}

function captureVsDevCmdEnvironment(visualStudioPath) {
    const vsDevCmd = path.join(visualStudioPath, 'Common7', 'Tools', 'VsDevCmd.bat');
    if (!fs.existsSync(vsDevCmd)) {
        return {};
    }

    try {
        const output = execFileSync(
            'cmd.exe',
            ['/d', '/s', '/c', `""${vsDevCmd}" -no_logo >nul && set"`],
            {
                encoding: 'utf8',
                stdio: ['ignore', 'pipe', 'pipe']
            }
        );
        return parseEnvironmentBlock(output);
    } catch {
        return {};
    }
}

function findLatestWindowsSdkVersion() {
    if (process.platform !== 'win32') {
        return undefined;
    }

    const sdkRoot = path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Windows Kits', '10', 'Include');
    if (!fs.existsSync(sdkRoot)) {
        return undefined;
    }

    const versions = fs.readdirSync(sdkRoot, { withFileTypes: true })
        .filter(entry => entry.isDirectory() && /^\d+\.\d+\.\d+\.\d+$/.test(entry.name))
        .map(entry => entry.name)
        .sort((left, right) => {
            const leftParts = left.split('.').map(Number);
            const rightParts = right.split('.').map(Number);
            const maxLength = Math.max(leftParts.length, rightParts.length);

            for (let index = 0; index < maxLength; index += 1) {
                const leftPart = leftParts[index] || 0;
                const rightPart = rightParts[index] || 0;
                if (leftPart !== rightPart) {
                    return rightPart - leftPart;
                }
            }

            return 0;
        });

    return versions[0] ? `${versions[0]}\\` : undefined;
}

function createFutureVisualStudioCompatEnvironment(baseEnv, visualStudioInfo) {
    const environment = {
        ...baseEnv,
        ...captureVsDevCmdEnvironment(visualStudioInfo.installationPath)
    };

    environment.VSINSTALLDIR = environment.VSINSTALLDIR || `${visualStudioInfo.installationPath}\\`;
    environment.VCINSTALLDIR = environment.VCINSTALLDIR || `${path.join(visualStudioInfo.installationPath, 'VC')}\\`;
    environment.WindowsSDKVersion = environment.WindowsSDKVersion || findLatestWindowsSdkVersion();
    environment.VSCMD_VER = '17.0.0';
    environment.GYP_MSVS_VERSION = DEFAULT_NODE_GYP_MSVS_VERSION;
    environment.npm_config_msvs_version = DEFAULT_NODE_GYP_MSVS_VERSION;

    return environment;
}

function getFutureVisualStudioFallback() {
    const visualStudioInfo = findLatestVisualStudioCppInstallation();
    if (!visualStudioInfo || !Number.isInteger(visualStudioInfo.majorVersion) || visualStudioInfo.majorVersion <= 17) {
        return undefined;
    }

    const installedToolsets = getInstalledPlatformToolsets(visualStudioInfo.installationPath);
    if (installedToolsets.length === 0) {
        return undefined;
    }

    return {
        ...visualStudioInfo,
        preferredToolset: installedToolsets[0]
    };
}

function getElectronNodeGypArgs(commandName, electronVersion, msvsVersion) {
    const args = [
        NODE_GYP_SCRIPT,
        commandName,
        '--runtime=electron',
        `--target=${electronVersion}`,
        `--arch=${process.arch}`,
        `--dist-url=${ELECTRON_HEADER_URL}`,
        '--build-from-source'
    ];

    if (msvsVersion) {
        args.push(`--msvs_version=${msvsVersion}`);
    }

    return args;
}

function patchGeneratedProjectToolset(toolset) {
    const projectPath = path.join(IBM_DB_PACKAGE_DIR, 'build', 'odbc_bindings.vcxproj');
    if (!fs.existsSync(projectPath)) {
        throw new Error(`Expected generated project was not found: ${projectPath}`);
    }

    const original = fs.readFileSync(projectPath, 'utf8');
    const updated = original.replace(
        /<PlatformToolset>[^<]+<\/PlatformToolset>/,
        `<PlatformToolset>${toolset}</PlatformToolset>`
    );

    if (updated === original) {
        console.log(`Generated project already uses PlatformToolset ${toolset}.`);
        return;
    }

    fs.writeFileSync(projectPath, updated, 'utf8');
    console.log(`Retargeted generated Visual Studio project to PlatformToolset ${toolset}.`);
}

function rebuildWithFutureVisualStudioFallback(electronVersion, rebuildEnv, fallbackInfo) {
    if (!fs.existsSync(NODE_GYP_SCRIPT)) {
        throw new Error(`node-gyp is not installed at the expected path: ${NODE_GYP_SCRIPT}`);
    }

    const fallbackEnv = createFutureVisualStudioCompatEnvironment(rebuildEnv, fallbackInfo);

    console.log(
        `Detected ${fallbackInfo.displayName} ${fallbackInfo.installationVersion} with installed toolset ${fallbackInfo.preferredToolset}.\n` +
        'Using a compatibility node-gyp flow because the bundled node-gyp still targets Visual Studio 2022 metadata.'
    );

    execFileSync(
        process.execPath,
        getElectronNodeGypArgs('configure', electronVersion, DEFAULT_NODE_GYP_MSVS_VERSION),
        {
            cwd: IBM_DB_PACKAGE_DIR,
            env: fallbackEnv,
            stdio: 'inherit'
        }
    );

    patchGeneratedProjectToolset(fallbackInfo.preferredToolset);

    execFileSync(
        process.execPath,
        getElectronNodeGypArgs('build', electronVersion, DEFAULT_NODE_GYP_MSVS_VERSION),
        {
            cwd: IBM_DB_PACKAGE_DIR,
            env: fallbackEnv,
            stdio: 'inherit'
        }
    );

    return {
        strategy: 'node-gyp-toolset-fallback',
        visualStudioVersion: fallbackInfo.installationVersion,
        visualStudioPath: fallbackInfo.installationPath,
        platformToolset: fallbackInfo.preferredToolset
    };
}

/**
 * Try common VS Code installation paths per platform.
 * Returns the first existing directory or undefined.
 */
function findVSCodeInstallDir() {
    /** @type {string[]} */
    const candidates = [];

    if (process.platform === 'win32') {
        const localAppData = process.env.LOCALAPPDATA || '';
        const programFiles = process.env['ProgramFiles'] || 'C:\\Program Files';
        candidates.push(
            path.join(localAppData, 'Programs', 'Microsoft VS Code'),
            path.join(programFiles, 'Microsoft VS Code')
        );
    } else if (process.platform === 'darwin') {
        candidates.push('/Applications/Visual Studio Code.app/Contents');
    } else {
        candidates.push('/usr/share/code', '/usr/lib/code', '/snap/code/current');
    }

    for (const dir of candidates) {
        if (fs.existsSync(dir)) {
            return dir;
        }
    }

    return undefined;
}

/**
 * Search for the `version` file that contains the Electron version string
 * inside the VS Code install directory.
 * VS Code may nest resources under a hash-named folder.
 */
function readElectronVersion(installDir) {
    // Direct path (older VS Code layouts)
    const directVersion = path.join(installDir, 'version');
    if (fs.existsSync(directVersion)) {
        const v = fs.readFileSync(directVersion, 'utf8').trim();
        if (/^\d+\.\d+\.\d+$/.test(v)) {
            return v;
        }
    }

    // Hashed subfolder (newer VS Code layouts on Windows)
    const entries = fs.readdirSync(installDir, { withFileTypes: true });
    for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const nested = path.join(installDir, entry.name, 'version');
        if (fs.existsSync(nested)) {
            const v = fs.readFileSync(nested, 'utf8').trim();
            if (/^\d+\.\d+\.\d+$/.test(v)) {
                return v;
            }
        }
    }

    return undefined;
}

function isValidClidriverHome(clidriverPath) {
    const hasHeader = fs.existsSync(path.join(clidriverPath, 'include', 'sqlcli1.h'));
    if (!hasHeader) {
        return false;
    }

    if (process.platform === 'win32') {
        return fs.existsSync(path.join(clidriverPath, 'bin', 'db2cli64.dll'));
    }

    if (process.platform === 'linux') {
        return fs.existsSync(path.join(clidriverPath, 'bin', 'db2cli'))
            || fs.existsSync(path.join(clidriverPath, 'lib', 'libdb2.so'));
    }

    if (process.platform === 'darwin') {
        return fs.existsSync(path.join(clidriverPath, 'bin', 'db2cli'))
            || fs.existsSync(path.join(clidriverPath, 'lib', 'libdb2.dylib'));
    }

    return false;
}

function parseArgs() {
    const args = process.argv.slice(2);
    /** @type {{ electronVersion?: string, vscodeDir?: string }} */
    const parsed = {};

    for (let index = 0; index < args.length; index += 1) {
        const arg = args[index];
        if (arg === '--electron' && args[index + 1]) {
            parsed.electronVersion = args[index + 1];
            index += 1;
            continue;
        }

        if (arg === '--vscode-dir' && args[index + 1]) {
            parsed.vscodeDir = path.resolve(args[index + 1]);
            index += 1;
        }
    }

    return parsed;
}

function warnIfVSCodeRunning() {
    if (process.platform !== 'win32') return;
    try {
        const out = execFileSync('tasklist', ['/FI', 'IMAGENAME eq Code.exe', '/NH'], {
            encoding: 'utf8',
            stdio: ['pipe', 'pipe', 'pipe']
        });
        if (out.includes('Code.exe')) {
            console.warn(
                '\n⚠️  WARNING: VS Code appears to be running.\n' +
                '   The native .node file may be locked by a running Extension Development Host.\n' +
                '   Close ALL VS Code windows before rebuilding, then press F5 to launch fresh.\n'
            );
        }
    } catch {
        // tasklist not available; skip warning
    }
}

function patchIbmDbBindingGyp(bindingGypPath) {
    if (!fs.existsSync(bindingGypPath)) {
        return undefined;
    }

    const original = fs.readFileSync(bindingGypPath, 'utf8');
    const newline = original.includes('\r\n') ? '\r\n' : '\n';
    let patched = original;

    if (!patched.includes('"IS_DOWNLOADED%"')) {
        const variablesPattern = /("variables"\s*:\s*\{\s*\r?\n)/;
        if (variablesPattern.test(patched)) {
            patched = patched.replace(
                variablesPattern,
                `$1        "IS_DOWNLOADED%": "true",${newline}`
            );
            console.log('Patched binding.gyp to define default IS_DOWNLOADED GYP variable.');
        } else {
            console.warn('Warning: could not locate binding.gyp variables block to define IS_DOWNLOADED.');
        }
    }

    if (process.platform === 'win32' && !patched.includes("libraries!")) {
        patched = patched.replace(
            /(db2app64\.lib'\],\s*\r?\n)(\s*'include_dirs')/m,
            `$1            'libraries!': ['-lodbc32.lib'],${newline}$2`
        );

        if (patched !== original) {
            console.log('Patched binding.gyp to exclude default odbc32.lib (IBM CLI driver will handle ODBC).');
        }
    }

    if (patched === original) {
        return original;
    }

    fs.writeFileSync(bindingGypPath, patched, 'utf8');
    return original;
}

function main() {
    warnIfVSCodeRunning();
    const { electronVersion: explicitElectronVersion, vscodeDir } = parseArgs();
    let electronVersion = explicitElectronVersion;

    if (!electronVersion) {
        const installDir = vscodeDir || findVSCodeInstallDir();
        if (!installDir) {
            console.error(
                'Could not locate VS Code installation directory.\n' +
                'Pass the Electron version explicitly:\n' +
                '  node scripts/rebuild-electron.js --electron <version>\n' +
                'or point at a specific install:\n' +
                '  node scripts/rebuild-electron.js --vscode-dir <path>\n' +
                'You can find the Electron version via Help > About in VS Code.'
            );
            process.exit(1);
        }

        if (vscodeDir && !fs.existsSync(installDir)) {
            console.error(
                `The provided VS Code installation directory does not exist: ${installDir}\n` +
                'Pass a valid --vscode-dir value or provide --electron explicitly.'
            );
            process.exit(1);
        }

        electronVersion = readElectronVersion(installDir);
        if (!electronVersion) {
            console.error(
                `Found VS Code at ${installDir} but could not read the Electron version.\n` +
                'Pass it explicitly: node scripts/rebuild-electron.js --electron <version>'
            );
            process.exit(1);
        }
        console.log(`${vscodeDir ? 'Using' : 'Detected'} VS Code install: ${installDir}`);
    }

    console.log(`Rebuilding ibm_db for Electron ${electronVersion} (system Node ABI ${process.versions.modules} will NOT be used)...`);

    // Step 1: Ensure ibm_db is fully installed (clidriver + native addon for system Node).
    // ibm_db's install script downloads the CLI driver and sets up ODBC bindings.
    // Without this step, electron-rebuild alone leaves the CLI driver unconfigured.
    const clidriverPath = path.join(DB2_EXT_ROOT, 'node_modules', 'ibm_db', 'installer', 'clidriver');
    const clidriverOk = isValidClidriverHome(clidriverPath);

    if (!clidriverOk) {
        console.log('\nStep 1/2: Installing ibm_db (CLI driver setup)...');
        const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
        try {
            execFileSync(npmCmd, ['install', '--force', 'ibm_db@^4.0.0'], {
                cwd: DB2_EXT_ROOT,
                env: { ...process.env },
                stdio: 'inherit',
                shell: process.platform === 'win32'
            });
        } catch {
            console.error('Failed to install ibm_db. Ensure network access and retry.');
            process.exit(1);
        }
    } else {
        console.log('Step 1/2: CLI driver already present — skipping npm install.');
    }

    // Set IBM_DB_HOME for the rebuild step
    if (fs.existsSync(path.join(clidriverPath, 'include', 'sqlcli1.h'))) {
        process.env.IBM_DB_HOME = clidriverPath;
        console.log(`Set IBM_DB_HOME=${clidriverPath}`);
    } else if (!process.env.IBM_DB_HOME) {
        console.warn(
            'Warning: Could not find clidriver headers at ' + clidriverPath + '.\n' +
            'If the build fails with "sqlcli1.h not found", set IBM_DB_HOME to your IBM CLI driver directory.'
        );
    }

    if (hasPreparedElectronRuntime(electronVersion)) {
        console.log(`\n✅ Existing ibm_db Electron runtime already matches Electron ${electronVersion}; skipping rebuild.`);
        console.log(`   Binary: ${BINDING_BINARY_PATH}`);
        console.log('\n   Close all VS Code windows and press F5 to launch with the updated bindings.');
        return;
    }

    // Step 2: Recompile native addon for Electron ABI using @electron/rebuild.
    // This overwrites the system-Node .node file with one targeting the Electron ABI.
    const futureVisualStudioFallback = getFutureVisualStudioFallback();

    // Verify @electron/rebuild is available when we intend to use the standard rebuild path.
    const electronRebuildBin = path.join(DB2_EXT_ROOT, 'node_modules', '.bin',
        process.platform === 'win32' ? 'electron-rebuild.cmd' : 'electron-rebuild');
    if (!futureVisualStudioFallback && !fs.existsSync(electronRebuildBin)) {
        console.error(
            '@electron/rebuild is not installed.\n' +
            'Run: npm install --save-dev @electron/rebuild   (in extensions/db2)\n' +
            'Then retry this command.'
        );
        process.exit(1);
    }

    // Patch binding.gyp before rebuild:
    // - define IS_DOWNLOADED as an actual GYP variable so Linux/macOS rebuilds
    //   do not fail while evaluating ibm_db's conditional ldflags
    // - exclude the default odbc32.lib on Windows so IBM CLI resolves ODBC symbols
    // node-gyp adds odbc32.lib as a default Windows library, and it appears
    // BEFORE db2app64.lib in the link order. The MSVC linker resolves ODBC
    // functions from whichever library it sees first, so with the default
    // order all ODBC calls route through the Windows ODBC Driver Manager
    // (ODBC32.dll) instead of the IBM CLI driver (DB2APP64.dll).
    // Excluding odbc32.lib forces the linker to resolve ODBC functions from
    // db2app64.lib, which routes them through DB2APP64.dll directly.
    const bindingGyp = path.join(DB2_EXT_ROOT, 'node_modules', 'ibm_db', 'binding.gyp');
    let bindingGypBackup;
    if (fs.existsSync(bindingGyp)) {
        try {
            bindingGypBackup = patchIbmDbBindingGyp(bindingGyp);
        } catch (patchErr) {
            console.warn('Warning: could not patch binding.gyp before rebuild.');
            console.warn(patchErr.message);
            bindingGypBackup = undefined;
        }
    }

    console.log(`\nStep 2/3: Recompiling native addon for Electron ${electronVersion}...`);

    // Set IS_DOWNLOADED to prevent binding.gyp from failing on missing download condition
    // This is needed for ibm_db's binding.gyp which checks IS_DOWNLOADED
    const rebuildEnv = {
        ...process.env,
        IBM_DB_HOME: process.env.IBM_DB_HOME,
        IS_DOWNLOADED: 'true',
        npm_config_IS_DOWNLOADED: 'true',
        npm_config_is_downloaded: 'true'
    };

    /** @type {Record<string, unknown>} */
    const rebuildOptions = {
        buildPath: DB2_EXT_ROOT,
        electronVersion,
        force: true,
        onlyModules: ['ibm_db']
    };
    if (rebuildEnv.GYP_MSVS_VERSION) {
        rebuildOptions.msvsVersion = rebuildEnv.GYP_MSVS_VERSION;
    }

    const rebuildScript = `
        const { rebuild } = require('@electron/rebuild');
        rebuild(${JSON.stringify(rebuildOptions)}).then(() => {
            process.exit(0);
        }).catch(err => {
            console.error(err);
            process.exit(1);
        });
    `;

    try {
        let buildMetadata = { strategy: 'electron-rebuild' };

        if (futureVisualStudioFallback) {
            buildMetadata = rebuildWithFutureVisualStudioFallback(
                electronVersion,
                rebuildEnv,
                futureVisualStudioFallback
            );
        } else {
            execFileSync(process.execPath, ['-e', rebuildScript], {
                cwd: DB2_EXT_ROOT,
                env: rebuildEnv,
                stdio: 'inherit'
            });
        }

        // Verify the rebuilt binary exists and check ODBC link target
        const nodeFile = BINDING_BINARY_PATH;
        if (fs.existsSync(nodeFile)) {
            const stat = fs.statSync(nodeFile);
            writeElectronRuntimeMarker(electronVersion, buildMetadata);
            console.log(`\n✅ ibm_db rebuilt successfully for Electron ${electronVersion}`);
            console.log(`   Binary: ${nodeFile} (${stat.size} bytes)`);

            // Quick PE check: does the addon import from DB2APP64.dll or ODBC32.dll?
            try {
                const peData = fs.readFileSync(nodeFile);
                const peStr = peData.toString('latin1');
                const usesDb2App = peStr.includes('DB2APP64.dll') || peStr.includes('db2app64.dll');
                const usesOdbc32 = peStr.includes('ODBC32.dll') || peStr.includes('ODBC32.DLL') || peStr.includes('odbc32.dll');
                if (usesDb2App && !usesOdbc32) {
                    console.log('   ✅ ODBC functions linked directly to IBM CLI driver (DB2APP64.dll).');
                } else if (usesOdbc32) {
                    console.log('   ⚠️  ODBC functions linked to Windows ODBC Driver Manager (ODBC32.dll).');
                    console.log('      This works, but requires the IBM CLI ODBC driver to be registered.');
                    console.log('      The script will attempt driver registration in the next step.');
                }
            } catch {
                // PE check is informational only
            }

            if (process.platform === 'linux') {
                const linuxLibrary = path.join(clidriverPath, 'lib', 'libdb2.so');
                if (fs.existsSync(linuxLibrary)) {
                    console.log(`   ✅ Linux CLI library detected: ${linuxLibrary}`);
                } else {
                    console.warn(`   ⚠️  Linux CLI library not found at expected path: ${linuxLibrary}`);
                }
            } else if (process.platform === 'darwin') {
                const macLibrary = path.join(clidriverPath, 'lib', 'libdb2.dylib');
                if (fs.existsSync(macLibrary)) {
                    console.log(`   ✅ macOS CLI library detected: ${macLibrary}`);
                } else {
                    console.warn(`   ⚠️  macOS CLI library not found at expected path: ${macLibrary}`);
                }
            }
        } else {
            console.log(`\n✅ electron-rebuild completed but binary not found at expected path.`);
        }
        console.log('\n   Close all VS Code windows and press F5 to launch with the updated bindings.');
    } catch (error) {
        removeElectronRuntimeMarker();
        console.error('\n❌ Failed to rebuild ibm_db for Electron. See errors above.');
        console.error('Common fixes:');
        console.error('  - Ensure Visual Studio Build Tools and Python are installed');
        console.error('  - Ensure IBM_DB_HOME points to a valid clidriver');
        console.error('  - Prefer the repo helper: npm run db2:runtime:electron');
        console.error('  - For a low-level manual rebuild, run inside extensions\\db2: npx electron-rebuild -f -w ibm_db -v ' + electronVersion);
        process.exit(1);
    } finally {
        // Restore the original binding.gyp so node_modules stay unmodified
        if (bindingGypBackup && fs.existsSync(bindingGyp)) {
            try {
                fs.writeFileSync(bindingGyp, bindingGypBackup, 'utf8');
            } catch {
                // best-effort restore
            }
        }
    }

    // Step 3: Print the optional IBM CLI registration instruction.
    // This script never changes Windows ODBC registry entries automatically.
    if (process.platform === 'win32') {
        const db2cliExe = path.join(clidriverPath, 'bin', 'db2cli.exe');
        if (fs.existsSync(db2cliExe)) {
            console.log(
                '\nStep 3/3: No ODBC driver was registered automatically.\n' +
                'If connections fail with "Data source name not found" and an administrator approves it, run\n' +
                'the following from an elevated command prompt:\n' +
                `  "${db2cliExe}" install -setup`
            );
        }
    }

    if (process.platform === 'linux' || process.platform === 'darwin') {
        const isLinux = process.platform === 'linux';
        const driverLibrary = isLinux
            ? path.join(clidriverPath, 'lib', 'libdb2.so')
            : path.join(clidriverPath, 'lib', 'libdb2.dylib');
        const defaultOdbcinstIni = isLinux
            ? '/etc/odbcinst.ini'
            : '/usr/local/etc/odbcinst.ini';

        console.log('\nStep 3/3: Verifying unixODBC registration hints for IBM CLI driver...');
        if (!fs.existsSync(driverLibrary)) {
            console.warn(
                `⚠️  Expected DB2 ODBC driver library not found: ${driverLibrary}\n` +
                '   Ensure ibm_db installer downloaded the full clidriver payload for this platform.'
            );
            return;
        }

        const driverEntry = [
            '[IBM DB2 ODBC DRIVER]',
            'Description = IBM DB2 Driver',
            `Driver = ${driverLibrary}`,
            `Setup = ${driverLibrary}`,
            'FileUsage = 1',
            ''
        ].join('\n');

        const odbcinstCandidates = isLinux
            ? ['/usr/bin/odbcinst', '/usr/local/bin/odbcinst']
            : ['/opt/homebrew/bin/odbcinst', '/usr/local/bin/odbcinst', '/usr/bin/odbcinst'];
        const odbcinstBinary = odbcinstCandidates.find(candidate => fs.existsSync(candidate));

        console.log('NOTE: If DB2 connect fails due missing unixODBC driver registration, run:');
        console.log(`  echo "${driverEntry.replace(/\n/g, '\\n')}" | sudo tee -a ${defaultOdbcinstIni}`);

        if (!odbcinstBinary) {
            console.warn('⚠️  odbcinst binary not found on PATH. Skipping automated unixODBC registration.');
            return;
        }

        try {
            execFileSync(odbcinstBinary, ['-i', '-d', '-f', '-'], {
                input: driverEntry,
                stdio: ['pipe', 'inherit', 'inherit']
            });
            console.log('   ✅ unixODBC driver registration command executed.');
        } catch (registrationError) {
            console.warn('⚠️  unixODBC registration failed (often requires sudo).');
            console.warn(`   Manual fallback: echo "<driver-entry>" | sudo tee -a ${defaultOdbcinstIni}`);
            if (registrationError && registrationError.message) {
                console.warn(`   Details: ${registrationError.message}`);
            }
        }
    }
}

main();
