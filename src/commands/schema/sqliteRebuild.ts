/**
 * SQLite table rebuild script builders.
 *
 * Ported from the Tauri SchemaBrowser helpers so both shells generate the
 * same rebuild flow: replacement CREATE TABLE under a temporary name, row
 * copy with an explicit column mapping, dependent index/trigger restore, and
 * a stop before COMMIT for foreign_key_check review.
 */

interface CreateTableHead {
    prefix: string;
    target: string;
    tail: string;
}

export interface SqliteTableRebuildOptions {
    schemaName: string;
    tableName: string;
    qualifiedTableName: string;
    qualifiedTemporaryName: string;
    sequenceBackupName: string;
    columns: string[];
    dependentDdl: string[];
    createTableDdl: string;
    preserveAutoincrement: boolean;
}

const sqliteIdentifier = '(?:"(?:[^"]|"")*"|`(?:[^`]|``)*`|\\[[^\\]]+\\]|[\\p{L}_][\\p{L}\\p{N}_$#]*)';
const createTableHead = new RegExp(
    `^(?<prefix>\\s*CREATE\\s+TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?)(?<target>${sqliteIdentifier}(?:\\s*\\.\\s*${sqliteIdentifier})?)(?<tail>\\s*\\([\\s\\S]*)$`,
    'iu',
);

function parseCreateTableHead(ddl: string): CreateTableHead | undefined {
    const match = createTableHead.exec(ddl.trimStart());
    if (!match?.groups) return undefined;
    return { prefix: match.groups.prefix, target: match.groups.target, tail: match.groups.tail };
}

function normalizedTarget(target: string): string {
    return target.replace(/\s+/g, '').toLocaleLowerCase();
}

function hasTrailingStatement(sql: string): boolean {
    let quote: "'" | '"' | '`' | ']' | null = null;
    for (let index = 0; index < sql.length; index += 1) {
        const character = sql[index];
        const next = sql[index + 1];
        if (quote) {
            if (character === quote) {
                if (next === quote && quote !== ']') index += 1;
                else quote = null;
            }
            continue;
        }
        if (character === '-' && next === '-') {
            index += 2;
            while (index < sql.length && sql[index] !== '\n') index += 1;
            continue;
        }
        if (character === '/' && next === '*') {
            const end = sql.indexOf('*/', index + 2);
            if (end < 0) return true;
            index = end + 1;
            continue;
        }
        if (character === "'" || character === '"' || character === '`') { quote = character; continue; }
        if (character === '[') { quote = ']'; continue; }
        if (character !== ';') continue;

        let rest = index + 1;
        while (rest < sql.length) {
            if (/\s/.test(sql[rest])) { rest += 1; continue; }
            if (sql.startsWith('--', rest)) {
                const newline = sql.indexOf('\n', rest + 2);
                rest = newline < 0 ? sql.length : newline + 1;
                continue;
            }
            if (sql.startsWith('/*', rest)) {
                const end = sql.indexOf('*/', rest + 2);
                if (end < 0) return true;
                rest = end + 2;
                continue;
            }
            return true;
        }
        return false;
    }
    return quote !== null;
}

function quoteRebuildIdentifier(value: string): string {
    return `"${value.replace(/"/g, '""')}"`;
}

function rebuildSqlLiteral(value: string): string {
    return `'${value.replace(/'/g, "''")}'`;
}

function withTerminator(sql: string): string {
    const trimmed = sql.trim().replace(/;+\s*$/, '');
    return `${trimmed};`;
}

export function retargetSqliteCreateTableDdl(
    originalDdl: string,
    editedDdl: string,
    qualifiedTemporaryName: string,
): string {
    const original = parseCreateTableHead(originalDdl);
    const edited = parseCreateTableHead(editedDdl);
    if (!original || !edited || hasTrailingStatement(editedDdl)) throw new Error('The replacement definition must be one CREATE TABLE statement. Virtual tables cannot use this rebuild flow.');
    if (normalizedTarget(original.target) !== normalizedTarget(edited.target)) {
        throw new Error('Keep the original table name in the CREATE TABLE definition; the rebuild script assigns a temporary name.');
    }
    const leadingWhitespace = editedDdl.match(/^\s*/)?.[0] ?? '';
    return `${leadingWhitespace}${edited.prefix}${qualifiedTemporaryName}${edited.tail}`;
}

