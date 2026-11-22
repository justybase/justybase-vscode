'use strict';

/**
 * Read-parity cross-check: dumps every Access fixture with Jackcess (an
 * independent implementation of the MDB/ACCDB file format) and compares the
 * result with the JustyBase reader.
 *
 * This complements access-java-crosscheck.cjs, which verifies that Jackcess can
 * read files written by the TypeScript writer. Together they cover both
 * directions: our reader against a reference reader, and our writer against a
 * reference reader.
 *
 * Requires: JDK 11+ and the bootstrapped tools/access-java-verify checkout.
 * Run locally with `npm run test:access:read-parity`.
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO_ROOT = path.join(__dirname, '..');
const VERIFY_DIR = path.join(REPO_ROOT, 'tools', 'access-java-verify');
const FIXTURE_DIR = path.join(REPO_ROOT, 'src', '__tests__', 'fixtures', 'access');
const DIST_SESSION = path.join(REPO_ROOT, 'packages', 'access-file', 'dist');

const JACKCESS_TO_ACCESS_TYPE = Object.freeze({
    BOOLEAN: 'boolean',
    BYTE: 'byte',
    INT: 'integer',
    LONG: 'long',
    BIG_INT: 'bigint',
    MONEY: 'currency',
    FLOAT: 'float',
    DOUBLE: 'double',
    NUMERIC: 'numeric',
    SHORT_DATE_TIME: 'datetime',
    EXT_DATE_TIME: 'datetimextended',
    BINARY: 'binary',
    TEXT: 'text',
    MEMO: 'memo',
    OLE: 'ole',
    GUID: 'repid',
    COMPLEX_TYPE: 'complex',
});

function findJava() {
    if (process.env.JAVA_HOME) {
        const candidate = path.join(process.env.JAVA_HOME, 'bin', 'java');
        if (fs.existsSync(candidate)) return candidate;
    }
    const probe = spawnSync('java', ['-version'], { encoding: 'utf8' });
    return probe.status === 0 ? 'java' : null;
}

function findBash() {
    if (process.platform !== 'win32') return 'bash';
    const candidates = [
        path.join(process.env['ProgramFiles'] || 'C:\\Program Files', 'Git', 'bin', 'bash.exe'),
        path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Git', 'bin', 'bash.exe'),
    ];
    for (const candidate of candidates) {
        if (fs.existsSync(candidate)) return candidate;
    }
    return 'bash';
}

function bashPath(value) {
    return process.platform === 'win32' ? value.replace(/\\/g, '/') : value;
}

function run(command, args) {
    const result = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    if (result.status !== 0) {
        throw new Error(`${command} ${args.join(' ')} failed:\n${result.stderr || result.stdout}`);
    }
    return result.stdout;
}

function classPath() {
    const jars = fs.readdirSync(path.join(VERIFY_DIR, 'lib'))
        .filter(name => name.endsWith('.jar'))
        .map(name => path.join(VERIFY_DIR, 'lib', name));
    return [path.join(VERIFY_DIR, 'classes'), ...jars].join(path.delimiter);
}

function unescapeField(value) {
    let output = '';
    for (let index = 0; index < value.length; index++) {
        const character = value[index];
        if (character !== '\\') {
            output += character;
            continue;
        }
        const next = value[++index];
        if (next === 'n') output += '\n';
        else if (next === 'r') output += '\r';
        else if (next === 't') output += '\t';
        else if (next === '\\') output += '\\';
        else output += next ?? '';
    }
    return output;
}

function parseParityDump(text) {
    const tables = new Map();
    for (const line of text.split(/\r?\n/)) {
        if (!line) continue;
        const fields = line.split('\t');
        const kind = fields[0];
        if (kind === 'TABLE') {
            const name = unescapeField(fields[1] ?? '');
            tables.set(name, {
                name,
                rowCount: Number(fields[2] ?? '0'),
                columns: [],
                indexes: [],
                rows: [],
            });
            continue;
        }
        const tableName = unescapeField(fields[1] ?? '');
        const table = tables.get(tableName);
        if (!table) continue;
        if (kind === 'COLUMN') {
            table.columns.push({
                name: unescapeField(fields[2] ?? ''),
                type: fields[3] ?? '',
                length: Number(fields[4] ?? '0'),
                lengthInUnits: Number(fields[5] ?? '0'),
                precision: Number(fields[6] ?? '0'),
                scale: Number(fields[7] ?? '0'),
                autoNumber: fields[8] === 'true',
            });
            continue;
        }
        if (kind === 'INDEX') {
            table.indexes.push({
                name: unescapeField(fields[2] ?? ''),
                primaryKey: fields[3] === 'true',
                unique: fields[4] === 'true',
                required: fields[5] === 'true',
                ignoreNulls: fields[6] === 'true',
                columns: (fields[7] ?? '').split(',').filter(Boolean),
            });
            continue;
        }
        if (kind === 'ROW') {
            table.rows.push(fields.slice(2).map(unescapeField));
        }
    }
    return tables;
}

function normalizeDecimal(value) {
    let text = value.trim();
    let sign = '';
    if (text.startsWith('-') || text.startsWith('+')) {
        sign = text[0] === '-' ? '-' : '';
        text = text.slice(1);
    }
    const [integerPart = '0', fractionPart = ''] = text.split('.');
    const integer = integerPart.replace(/^0+(?=\d)/, '');
    const fraction = fractionPart.replace(/0+$/, '');
    return `${sign}${integer}${fraction ? `.${fraction}` : ''}`;
}

function normalizeDateTime(value) {
    const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?$/.exec(value);
    if (!match) return value;
    const fraction = (match[7] ?? '').padEnd(3, '0').slice(0, 3);
    return `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6] ?? '00'}.${fraction}`;
}

function normalizeJackcessValue(value, columnType) {
    if (value === 'NULL') return 'NULL';
    if (columnType === 'currency' || columnType === 'numeric') {
        return `DEC:${normalizeDecimal(value.startsWith('DEC:') ? value.slice(4) : value)}`;
    }
    if (columnType === 'datetime' || columnType === 'datetimextended') {
        return `DT:${normalizeDateTime(value.startsWith('DT:') ? value.slice(3) : value)}`;
    }
    if (columnType === 'repid') {
        return value.replace(/[{}]/g, '').toLowerCase();
    }
    return value;
}

function normalizeOurValue(value, column) {
    if (value === null || value === undefined) return 'NULL';
    if (column.accessType === 'currency' || column.accessType === 'numeric') {
        return `DEC:${normalizeDecimal(String(value))}`;
    }
    if (value instanceof Date) {
        const pad = (input, width = 2) => String(input).padStart(width, '0');
        return `DT:${value.getUTCFullYear()}-${pad(value.getUTCMonth() + 1)}-${pad(value.getUTCDate())}`
            + `T${pad(value.getUTCHours())}:${pad(value.getUTCMinutes())}:${pad(value.getUTCSeconds())}`
            + `.${pad(value.getUTCMilliseconds(), 3)}`;
    }
    if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
        return `BIN:${Buffer.from(value).toString('hex')}`;
    }
    if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
    if (column.accessType === 'repid') return String(value).replace(/[{}]/g, '').toLowerCase();
    return String(value);
}

function compareRows(jackcessTable, ourRows, ourDefinition) {
    const problems = [];
    const expected = jackcessTable.rows
        .map(row => row.map((value, index) => normalizeJackcessValue(
            value,
            JACKCESS_TO_ACCESS_TYPE[jackcessTable.columns[index]?.type ?? ''] ?? '',
        )).join('\u0001'))
        .sort();
    const actual = ourRows.rows
        .map(row => row.map((value, index) => normalizeOurValue(value, ourDefinition.columns[index])).join('\u0001'))
        .sort();
    if (expected.length !== actual.length) {
        problems.push(`row count ${actual.length} vs Jackcess ${expected.length}`);
        return problems;
    }
    for (let index = 0; index < expected.length; index++) {
        if (expected[index] === actual[index]) continue;
        const expectedCells = expected[index].split('\u0001');
        const actualCells = actual[index].split('\u0001');
        for (let columnIndex = 0; columnIndex < Math.max(expectedCells.length, actualCells.length); columnIndex++) {
            if (expectedCells[columnIndex] === actualCells[columnIndex]) continue;
            const columnName = ourDefinition.columns[columnIndex]?.name ?? `#${columnIndex}`;
            problems.push(`row[${index}].${columnName}: ${JSON.stringify(actualCells[columnIndex])} vs ${JSON.stringify(expectedCells[columnIndex])}`);
        }
        break;
    }
    return problems;
}

function compareTable(jackcessTable, ourDefinition, ourIndexes, ourRows) {
    const problems = [];
    const expectedColumns = jackcessTable.columns;
    if (expectedColumns.length !== ourDefinition.columns.length) {
        problems.push(`column count ${ourDefinition.columns.length} vs Jackcess ${expectedColumns.length}`);
        return problems;
    }
    const primaryKeyColumns = new Set(
        jackcessTable.indexes.filter(index => index.primaryKey).flatMap(index => index.columns.map(column => column.replace(/[+-]$/, '').toLowerCase())),
    );
    for (let index = 0; index < expectedColumns.length; index++) {
        const expected = expectedColumns[index];
        const actual = ourDefinition.columns[index];
        if (expected.name !== actual.name) {
            problems.push(`column[${index}] name ${actual.name} vs ${expected.name}`);
            continue;
        }
        const expectedType = JACKCESS_TO_ACCESS_TYPE[expected.type];
        if (!expectedType) {
            problems.push(`column ${actual.name}: unmapped Jackcess type ${expected.type}`);
            continue;
        }
        if (expectedType !== actual.accessType) {
            problems.push(`column ${actual.name}: type ${actual.accessType} vs ${expectedType}`);
        }
        if (expected.type !== 'BOOLEAN' && expected.type !== 'COMPLEX_TYPE' && expected.length !== actual.size) {
            problems.push(`column ${actual.name}: size ${actual.size} vs ${expected.length}`);
        }
        if (expectedType === 'numeric' && (expected.precision !== actual.precision || expected.scale !== actual.scale)) {
            problems.push(`column ${actual.name}: numeric(${actual.precision},${actual.scale}) vs Jackcess numeric(${expected.precision},${expected.scale})`);
        }
        if (expected.autoNumber !== (actual.autoLong || actual.autoUuid)) {
            problems.push(`column ${actual.name}: autoNumber ${actual.autoLong || actual.autoUuid} vs ${expected.autoNumber}`);
        }
        if (primaryKeyColumns.has(actual.name.toLowerCase()) !== actual.isPrimaryKey) {
            problems.push(`column ${actual.name}: primary key ${actual.isPrimaryKey} vs ${primaryKeyColumns.has(actual.name.toLowerCase())}`);
        }
    }

    const jackcessIndexes = jackcessTable.indexes
        .map(index => `${index.name}|${index.primaryKey}|${index.unique}|${index.required}|${index.ignoreNulls}|${index.columns.map(column => column.replace(/[+-]$/, '')).join(',')}`)
        .sort();
    const ownIndexes = ourIndexes
        .map(index => `${index.name}|${index.primaryKey}|${index.unique}|${index.required}|${index.ignoreNulls}|${index.columns.join(',')}`)
        .sort();
    if (jackcessIndexes.join('\u0001') !== ownIndexes.join('\u0001')) {
        problems.push(`indexes [${ownIndexes.join('; ')}] vs Jackcess [${jackcessIndexes.join('; ')}]`);
    }

    if (!ourDefinition.columns.some(column => column.accessType === 'complex')) {
        problems.push(...compareRows(jackcessTable, ourRows, ourDefinition));
    }
    return problems;
}

async function main() {
    const java = findJava();
    if (!java) {
        console.log('SKIP access read parity: no JDK 11+ found (java / JAVA_HOME).');
        return;
    }
    if (!fs.existsSync(path.join(VERIFY_DIR, 'ParityDump.java'))) {
        throw new Error(`Missing ${path.join(VERIFY_DIR, 'ParityDump.java')}`);
    }
    if (!fs.existsSync(DIST_SESSION)) {
        throw new Error('packages/access-file/dist is missing; run `npm run build:access-file` first.');
    }

    run(findBash(), [bashPath(path.join(VERIFY_DIR, 'bootstrap.sh'))]);
    const { AccessFileSession } = require(DIST_SESSION);
    const fixtures = fs.readdirSync(FIXTURE_DIR)
        .filter(name => /\.(mdb|accdb)$/i.test(name))
        .sort();
    const failures = [];
    let tableCount = 0;
    let rowCount = 0;

    for (const fixture of fixtures) {
        const filePath = path.join(FIXTURE_DIR, fixture);
        const jackcess = parseParityDump(run(java, [
            '-Dfile.encoding=UTF-8',
            '-Dstdout.encoding=UTF-8',
            '-cp',
            classPath(),
            'ParityDump',
            filePath,
        ]));
        const session = await AccessFileSession.open({ filePath });
        try {
            const ourTables = new Map(session.listTables().map(table => [table.name, table]));
            for (const [name, table] of jackcess) {
                tableCount++;
                rowCount += table.rowCount;
                const definition = ourTables.get(name);
                if (!definition) {
                    failures.push(`${fixture}: missing table ${name}`);
                    continue;
                }
                const indexes = session.listIndexes(name);
                const rows = definition.columns.some(column => column.accessType === 'complex')
                    ? { rows: [] }
                    : await session.readTable(name);
                const problems = compareTable(table, definition, indexes, rows);
                for (const problem of problems) failures.push(`${fixture}: ${name}: ${problem}`);
            }
            for (const name of ourTables.keys()) {
                // Access stores the physical tables behind attachment and
                // multivalue columns as hidden catalog objects. They are
                // intentionally exposed by this reader and are not listed by
                // Jackcess, so only those known extras are accepted.
                if (!jackcess.has(name) && !/^f_[0-9a-f]{32}_/i.test(name)) {
                    failures.push(`${fixture}: unexpected table ${name}`);
                }
            }
        } finally {
            await session.close();
        }
    }

    if (failures.length > 0) {
        for (const failure of failures.slice(0, 60)) console.error(`FAIL ${failure}`);
        if (failures.length > 60) console.error(`... ${failures.length - 60} more differences`);
        throw new Error(`${failures.length} read-parity differences across ${fixtures.length} fixtures.`);
    }
    console.log(`OK access read parity: ${fixtures.length} fixtures, ${tableCount} tables, ${rowCount} rows match Jackcess.`);
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
