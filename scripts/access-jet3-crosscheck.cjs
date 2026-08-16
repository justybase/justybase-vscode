'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

require('ts-node/register/transpile-only');
const { AccessFileSession } = require('../packages/access-file/src');
const { writeAccessSnapshotChanges } = require('../packages/access-file/src/jet/JetWriter');

const csharpRepo = process.env.UCANACCESS_CSHARP_REPO
    || 'C:\\DEV\\DEV\\source\\repos\\00_justybase\\JustyBase.UCanAccessCs';
const fixturePath = path.join(csharpRepo, 'tests', 'fixtures', 'size97.mdb');
const jackcessJar = process.env.JACKCESS_JAR
    || path.join(os.tmpdir(), 'ucanaccess-csharp-oracle', 'jackcess-5.1.5.jar');
const oracleClasses = process.env.JACKCESS_ORACLE_CLASSES
    || path.join(csharpRepo, 'tools', 'JavaOracle', 'classes');

function skip(message) {
    console.log(`Jet 3 cross-check skipped: ${message}`);
}

async function main() {
    if (process.env.ACCESS_JET3_VALIDATE !== '1') {
        skip('set ACCESS_JET3_VALIDATE=1 to run the optional Jackcess check.');
        return;
    }
    try {
        await fs.access(fixturePath);
    } catch {
        skip(`fixture not found: ${fixturePath}`);
        return;
    }
    try {
        await fs.access(jackcessJar);
        await fs.access(path.join(oracleClasses, 'DbDump.class'));
    } catch {
        skip('Jackcess 5.1.5 or the local DbDump oracle class is not available.');
        return;
    }

    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'justybase-jet3-crosscheck-'));
    const filePath = path.join(tempDir, 'size97.mdb');
    const dumpPath = path.join(tempDir, 'jackcess.json');
    try {
        await fs.copyFile(fixturePath, filePath);
        const session = await AccessFileSession.open({ filePath, readOnly: false });
        const before = await session.readTable('table1');
        await session.close();
        const snapshot = rows => ({ definition: before.definition, rows });

        await writeAccessSnapshotChanges(filePath, 'jet3', [snapshot([])], [snapshot([[1, 'hello'], [2, 'world']])]);
        await writeAccessSnapshotChanges(
            filePath,
            'jet3',
            [snapshot([[1, 'hello'], [2, 'world']])],
            [snapshot([[1, 'jet3 updated'], [2, 'world']])],
        );
        await writeAccessSnapshotChanges(
            filePath,
            'jet3',
            [snapshot([[1, 'jet3 updated'], [2, 'world']])],
            [snapshot([[1, 'jet3 updated']])],
        );

        const reopened = await AccessFileSession.open({ filePath });
        assert.deepEqual((await reopened.readTable('table1')).rows, [[1, 'jet3 updated']]);
        await reopened.close();

        try {
            execFileSync('java', [
                '-Djackcess.charset.VERSION_3=GBK',
                '-cp',
                `${jackcessJar}${path.delimiter}${oracleClasses}`,
                'DbDump',
                filePath,
                dumpPath,
            ], { encoding: 'utf8', timeout: 60000, windowsHide: true, stdio: 'pipe' });
        } catch (error) {
            const detail = error && typeof error === 'object' && 'stderr' in error ? String(error.stderr) : String(error);
            throw new Error(`Jackcess DbDump failed: ${detail}`);
        }
        const dump = await fs.readFile(dumpPath, 'utf8');
        assert.match(dump, /"rowCount": 1/);
        assert.match(dump, /jet3 updated/);
        assert.doesNotMatch(dump, /world/);
        console.log('Jet 3 cross-check passed: TS writer and Jackcess 5.1.5 agree after insert/update/delete.');
    } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
    }
}

main().catch(error => {
    console.error(error instanceof Error ? error.stack || error.message : error);
    process.exitCode = 1;
});
