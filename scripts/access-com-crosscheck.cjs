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
const { addRelationship, createTable } = require('../packages/access-file/src/jet/JetDdl');
const { JetPageChannel } = require('../packages/access-file/src/jet/JetPageChannel');
const { jetLayoutFor } = require('../packages/access-file/src/jet/JetLayout');

// AccessConnection imports `vscode` for one settings lookup; the DAO gate runs
// outside the extension host, so stub only that surface.
const Module = require('node:module');
const originalLoad = Module._load;
Module._load = function load(request, parent, isMain) {
    if (request === 'vscode') {
        return { workspace: { getConfiguration: () => ({ get: (_key, fallback) => fallback }) } };
    }
    return originalLoad.call(this, request, parent, isMain);
};
const { AccessConnection } = require('../extensions/access/src/accessConnection');

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

        // The schema tree reads a table description through the
        // `_access_metadata.table_comment` marker; a description written by
        // Access itself must come back through that marker unchanged.
        const descriptionConnection = new AccessConnection({
            host: '',
            database: createdPath,
            user: '',
            options: { readOnly: true },
        });
        try {
            await descriptionConnection.connect();
            const commentReader = await descriptionConnection
                .createCommand("SELECT * FROM _access_metadata.table_comment WHERE TABLE = 'child_table'")
                .executeReader();
            try {
                assert.equal(await commentReader.read(), true);
                assert.equal(commentReader.getValue(0), 'COM description cross-check');
            } finally {
                await commentReader.close();
            }
            const tablesReader = await descriptionConnection
                .createCommand("SELECT * FROM _access_metadata.tables WHERE TABLE = 'child_table'")
                .executeReader();
            try {
                const descriptions = new Map();
                while (await tablesReader.read()) {
                    descriptions.set(String(tablesReader.getValue(0)), tablesReader.getValue(4));
                }
                assert.equal(descriptions.get('child_table'), 'COM description cross-check');
            } finally {
                await tablesReader.close();
            }
        } finally {
            await descriptionConnection.close();
        }

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
                applyDdlSql(channel, 'CREATE TABLE property_t (pk_text TEXT(50) PRIMARY KEY, with_default TEXT(10) DEFAULT "abc", required_only TEXT(10) NOT NULL, n LONG DEFAULT (3))');
                applyDdlSql(channel, 'CREATE TABLE call_default_t (id LONG, d DATETIME DEFAULT Date(), s TEXT(10) DEFAULT \'z\')');
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

        // Required and DefaultValue are DAO field properties stored in the Jet
        // property map. A column may carry DEFAULT without being Required, and a
        // text primary key may be Required=False while its index still enforces
        // non-null values.
        const propertyTable = ourDescription.tables.find(table => table.name.toLowerCase() === 'property_t');
        assert.ok(propertyTable, 'property_t must exist in the writer output');
        const requiredDefault = propertyTable.columns.find(column => column.name.toLowerCase() === 'with_default');
        assert.equal(requiredDefault?.required, false, 'DEFAULT alone must not set Required');
        assert.equal(requiredDefault?.defaultValue, '"abc"');
        const requiredOnly = propertyTable.columns.find(column => column.name.toLowerCase() === 'required_only');
        assert.equal(requiredOnly?.required, true, 'NOT NULL must round-trip as DAO Required');
        const plainPrimaryKey = propertyTable.columns.find(column => column.name.toLowerCase() === 'pk_text');
        assert.equal(plainPrimaryKey?.required, false, 'a text primary key must stay Required=False');
        const numericDefault = propertyTable.columns.find(column => column.name.toLowerCase() === 'n');
        assert.equal(numericDefault?.defaultValue, '(3)');

        // End-to-end: Access itself must apply the stored DefaultValue when an
        // INSERT omits the column, exactly like the SQL mirror does.
        const propertyInsert = await runHarness(['insert', ourPath, 'INSERT INTO property_t (pk_text, required_only) VALUES (\'k\', \'r\')']);
        assert.equal(propertyInsert.recordsAffected, 1);
        const applied = await runHarness(['select', ourPath, 'SELECT pk_text, with_default, n FROM property_t']);
        assert.deepEqual(applied.rows, [{ pk_text: 'k', with_default: 'abc', n: 3 }]);

        // A zero-argument Access function must also survive the property map
        // and be evaluated by Access itself.
        const callDefaultInsert = await runHarness(['insert', ourPath, 'INSERT INTO call_default_t (id) VALUES (1)']);
        assert.equal(callDefaultInsert.recordsAffected, 1);
        const callDefaultRow = await runHarness(['select', ourPath, 'SELECT id, d, s FROM call_default_t']);
        assert.equal(callDefaultRow.rows.length, 1);
        assert.equal(callDefaultRow.rows[0].s, 'z');
        assert.match(String(callDefaultRow.rows[0].d), /\d{4}-\d{2}-\d{2}/);

        const relationsByName = new Map(ourDescription.relations.map(relation => [relation.name, relation]));
        assert.equal(relationsByName.get('FK_enf')?.attributes, 0);
        assert.equal(relationsByName.get('FK_noenf')?.attributes, 2);
        assert.equal(relationsByName.get('FK_casc')?.attributes, 4352);

        // --- ValidationRule / AllowZeroLength parity -------------------------
        // Access keeps these in the property map: field rules in the column
        // block, the record-level rule in the table block.  The reader must
        // report them and the SQL mirror must reject exactly what Access
        // rejects, so the two verdict lists are compared entry by entry.
        const rulesPath = path.join(tempDir, 'rules.accdb');
        await runHarness(['create-db', rulesPath, 'accdb2007']);
        await runHarness(['apply-ddl', rulesPath, 'CREATE TABLE rules_t (id LONG, num LONG, label TEXT(20))']);
        await runHarness(['apply-ddl', rulesPath, 'CREATE TABLE zero_t (id LONG, a TEXT(20), b TEXT(20))']);
        await runHarness(['set-property', rulesPath, 'rules_t', 'num', 'ValidationRule', '>0']);
        await runHarness(['set-property', rulesPath, 'rules_t', 'num', 'ValidationText', 'must be positive']);
        // The record-level rule lives on the TableDef, so the field argument is
        // the '-' placeholder.
        await runHarness(['set-property', rulesPath, 'rules_t', '-', 'ValidationRule', 'Not ([num] = 7)']);
        await runHarness(['set-property', rulesPath, 'zero_t', 'a', 'AllowZeroLength', '0']);

        const rulesDescription = await runHarness(['describe', rulesPath]);
        const rulesTable = rulesDescription.tables.find(table => table.name.toLowerCase() === 'rules_t');
        const numColumn = rulesTable?.columns.find(column => column.name.toLowerCase() === 'num');
        assert.equal(numColumn?.validationRule, '>0');
        assert.equal(numColumn?.validationText, 'must be positive');
        const rulesSession = await AccessFileSession.open({ filePath: rulesPath });
        let rulesDefinition;
        try {
            rulesDefinition = rulesSession.getTableDefinition('rules_t');
            // Field rule, field message and the record-level rule must all come
            // back from the property map, not from guesswork.
            assert.equal(rulesDefinition.columns[1].validationRule, numColumn?.validationRule);
            assert.equal(rulesDefinition.columns[1].validationText, numColumn?.validationText);
            assert.equal(rulesDefinition.validationRule, rulesTable?.validationRule);
            assert.equal(rulesDefinition.columns[2].validationRule, undefined, 'a column without a rule must stay undefined');
        } finally {
            await rulesSession.close();
        }
        const zeroDescription = await runHarness(['describe', rulesPath]);
        const zeroTable = zeroDescription.tables.find(table => table.name.toLowerCase() === 'zero_t');
        assert.equal(zeroTable?.columns.find(column => column.name.toLowerCase() === 'a')?.allowZeroLength, false);
        const zeroSession = await AccessFileSession.open({ filePath: rulesPath });
        try {
            const zeroDefinition = zeroSession.getTableDefinition('zero_t');
            assert.equal(zeroDefinition.columns[1].allowZeroLength, false, 'explicit AllowZeroLength=False must be read');
            assert.equal(zeroDefinition.columns[2].allowZeroLength, undefined, 'an absent property must stay undefined');
        } finally {
            await zeroSession.close();
        }

        // Verdict parity: the same INSERTs run through DAO and the mirror.
        // 7 is rejected by the record-level rule (`Not ([num] = 7)`), while
        // NULL passes both the column rule and the table rule.
        const ruleInserts = ['NULL', '-1', '0', '2', '7', '50'].map(value =>
            `INSERT INTO rules_t (id, num) VALUES (1, ${value})`);
        const zeroInserts = [
            "INSERT INTO zero_t (id, a, b) VALUES (1, '', 'x')",
            "INSERT INTO zero_t (id, a, b) VALUES (2, NULL, 'x')",
            "INSERT INTO zero_t (id, a, b) VALUES (3, 'x', 'x')",
            "INSERT INTO zero_t (id, a, b) VALUES (4, 'x', '')",
        ];
        const daoVerdicts = (await runHarness(['try-batch', rulesPath, ruleInserts.concat(zeroInserts).join('\n')]))
            .results.map(entry => ({ sql: entry.sql, accepted: entry.accepted, error: entry.error }));

        // Run the same INSERTs through the product path: AccessConnection drives
        // the DuckDB mirror and, for accepted rows, the staged Jet writer.
        const mirrorVerdicts = [];
        const connection = new AccessConnection({
            host: '',
            database: rulesPath,
            user: '',
            options: { readOnly: false },
        });
        await connection.connect();
        try {
            for (const sql of ruleInserts.concat(zeroInserts)) {
                try {
                    await connection.createCommand(sql).execute();
                    mirrorVerdicts.push({ sql, accepted: true });
                } catch (error) {
                    mirrorVerdicts.push({ sql, accepted: false, error: String(error) });
                }
            }
        } finally {
            await connection.close();
        }

        assert.equal(mirrorVerdicts.length, daoVerdicts.length);
        for (let index = 0; index < daoVerdicts.length; index++) {
            assert.equal(
                mirrorVerdicts[index].accepted,
                daoVerdicts[index].accepted,
                `mirror and Access disagree on: ${daoVerdicts[index].sql}\n`
                + `Access: ${daoVerdicts[index].error ?? 'accepted'}\n`
                + `mirror: ${mirrorVerdicts[index].error ?? 'accepted'}`,
            );
        }
        // The ValidationText must be what Access reports back.
        const rejectedZero = daoVerdicts.find(entry => !entry.accepted);
        assert.match(rejectedZero?.error ?? '', /must be positive|zero-length|zerowej/i);
        const rejectedRule = daoVerdicts.find(entry => entry.sql.includes('VALUES (1, 7)'));
        assert.equal(rejectedRule?.accepted, false, 'the record-level rule must reject 7');

        // Writer -> DAO: the property-map writer supports rule and zero-length
        // properties even though the SQL DDL surface has no syntax for them
        // (Access rejects CHECK), so this is verified at the library boundary.
        const writerRulesPath = path.join(tempDir, 'writer-rules.accdb');
        await runHarness(['create-db', writerRulesPath, 'accdb2007']);
        const writerRulesSession = await AccessFileSession.open({ filePath: writerRulesPath, readOnly: false });
        try {
            await writerRulesSession.writeAtomically(async context => {
                const channel = new JetPageChannel(await fs.readFile(context.stagedPath), jetLayoutFor(context.format));
                createTable(channel, 'writer_rules', [
                    { name: 'id', type: 0x04 },
                    { name: 'num', type: 0x04, validationRule: '>0', validationText: 'must be positive' },
                    { name: 'code', type: 0x0a, length: 20, allowZeroLength: false },
                ]);
                await fs.writeFile(context.stagedPath, channel.buffer);
            }, { verifyAllTables: true });
        } finally {
            await writerRulesSession.close();
        }
        const writerRulesDescribe = await runHarness(['describe', writerRulesPath]);
        const writerRulesTable = writerRulesDescribe.tables.find(table => table.name.toLowerCase() === 'writer_rules');
        assert.equal(writerRulesTable?.columns.find(column => column.name.toLowerCase() === 'num')?.validationRule, '>0');
        assert.equal(writerRulesTable?.columns.find(column => column.name.toLowerCase() === 'code')?.allowZeroLength, false);
        const writerRuleVerdicts = await runHarness(['try-batch', writerRulesPath, [
            'INSERT INTO writer_rules (id, num, code) VALUES (1, -1, \'x\')',
            'INSERT INTO writer_rules (id, num, code) VALUES (2, 5, \'x\')',
            'INSERT INTO writer_rules (id, num, code) VALUES (3, 5, \'\')',
            'INSERT INTO writer_rules (id, num, code) VALUES (4, 5, NULL)',
        ].join('\n')]);
        assert.equal(writerRuleVerdicts.results[0].accepted, false, 'Access must reject a rule violation written by us');
        assert.equal(writerRuleVerdicts.results[1].accepted, true);
        assert.equal(writerRuleVerdicts.results[2].accepted, false, 'Access must reject an empty string when AllowZeroLength=False');
        assert.equal(writerRuleVerdicts.results[3].accepted, true, 'NULL stays allowed when AllowZeroLength=False');

        // --- Key and relationship parity ---------------------------------
        // Access compares text keys ignoring case and trailing spaces, keeps
        // duplicate NULL keys in a unique index, rejects a partially NULL
        // composite key, and enforces relationships.  The mirror must reach the
        // same verdict as DAO for every statement below.  The two engines run
        // against separate copies of the schema: otherwise the DAO pass would
        // leave rows behind for the mirror pass to trip over.
        const keysSchema = [
            'CREATE TABLE keys_pk (code TEXT(20) NOT NULL, n LONG, CONSTRAINT pk_keys PRIMARY KEY (code))',
            'CREATE TABLE keys_unique (id LONG, code TEXT(20))',
            'CREATE UNIQUE INDEX UX_keys_unique ON keys_unique (code)',
            'CREATE TABLE keys_comp (id LONG, a TEXT(10), b TEXT(10))',
            'CREATE UNIQUE INDEX UX_keys_comp ON keys_comp (a, b)',
            'CREATE TABLE keys_required (id LONG, code TEXT(20))',
            'CREATE INDEX IX_keys_required ON keys_required (code) WITH DISALLOW NULL',
            'CREATE TABLE keys_parent (id LONG NOT NULL, CONSTRAINT pk_keys_parent PRIMARY KEY (id))',
            'CREATE TABLE keys_child (id LONG, pid LONG)',
            'CREATE TABLE keys_number_parent (id LONG NOT NULL, CONSTRAINT pk_keys_np PRIMARY KEY (id))',
            'CREATE TABLE keys_number_child (id LONG, pid LONG)',
        ];
        const keysPath = path.join(tempDir, 'keys-dao.accdb');
        const keysMirrorPath = path.join(tempDir, 'keys-mirror.accdb');
        for (const filePath of [keysPath, keysMirrorPath]) {
            await runHarness(['create-db', filePath, 'accdb2007']);
            for (const ddl of keysSchema) {
                await runHarness(['apply-ddl', filePath, ddl]);
            }
            await runHarness(['add-relation', filePath, 'FK_keys', 'keys_child', 'keys_parent', 'pid', 'id', '0']);
            await runHarness(['add-relation', filePath, 'FK_keys_number', 'keys_number_child', 'keys_number_parent', 'pid', 'id', '0']);
        }

        const keyStatements = [
            "INSERT INTO keys_pk (code, n) VALUES ('a', 1)",
            "INSERT INTO keys_pk (code, n) VALUES ('A', 2)",
            "INSERT INTO keys_pk (code, n) VALUES ('a ', 3)",
            "INSERT INTO keys_pk (code, n) VALUES (' a', 4)",
            'INSERT INTO keys_pk (code, n) VALUES (NULL, 5)',
            "INSERT INTO keys_unique (id, code) VALUES (1, 'a')",
            "INSERT INTO keys_unique (id, code) VALUES (2, 'A')",
            "INSERT INTO keys_unique (id, code) VALUES (3, 'a ')",
            'INSERT INTO keys_unique (id, code) VALUES (4, NULL)',
            'INSERT INTO keys_unique (id, code) VALUES (5, NULL)',
            "INSERT INTO keys_comp (id, a, b) VALUES (1, 'k', NULL)",
            "INSERT INTO keys_comp (id, a, b) VALUES (2, 'k', NULL)",
            "INSERT INTO keys_comp (id, a, b) VALUES (3, NULL, 'v')",
            "INSERT INTO keys_comp (id, a, b) VALUES (4, 'k', 'v')",
            "INSERT INTO keys_comp (id, a, b) VALUES (5, 'K', 'V')",
            "INSERT INTO keys_required (id, code) VALUES (1, 'a')",
            "INSERT INTO keys_required (id, code) VALUES (2, 'a')",
            'INSERT INTO keys_required (id, code) VALUES (3, NULL)',
            'INSERT INTO keys_parent (id) VALUES (1)',
            'INSERT INTO keys_child (id, pid) VALUES (1, 1)',
            'INSERT INTO keys_child (id, pid) VALUES (2, 99)',
            'INSERT INTO keys_child (id, pid) VALUES (3, NULL)',
            'DELETE FROM keys_parent WHERE id = 1',
            'INSERT INTO keys_number_parent (id) VALUES (1)',
            'INSERT INTO keys_number_child (id, pid) VALUES (1, 1)',
            'INSERT INTO keys_number_child (id, pid) VALUES (2, 99)',
        ];
        const keyDaoVerdicts = (await runHarness(['try-batch', keysPath, keyStatements.join('\n')]))
            .results.map(entry => ({ sql: entry.sql, accepted: entry.accepted, error: entry.error }));

        const keyConnection = new AccessConnection({
            host: '',
            database: keysMirrorPath,
            user: '',
            options: { readOnly: false },
        });
        const keyMirrorVerdicts = [];
        await keyConnection.connect();
        try {
            for (const sql of keyStatements) {
                try {
                    await keyConnection.createCommand(sql).execute();
                    keyMirrorVerdicts.push({ sql, accepted: true });
                } catch (error) {
                    keyMirrorVerdicts.push({ sql, accepted: false, error: String(error) });
                }
            }
        } finally {
            await keyConnection.close();
        }

        assert.equal(keyMirrorVerdicts.length, keyDaoVerdicts.length);
        for (let index = 0; index < keyDaoVerdicts.length; index++) {
            assert.equal(
                keyMirrorVerdicts[index].accepted,
                keyDaoVerdicts[index].accepted,
                `mirror and Access disagree on key behaviour: ${keyDaoVerdicts[index].sql}\n`
                + `Access: ${keyDaoVerdicts[index].error ?? 'accepted'}\n`
                + `mirror: ${keyMirrorVerdicts[index].error ?? 'accepted'}`,
            );
        }
        const duplicateNullVerdict = keyDaoVerdicts.find(entry => entry.sql.includes('keys_unique (id, code) VALUES (5, NULL)'));
        assert.equal(duplicateNullVerdict?.accepted, true, 'Access keeps duplicate NULL keys in a unique index');
        const orphanVerdict = keyDaoVerdicts.find(entry => entry.sql.includes('keys_child (id, pid) VALUES (2, 99)'));
        assert.equal(orphanVerdict?.accepted, false, 'Access rejects an orphan child row');
        const numberOrphanVerdict = keyDaoVerdicts.find(entry => entry.sql.includes('keys_number_child (id, pid) VALUES (2, 99)'));
        assert.equal(numberOrphanVerdict?.accepted, false, 'Access rejects a numeric orphan too');

        // The rows the mirror accepted must reach the file unchanged, so a
        // later DAO read sees the same data the editor produced.
        const keysSession = await AccessFileSession.open({ filePath: keysMirrorPath });
        let keysDefinition;
        let keysRows;
        try {
            keysDefinition = keysSession.getTableDefinition('keys_comp');
            keysRows = (await keysSession.readTable('keys_comp')).rows;
        } finally {
            await keysSession.close();
        }
        assert.deepEqual(
            keysDefinition.columns.map(column => column.name),
            ['id', 'a', 'b'],
        );
        assert.deepEqual(keysRows.map(row => [row[0], row[1], row[2]]), [
            [1, 'k', null],
            [2, 'k', null],
            [3, null, 'v'],
            [4, 'k', 'v'],
        ]);
        const storedFileVerdicts = await runHarness(['try-batch', keysMirrorPath, [
            "INSERT INTO keys_unique (id, code) VALUES (9, 'A')",
            "INSERT INTO keys_comp (id, a, b) VALUES (9, 'K', 'V')",
            'INSERT INTO keys_child (id, pid) VALUES (9, 99)',
            'DELETE FROM keys_number_parent WHERE id = 1',
            'SELECT COUNT(*) FROM keys_unique',
        ].join('\n')]);
        // Access must reject exactly what the mirror already rejected while it
        // wrote the file: the case-only duplicate, the orphan and the cascade-
        // less parent delete.
        assert.equal(storedFileVerdicts.results[0].accepted, false);
        assert.equal(storedFileVerdicts.results[1].accepted, false);
        assert.equal(storedFileVerdicts.results[2].accepted, false);
        assert.equal(storedFileVerdicts.results[3].accepted, false);
        const keysDescription = await runHarness(['describe', keysMirrorPath]);
        const compTable = keysDescription.tables.find(table => table.name.toLowerCase() === 'keys_comp');
        assert.equal(compTable?.indexes.find(index => index.name === 'UX_keys_comp')?.unique, true);

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

        console.log('ACCESS COM cross-check passed: describe, complex metadata, SELECT, CREATE, FK, Description, @@IDENTITY, TEXT length, AutoNumber/INTEGER widths, Required/DefaultValue/AllowZeroLength/ValidationRule properties, mirror rule parity, key/uniqueness/relationship verdict parity, relationship flags and DROP TABLE cleanup.');
    } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
    }
}

main().catch(error => {
    console.error(error instanceof Error ? error.stack || error.message : error);
    process.exitCode = 1;
});
