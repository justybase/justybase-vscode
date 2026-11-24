'use strict';

/**
 * DDL replay cross-check against JustyBase.UCanAccessCs.
 *
 * Jackcess (the Java reference used by access-java-read-parity.cjs) is the
 * upstream file-format implementation. JustyBase.UCanAccessCs is a pinned C#
 * port with an independent DDL parser/writer, so replaying the extension's
 * generated CREATE TABLE statements through it checks that the DDL surface is
 * executable and that column types, lengths, AutoNumber and Required flags
 * survive into a newly created file.
 *
 * This intentionally does not duplicate value-level read parity: the C# port
 * derives from the same format lineage as Jackcess, while DDL replay is the
 * area where it adds distinct coverage.
 *
 * Requires: .NET SDK 10+ and the pinned checkout from
 * tools/access-ddl-compare/bootstrap.sh. Run locally with
 * `npm run test:access:csharp-ddl`.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

require('tsx/cjs');

const Module = require('node:module');
const { installAccessFileSourceHook } = require('./access-file-source-runtime.cjs');
const originalLoad = Module._load;
Module._load = function load(request, parent, isMain) {
    if (request === 'vscode') {
        return { workspace: { getConfiguration: () => ({ get: (_key, fallback) => fallback }) } };
    }
    return originalLoad.call(this, request, parent, isMain);
};
// The extension imports the published `@justybase/access-file` name, whose
// entry point is `dist/index.js`; a clean checkout has no dist/, so resolve the
// specifier to the package sources that `tsx` compiles for this script.
installAccessFileSourceHook(Module);

const { AccessConnection } = require('../extensions/access/src/accessConnection');
const { accessDdlProvider } = require('../extensions/access/src/accessDdlProvider');
const { AccessFileSession } = require('../packages/access-file/src');

const REPO_ROOT = path.join(__dirname, '..');
const COMPARE_DIR = path.join(REPO_ROOT, 'tools', 'access-ddl-compare');
const FIXTURE_DIR = path.join(REPO_ROOT, 'src', '__tests__', 'fixtures', 'access');
const CASES = [
    { file: 'accessLike.mdb', version: '2003' },
    { file: 'sample2003.mdb', version: '2003' },
    { file: 'sample2007.accdb', version: '2007' },
    { file: 'sample_polish.accdb', version: '2007' },
    { file: 'functionsV2003.mdb', version: '2003' },
];

function run(command, args) {
    return spawnSync(command, args, { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

function findDotnet() {
    const probe = run('dotnet', ['--version']);
    return probe.status === 0 ? 'dotnet' : null;
}

async function generateFixtureDdl(filePath) {
    const session = await AccessFileSession.open({ filePath });
    let tableNames;
    try {
        tableNames = session.listTables()
            .filter(table => !table.columns.some(column => column.accessType === 'complex'))
            .map(table => table.name);
    } finally {
        await session.close();
    }

    const connection = new AccessConnection({
        host: '',
        database: filePath,
        user: '',
        password: undefined,
        options: { readOnly: true },
    });
    await connection.connect();
    try {
        const statements = [];
        for (const tableName of tableNames) {
            statements.push(await accessDdlProvider.generateTableDDL(connection, 'default', 'default', tableName));
        }
        return statements.join('\n\n');
    } finally {
        await connection.close();
    }
}

function replay(source, ddl, version) {
    return run('dotnet', [
        'run',
        '--no-build',
        '--project',
        path.join('tools', 'access-ddl-compare'),
        '--',
        '--source',
        source,
        '--ddl',
        ddl,
        '--version',
        version,
    ]);
}

async function main() {
    const dotnet = findDotnet();
    if (!dotnet) {
        console.log('SKIP access C# DDL replay: no .NET SDK found.');
        return;
    }
    if (!fs.existsSync(path.join(COMPARE_DIR, '.clone', 'UCanAccess.slnx'))) {
        console.log('SKIP access C# DDL replay: run tools/access-ddl-compare/bootstrap.sh first.');
        return;
    }

    const build = run(dotnet, ['build', path.join('tools', 'access-ddl-compare')]);
    if (build.status !== 0) {
        throw new Error(`dotnet build failed:\n${build.stdout}\n${build.stderr}`);
    }

    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'justybase-access-csharp-ddl-'));
    let tableCount = 0;
    try {
        for (const testCase of CASES) {
            const source = path.join(FIXTURE_DIR, testCase.file);
            if (!fs.existsSync(source)) {
                throw new Error(`Missing fixture ${source}`);
            }
            const ddlText = await generateFixtureDdl(source);
            if (!ddlText.trim()) {
                continue;
            }
            tableCount += (ddlText.match(/CREATE TABLE /g) ?? []).length;
            const ddlPath = path.join(workDir, `${testCase.file}.sql`);
            fs.writeFileSync(ddlPath, ddlText, 'utf8');
            const result = replay(source, ddlPath, testCase.version);
            if (result.status !== 0) {
                throw new Error(`DDL replay failed for ${testCase.file}:\n${result.stdout}\n${result.stderr}`);
            }
        }
    } finally {
        fs.rmSync(workDir, { recursive: true, force: true });
    }

    console.log(`OK access C# DDL replay: ${CASES.length} fixtures, ${tableCount} tables recreated and matched.`);
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