export function buildSqliteTableRebuildScript(options: SqliteTableRebuildOptions): string {
    const {
        schemaName,
        tableName,
        qualifiedTableName,
        qualifiedTemporaryName,
        sequenceBackupName,
        columns,
        dependentDdl,
        createTableDdl,
        preserveAutoincrement,
    } = options;
    const quotedSchema = quoteRebuildIdentifier(schemaName);
    const mapping = columns.map(quoteRebuildIdentifier).join(', ');
    const copy = mapping
        ? `INSERT INTO ${qualifiedTemporaryName} (${mapping}) SELECT ${mapping} FROM ${qualifiedTableName};`
        : `INSERT INTO ${qualifiedTemporaryName} SELECT * FROM ${qualifiedTableName};`;
    const statements = [
        `-- Rebuild ${qualifiedTableName} inside one SQLite transaction.`,
        '-- Review the replacement CREATE TABLE statement and copy mapping before running.',
        '-- If columns were renamed, removed, generated, or have hidden rowids, edit the target/source column lists in the INSERT statement.',
        '-- Added columns are omitted from the INSERT and must allow NULL or have a default.',
        '-- Review restored indexes, triggers, and any dependent views if column names changed.',
        '-- This script stops before COMMIT so you can inspect foreign_key_check results.',
        '-- Run on a connection with no transaction already open. Save its current foreign_keys setting.',
        'PRAGMA foreign_keys = OFF;',
        'BEGIN IMMEDIATE;',
    ];

    if (preserveAutoincrement) {
        const sequenceTable = `${quotedSchema}.sqlite_sequence`;
        const backup = quoteRebuildIdentifier(sequenceBackupName);
        statements.push(
            `CREATE TEMP TABLE ${backup} (seq INTEGER);`,
            `INSERT INTO ${backup} SELECT seq FROM ${sequenceTable} WHERE name = ${rebuildSqlLiteral(tableName)};`,
        );
    }

    statements.push(withTerminator(createTableDdl), copy, `DROP TABLE ${qualifiedTableName};`);
    const renamedTemporary = `${qualifiedTemporaryName} RENAME TO ${quoteRebuildIdentifier(tableName)};`;
    statements.push(`ALTER TABLE ${renamedTemporary}`);

    if (preserveAutoincrement) {
        const sequenceTable = `${quotedSchema}.sqlite_sequence`;
        const backup = quoteRebuildIdentifier(sequenceBackupName);
        statements.push(
            `UPDATE ${sequenceTable} SET seq = MAX(seq, (SELECT COALESCE(MAX(seq), 0) FROM ${backup})) WHERE name = ${rebuildSqlLiteral(tableName)};`,
            `INSERT INTO ${sequenceTable} (name, seq) SELECT ${rebuildSqlLiteral(tableName)}, seq FROM ${backup} WHERE NOT EXISTS (SELECT 1 FROM ${sequenceTable} WHERE name = ${rebuildSqlLiteral(tableName)});`,
            `DROP TABLE ${backup};`,
        );
    }

    statements.push(...dependentDdl.map(withTerminator));
    statements.push(
        `PRAGMA ${quotedSchema}.foreign_key_check;`,
        '-- If foreign_key_check returns no rows, execute COMMIT; then restore the connection foreign_keys setting.',
        '-- If any step fails, execute ROLLBACK; then restore the connection foreign_keys setting.',
        '-- COMMIT;',
        '-- PRAGMA foreign_keys = ON;',
        '-- ROLLBACK;',
    );
    return statements.join('\n');
}
