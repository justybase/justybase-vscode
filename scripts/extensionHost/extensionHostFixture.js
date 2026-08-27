const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const SQLITE_TABLE_NAME = 'jbl_extension_host_fixture';

// Keep these rows intentionally boring and stable. The Extension Host and
// Playwright fixtures use the same value patterns so a failed trace can be
// reproduced without relying on generated data.
const FIXTURE_ROWS = [
    [1, 'Alpha', 'X', 10.5, 'open', '2024-01-01 08:00:00', 'Łódź', "O'Brien, alpha", '', '00FF'],
    [2, 'Alpha', 'X', 0, 'closed', '2024-01-02 09:15:00', '東京', 'comma, value', 'filled', '0102'],
    [3, 'Alpha', 'Y', null, 'open', '2024-01-03 10:30:00', '🙂', 'empty amount', '', '0304'],
    [4, 'Alpha', 'Y', 25.75, 'pending', '2024-01-04 11:45:00', 'Łódź', "O'Brien, alpha", 'filled', '0506'],
    [5, 'Beta', 'X', 100, 'open', '2024-01-05 12:00:00', '東京', 'comma, value', '', '0708'],
    [6, 'Beta', 'X', 10, 'closed', '2024-01-06 13:15:00', '🙂', 'empty amount', 'filled', '090A'],
    [7, 'Beta', 'Y', null, 'open', '2024-01-07 14:30:00', 'Łódź', "O'Brien, beta", '', '0B0C'],
    [8, 'Beta', 'Y', 0, 'pending', '2024-01-08 15:45:00', '東京', 'comma, value', 'filled', '0D0E'],
    [9, 'Gamma', 'X', 1.25, 'open', '2024-01-09 16:00:00', '🙂', 'empty amount', '', '0F10'],
    [10, 'Gamma', 'X', 5, 'closed', '2024-01-10 17:15:00', 'Łódź', "O'Brien, gamma", 'filled', '1112'],
    [11, 'Gamma', 'Y', null, 'open', '2024-01-11 18:30:00', '東京', 'comma, value', '', '1314'],
    [12, 'Gamma', 'Y', 50, 'pending', '2024-01-12 19:45:00', '🙂', "O'Brien, gamma", 'filled', '1516'],
];

const FIXTURE_COLUMNS = [
    'id',
    'group_a',
    'group_b',
    'amount',
    'status',
    'created_at',
    'unicode_text',
    'quoted_text',
    'empty_text',
    'binary_text',
];

function quoteSqliteIdentifier(identifier) {
    return `"${String(identifier).replaceAll('"', '""')}"`;
}

function quoteSqlString(value) {
    return `'${String(value).replaceAll("'", "''")}'`;
}

function quoteNetezzaIdentifier(identifier) {
    return `"${String(identifier).replaceAll('"', '""')}"`;
}

function qualifiedNetezzaTable(tableName, schemaName) {
    return schemaName
        ? `${quoteNetezzaIdentifier(schemaName)}.${quoteNetezzaIdentifier(tableName)}`
        : quoteNetezzaIdentifier(tableName);
}

