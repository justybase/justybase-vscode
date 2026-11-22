'use strict';

require('tsx/cjs');

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..');
const harnessPath = path.join(repoRoot, 'scripts', 'access-com', 'access-com.ps1');
const fixturePath = path.join(repoRoot, 'src', '__tests__', 'fixtures', 'access', 'sample2007.accdb');

const { AccessFileSession } = require('../packages/access-file/src');
const { applyDdlSql } = require('../packages/access-file/src/jet/JetDdlSql');
const { addRelationship } = require('../packages/access-file/src/jet/JetDdl');
const { JetPageChannel } = require('../packages/access-file/src/jet/JetPageChannel');
const { jetLayoutFor } = require('../packages/access-file/src/jet/JetLayout');

function skip(message) {
    console.log(`ACCESS COM cross-check skipped: ${message}`);
}

function powershellCommand() {
    return process.env.ACCESS_POWERSHELL || (process.platform === 'win32' ? 'pwsh.exe' : 'pwsh');
}

function runHarness(args, extraEnv = {}) {
    return new Promise((resolve, reject) => {
        const child = spawn(powershellCommand(), [
            '-NoProfile',
            '-NonInteractive',
            '-File',
            harnessPath,
            ...args,
        ], {
            cwd: repoRoot,
            env: { ...process.env, ...extraEnv },
            windowsHide: true,
        });
        let stdout = '';
        let stderr = '';
        let settled = false;
        const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            child.kill();
            reject(new Error(`COM harness timed out: ${args.join(' ')}`));
        }, Number(process.env.ACCESS_COM_TIMEOUT_MS || 30000));

        child.stdout.setEncoding('utf8');
        child.stderr.setEncoding('utf8');
        child.stdout.on('data', chunk => { stdout += chunk; });
        child.stderr.on('data', chunk => { stderr += chunk; });
        child.on('error', error => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            reject(error);
        });
        child.on('close', code => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (code !== 0) {
                reject(new Error(`COM harness failed (${code}) for ${args.join(' ')}\n${stderr.trim()}`));
                return;
            }
            try {
                resolve(JSON.parse(stdout.trim()));
            } catch (error) {
                reject(new Error(`COM harness returned invalid JSON for ${args.join(' ')}\n${stdout}\n${stderr}`, { cause: error }));
            }
        });
    });
}

async function main() {
    if (process.platform !== 'win32') {
        skip('DAO COM is available only on Windows.');
        return;
    }
    if (process.env.ACCESS_COM_VALIDATE !== '1') {
        skip('set ACCESS_COM_VALIDATE=1 to run the opt-in Windows check.');
        return;
    }
    await fs.access(harnessPath);
    const capabilities = await runHarness(['capabilities']);
    if (!capabilities.dao) {
        skip(capabilities.error || 'no DAO DBEngine COM class is installed.');
        return;
    }
    console.log(`DAO ${capabilities.daoVersion || 'unknown'} detected`);

    const description = await runHarness(['describe', fixturePath]);
    assert.equal(description.format, 'accdb2007');
    const people = description.tables.find(table => table.name.toLowerCase() === 't_people');
    assert.ok(people, 'sample2007.accdb must contain t_people');
    assert.deepEqual(people.columns.slice(0, 2).map(column => column.name), ['id', 'name']);

    const selected = await runHarness(['select', fixturePath, 'SELECT id, name FROM t_people ORDER BY id']);
    assert.deepEqual(selected.columns, ['id', 'name']);
    assert.ok(selected.rows.length > 0, 'sample2007.accdb should contain sample rows');

    const complexFixturePath = path.join(repoRoot, 'src', '__tests__', 'fixtures', 'access', 'complex.accdb');
    const complexDescription = await runHarness(['describe', complexFixturePath]);
    const complexTable = complexDescription.tables.find(table => table.name.toLowerCase() === 'complexfixture');
    assert.ok(complexTable, 'complex.accdb must contain ComplexFixture');
    assert.equal(complexTable.columns.find(column => column.name.toLowerCase() === 'tags')?.type, 'type109');
    assert.equal(complexTable.columns.find(column => column.name.toLowerCase() === 'files')?.type, 'attachment');

    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'justybase-access-com-'));
    try {
        const createdPath = path.join(tempDir, 'crosscheck.accdb');
        const created = await runHarness(['create-db', createdPath, 'accdb2007']);
        assert.equal(created.requestedFormat, 'accdb2007');
        assert.equal(created.actualFormat, 'accdb2007');

        await runHarness(['apply-ddl', createdPath, 'CREATE TABLE parent_table (id LONG NOT NULL, CONSTRAINT pk_parent PRIMARY KEY (id))']);
        await runHarness(['apply-ddl', createdPath, 'CREATE TABLE child_table (id LONG, parent_id LONG)']);
        await runHarness(['apply-ddl', createdPath, 'CREATE TABLE identity_table (id COUNTER, name TEXT(30), CONSTRAINT pk_identity PRIMARY KEY (id))']);
        await runHarness(['add-relation', createdPath, 'rel_child_parent', 'child_table', 'parent_table', 'parent_id', 'id', '0']);
        await runHarness(['set-description', createdPath, 'child_table', 'COM description cross-check']);

        const inserted = await runHarness(['insert', createdPath, "INSERT INTO identity_table (name) VALUES ('first')"]);
        assert.equal(inserted.identity, 1);
        assert.equal(inserted.recordsAffected, 1);

        const written = await runHarness(['describe', createdPath]);
        const child = written.tables.find(table => table.name.toLowerCase() === 'child_table');
        assert.equal(child.description, 'COM description cross-check');
        assert.equal(written.relations.length, 1);
        assert.equal(written.relations[0].table, 'child_table');
        assert.equal(written.relations[0].foreignTable, 'parent_table');

        // Writer -> DAO: verify text length semantics and relationship attribute
        // bits produced by our Jet writer against real Access/DAO.
        const ourPath = path.join(tempDir, 'our-writer.accdb');
        const writeSession = await AccessFileSession.create({ filePath: ourPath, format: 'accdb2007' });
        try {
            await writeSession.writeAtomically(async context => {
                const channel = new JetPageChannel(await fs.readFile(context.stagedPath), jetLayoutFor(context.format));
                applyDdlSql(channel, 'CREATE TABLE p (id LONG, CONSTRAINT PK PRIMARY KEY (id))');
                applyDdlSql(channel, 'CREATE TABLE c1 (id LONG, pid LONG, CONSTRAINT PK PRIMARY KEY (id))');
                applyDdlSql(channel, 'CREATE TABLE c2 (id LONG, pid LONG, CONSTRAINT PK PRIMARY KEY (id))');
                applyDdlSql(channel, 'CREATE TABLE c3 (id LONG, pid LONG, CONSTRAINT PK PRIMARY KEY (id))');
                applyDdlSql(channel, 'CREATE TABLE text_t (id LONG, name TEXT(50))');
                applyDdlSql(channel, 'CREATE TABLE auto_types (id COUNTER, qty INTEGER, small SMALLINT)');
                addRelationship(channel, {
                    name: 'FK_enf', table: 'c1', columns: ['pid'], foreignTable: 'p', foreignColumns: ['id'], enforced: true,
                });
                addRelationship(channel, {
                    name: 'FK_noenf', table: 'c2', columns: ['pid'], foreignTable: 'p', foreignColumns: ['id'], enforced: false,
                });
                addRelationship(channel, {
                    name: 'FK_casc', table: 'c3', columns: ['pid'], foreignTable: 'p', foreignColumns: ['id'],
                    enforced: true, updateCascade: true, deleteCascade: true,
                });
                await fs.writeFile(context.stagedPath, channel.buffer);
            }, { verifyAllTables: true });
        } finally {
            await writeSession.close();
        }

        const ourDescription = await runHarness(['describe', ourPath]);
        const textColumn = ourDescription.tables
            .find(table => table.name.toLowerCase() === 'text_t')
            ?.columns.find(column => column.name.toLowerCase() === 'name');
        assert.equal(textColumn?.size, 50, 'TEXT(50) must be 50 characters according to DAO');
        const autoTypes = ourDescription.tables.find(table => table.name.toLowerCase() === 'auto_types');
        const autoId = autoTypes?.columns.find(column => column.name.toLowerCase() === 'id');
        const qty = autoTypes?.columns.find(column => column.name.toLowerCase() === 'qty');
        const small = autoTypes?.columns.find(column => column.name.toLowerCase() === 'small');
        assert.equal(autoId?.type, 'long');
        assert.equal((autoId?.attributes ?? 0) & 16, 16, 'COUNTER must round-trip as a DAO AutoNumber');
        assert.equal(qty?.type, 'long', 'INTEGER must be a 4-byte Long Integer');
        assert.equal(qty?.size, 4);
        assert.equal(small?.type, 'int', 'SMALLINT must be a 2-byte Integer');
        assert.equal(small?.size, 2);
        const relationsByName = new Map(ourDescription.relations.map(relation => [relation.name, relation]));
        assert.equal(relationsByName.get('FK_enf')?.attributes, 0);
        assert.equal(relationsByName.get('FK_noenf')?.attributes, 2);
        assert.equal(relationsByName.get('FK_casc')?.attributes, 4352);

        // DROP TABLE must also remove the relationship rows that reference it.
        const dropSession = await AccessFileSession.open({ filePath: ourPath, readOnly: false });
        try {
            await dropSession.writeAtomically(async context => {
                const channel = new JetPageChannel(await fs.readFile(context.stagedPath), jetLayoutFor(context.format));
                applyDdlSql(channel, 'DROP TABLE c3');
                await fs.writeFile(context.stagedPath, channel.buffer);
            }, { verifyAllTables: true });
        } finally {
            await dropSession.close();
        }
        const afterDrop = await runHarness(['describe', ourPath]);
        assert.deepEqual(
            afterDrop.relations.map(relation => relation.name).sort(),
            ['FK_enf', 'FK_noenf'],
        );

        console.log('ACCESS COM cross-check passed: describe, complex metadata, SELECT, CREATE, FK, Description, @@IDENTITY, TEXT length, AutoNumber/INTEGER widths, relationship flags and DROP TABLE cleanup.');
    } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
    }
}

main().catch(error => {
    console.error(error instanceof Error ? error.stack || error.message : error);
    process.exitCode = 1;
});