function createSqliteFixture(databasePath) {
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    const database = new DatabaseSync(databasePath);
    database.exec(`DROP TABLE IF EXISTS ${quoteSqliteIdentifier(SQLITE_TABLE_NAME)}`);
    database.exec(`
        CREATE TABLE ${quoteSqliteIdentifier(SQLITE_TABLE_NAME)} (
            id INTEGER PRIMARY KEY,
            group_a TEXT NOT NULL,
            group_b TEXT NOT NULL,
            amount NUMERIC,
            status TEXT NOT NULL,
            created_at TEXT NOT NULL,
            unicode_text TEXT NOT NULL,
            quoted_text TEXT NOT NULL,
            empty_text TEXT NOT NULL,
            binary_text BLOB
        )
    `);
    const insert = database.prepare(`
        INSERT INTO ${quoteSqliteIdentifier(SQLITE_TABLE_NAME)}
        (id, group_a, group_b, amount, status, created_at, unicode_text, quoted_text, empty_text, binary_text)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const row of FIXTURE_ROWS) {
        insert.run(
            row[0], row[1], row[2], row[3], row[4], row[5], row[6], row[7], row[8],
            Buffer.from(row[9], 'hex'),
        );
    }
    database.close();
}

function selectSql(tableName = SQLITE_TABLE_NAME, schemaName) {
    const table = schemaName
        ? `${quoteNetezzaIdentifier(schemaName)}.${quoteNetezzaIdentifier(tableName)}`
        : quoteSqliteIdentifier(tableName);
    return `SELECT ${FIXTURE_COLUMNS.map(quoteSqliteIdentifier).join(', ')} FROM ${table} ORDER BY ${quoteSqliteIdentifier('id')} LIMIT 1000`;
}

function selectSubsetSql(tableName = SQLITE_TABLE_NAME, schemaName) {
    const table = schemaName
        ? qualifiedNetezzaTable(tableName, schemaName)
        : quoteSqliteIdentifier(tableName);
    return `SELECT ${FIXTURE_COLUMNS.map(quoteSqliteIdentifier).join(', ')} FROM ${table} WHERE ${quoteSqliteIdentifier('group_a')} = 'Beta' ORDER BY ${quoteSqliteIdentifier('id')} LIMIT 1000`;
}

function updateSql(tableName = SQLITE_TABLE_NAME, schemaName) {
    const table = schemaName
        ? qualifiedNetezzaTable(tableName, schemaName)
        : quoteSqliteIdentifier(tableName);
    return `UPDATE ${table} SET ${quoteSqliteIdentifier('amount')} = 11.5 WHERE ${quoteSqliteIdentifier('id')} = 1`;
}

function deleteSql(tableName = SQLITE_TABLE_NAME, schemaName) {
    const table = schemaName
        ? qualifiedNetezzaTable(tableName, schemaName)
        : quoteSqliteIdentifier(tableName);
    return `DELETE FROM ${table} WHERE ${quoteSqliteIdentifier('id')} = 12`;
}

function createNetezzaFixtureSql(tableName, schemaName) {
    const table = qualifiedNetezzaTable(tableName, schemaName);
    return `CREATE TABLE ${table} (
        ${quoteNetezzaIdentifier('id')} INTEGER,
        ${quoteNetezzaIdentifier('group_a')} VARCHAR(32),
        ${quoteNetezzaIdentifier('group_b')} VARCHAR(32),
        ${quoteNetezzaIdentifier('amount')} NUMERIC(12,2),
        ${quoteNetezzaIdentifier('status')} VARCHAR(32),
        ${quoteNetezzaIdentifier('created_at')} TIMESTAMP,
        ${quoteNetezzaIdentifier('unicode_text')} NVARCHAR(128),
        ${quoteNetezzaIdentifier('quoted_text')} VARCHAR(128),
        ${quoteNetezzaIdentifier('empty_text')} VARCHAR(128),
        ${quoteNetezzaIdentifier('binary_text')} VARCHAR(32)
    )`;
}

function createNetezzaInsertSqls(tableName, schemaName) {
    const table = qualifiedNetezzaTable(tableName, schemaName);
    const columns = FIXTURE_COLUMNS.map(quoteNetezzaIdentifier).join(', ');
    return FIXTURE_ROWS.map(row => {
        const values = row.map((value, index) => {
            if (value === null) return 'NULL';
            if (index === 0) return String(value);
            if (index === 3) return Number(value).toFixed(2);
            if (index === 5) return `TIMESTAMP ${quoteSqlString(value)}`;
            return quoteSqlString(value);
        });
        return `INSERT INTO ${table} (${columns}) VALUES (${values.join(', ')})`;
    });
}

function dropNetezzaFixtureSql(tableName, schemaName) {
    return `DROP TABLE ${qualifiedNetezzaTable(tableName, schemaName)}`;
}

function getFixtureRowCount() {
    return FIXTURE_ROWS.length;
}

module.exports = {
    FIXTURE_COLUMNS,
    FIXTURE_ROWS,
    SQLITE_TABLE_NAME,
    createSqliteFixture,
    selectSql,
    selectSubsetSql,
    updateSql,
    deleteSql,
    createNetezzaFixtureSql,
    createNetezzaInsertSqls,
    dropNetezzaFixtureSql,
    getFixtureRowCount,
    qualifiedNetezzaTable,
};
