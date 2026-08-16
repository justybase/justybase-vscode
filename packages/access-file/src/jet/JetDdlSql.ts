/**
 * Access DDL SQL parser (CREATE/DROP TABLE, CREATE/DROP INDEX,
 * CREATE/DROP VIEW) dispatching to the JetDdl engine.
 */

import { AccessFileError } from '../accessFileSession';
import type { JetPageChannel } from './JetPageChannel';
import {
    addIndex,
    addRelationship,
    createTable,
    createView,
    dropIndex,
    dropRelationship,
    dropTable,
    dropView,
    type JetDdlColumn,
    type JetDdlIndex,
    type JetRelationship,
} from './JetDdl';

interface Token {
    readonly text: string;
    readonly lower: string;
}

const DATA_TYPES: Readonly<Record<string, { type: number; needsLength: boolean }>> = {
    BYTE: { type: 0x02, needsLength: false },
    TINYINT: { type: 0x02, needsLength: false },
    SMALLINT: { type: 0x03, needsLength: false },
    INTEGER: { type: 0x03, needsLength: false },
    INT: { type: 0x03, needsLength: false },
    SHORT: { type: 0x03, needsLength: false },
    LONG: { type: 0x04, needsLength: false },
    BIGINT: { type: 0x13, needsLength: false },
    COUNTER: { type: 0x04, needsLength: false },
    AUTONUMBER: { type: 0x04, needsLength: false },
    MONEY: { type: 0x05, needsLength: false },
    CURRENCY: { type: 0x05, needsLength: false },
    SINGLE: { type: 0x06, needsLength: false },
    FLOAT: { type: 0x06, needsLength: false },
    REAL: { type: 0x06, needsLength: false },
    DOUBLE: { type: 0x07, needsLength: false },
    DATETIME: { type: 0x08, needsLength: false },
    TIMESTAMP: { type: 0x08, needsLength: false },
    DATE: { type: 0x08, needsLength: false },
    GUID: { type: 0x0f, needsLength: false },
    REPLICATIONID: { type: 0x0f, needsLength: false },
    BINARY: { type: 0x09, needsLength: true },
    TEXT: { type: 0x0a, needsLength: true },
    CHAR: { type: 0x0a, needsLength: true },
    VARCHAR: { type: 0x0a, needsLength: true },
    MEMO: { type: 0x0c, needsLength: false },
    LONGCHAR: { type: 0x0c, needsLength: false },
    OLE: { type: 0x0b, needsLength: false },
    VARBINARY: { type: 0x0b, needsLength: true },
    DECIMAL: { type: 0x10, needsLength: false },
    NUMERIC: { type: 0x10, needsLength: false },
    BOOLEAN: { type: 0x01, needsLength: false },
    YESNO: { type: 0x01, needsLength: false },
    BIT: { type: 0x01, needsLength: false },
    LOGICAL: { type: 0x01, needsLength: false },
};

function tokenize(sql: string): Token[] {
    const tokens: Token[] = [];
    let index = 0;
    while (index < sql.length) {
        const c = sql[index]!;
        if (/\s/.test(c)) {
            index++;
            continue;
        }
        if (c === '-' && sql[index + 1] === '-') {
            const end = sql.indexOf('\n', index + 2);
            index = end < 0 ? sql.length : end + 1;
            continue;
        }
        if (c === '/' && sql[index + 1] === '*') {
            const end = sql.indexOf('*/', index + 2);
            index = end < 0 ? sql.length : end + 2;
            continue;
        }
        if (c === '\'' || c === '"') {
            const quote = c;
            let stop = index + 1;
            while (stop < sql.length) {
                if (sql[stop] !== quote) {
                    stop++;
                    continue;
                }
                if (sql[stop + 1] === quote) {
                    stop += 2;
                    continue;
                }
                stop++;
                break;
            }
            tokens.push({ text: sql.slice(index, stop), lower: sql.slice(index, stop).toLowerCase() });
            index = stop;
            continue;
        }
        if (c === '#') {
            const end = sql.indexOf('#', index + 1);
            const stop = end < 0 ? sql.length : end + 1;
            tokens.push({ text: sql.slice(index, stop), lower: sql.slice(index, stop).toLowerCase() });
            index = stop;
            continue;
        }
        if (c === '[') {
            let stop = index + 1;
            while (stop < sql.length) {
                if (sql[stop] !== ']') {
                    stop++;
                    continue;
                }
                if (sql[stop + 1] === ']') {
                    stop += 2;
                    continue;
                }
                stop++;
                break;
            }
            tokens.push({ text: sql.slice(index, stop), lower: sql.slice(index, stop).toLowerCase() });
            index = stop;
            continue;
        }
        if ('(),;'.includes(c)) {
            tokens.push({ text: c, lower: c });
            index++;
            continue;
        }
        let stop = index + 1;
        while (stop < sql.length && !/[\s(),;'\"#\[]/.test(sql[stop]!)) {
            stop++;
        }
        const text = sql.slice(index, stop);
        tokens.push({ text, lower: text.toLowerCase() });
        index = stop;
    }
    return tokens;
}

function expect(tokens: Token[], index: { value: number }, keyword: string): void {
    const token = tokens[index.value];
    if (!token || token.lower !== keyword) {
        throw new AccessFileError(`Expected '${keyword.toUpperCase()}' in DDL statement.`);
    }
    index.value++;
}

function stripDelims(name: string): string {
    const trimmed = name.trim();
    if (trimmed.length >= 2 && trimmed[0] === '[' && trimmed[trimmed.length - 1] === ']') {
        return trimmed.slice(1, -1).replace(/\]\]/g, ']');
    }
    if (trimmed.length >= 2 && trimmed[0] === '"' && trimmed[trimmed.length - 1] === '"') {
        return trimmed.slice(1, -1).replace(/""/g, '"');
    }
    if (trimmed.length >= 2 && trimmed[0] === '\'' && trimmed[trimmed.length - 1] === '\'') {
        return trimmed.slice(1, -1).replace(/''/g, '\'');
    }
    return trimmed;
}

function parseType(tokens: Token[], index: { value: number }): { type: number; length?: number; precision?: number; scale?: number } {
    const name = tokens[index.value];
    if (!name) {
        throw new AccessFileError('Expected a column type in DDL statement.');
    }
    const upper = name.text.toUpperCase();
    const definition = DATA_TYPES[upper];
    if (!definition) {
        throw new AccessFileError(`Unsupported column type '${upper}'.`);
    }
    index.value++;
    let length: number | undefined;
    let precision: number | undefined;
    let scale: number | undefined;
    if (tokens[index.value]?.text === '(') {
        index.value++;
        const arg1 = tokens[index.value];
        if (!arg1) {
            throw new AccessFileError('Expected a type argument.');
        }
        const first = Number(arg1.text);
        if (!Number.isInteger(first)) {
            throw new AccessFileError(`Invalid type length '${arg1.text}'.`);
        }
        index.value++;
        if (tokens[index.value]?.text === ',') {
            index.value++;
            const arg2 = tokens[index.value];
            if (!arg2) {
                throw new AccessFileError('Expected a scale argument.');
            }
            scale = Number(arg2.text);
            if (!Number.isInteger(scale ?? -1)) {
                throw new AccessFileError(`Invalid scale '${arg2.text}'.`);
            }
            index.value++;
            precision = first;
            length = undefined;
        } else {
            length = first;
        }
        expect(tokens, index, ')');
    } else if (definition.needsLength) {
        throw new AccessFileError(`Column type '${upper}' requires a length.`);
    }
    if (definition.type === 0x10 && precision === undefined) {
        precision = 18;
        scale = scale ?? 0;
    }
    return { type: definition.type, length, precision, scale };
}

function parseColumn(tokens: Token[], index: { value: number }): { column: JetDdlColumn; primaryKey: boolean } {
    const nameToken = tokens[index.value];
    if (!nameToken) {
        throw new AccessFileError('Expected a column name.');
    }
    const name = stripDelims(nameToken.text);
    index.value++;
    const typeInfo = parseType(tokens, index);
    let notNull = false;
    let autoNumber = false;
    let primaryKey = false;
    while (tokens[index.value]) {
        const lower = tokens[index.value]!.lower;
        if (lower === 'not' && tokens[index.value + 1]?.lower === 'null') {
            notNull = true;
            index.value += 2;
            continue;
        }
        if (lower === 'autoincrement' || lower === 'counter') {
            autoNumber = true;
            index.value++;
            continue;
        }
        if (lower === 'primary' && tokens[index.value + 1]?.lower === 'key') {
            primaryKey = true;
            notNull = true;
            index.value += 2;
            continue;
        }
        break;
    }
    return {
        column: { name, type: typeInfo.type, length: typeInfo.length, precision: typeInfo.precision, scale: typeInfo.scale, notNull, autoNumber },
        primaryKey,
    };
}

function parseColumnList(tokens: Token[], index: { value: number }): { name: string; ascending: boolean }[] {
    expect(tokens, index, '(');
    const columns: { name: string; ascending: boolean }[] = [];
    while (tokens[index.value] && tokens[index.value]!.text !== ')') {
        columns.push({ name: stripDelims(tokens[index.value]!.text), ascending: true });
        index.value++;
        if (tokens[index.value]?.text === ',') {
            index.value++;
        }
    }
    expect(tokens, index, ')');
    return columns;
}

function parseCreateTable(channel: JetPageChannel, tokens: Token[], index: { value: number }): void {
    expect(tokens, index, 'table');
    const tableName = stripDelims(tokens[index.value]?.text ?? '');
    if (!tableName) {
        throw new AccessFileError('CREATE TABLE requires a table name.');
    }
    index.value++;
    let asSelect = false;
    if (tokens[index.value]?.lower === 'as') {
        asSelect = true;
    }
    if (asSelect) {
        throw new AccessFileError('CREATE TABLE AS SELECT is not supported yet; create the table first and INSERT the rows.');
    }
    expect(tokens, index, '(');

    const columns: JetDdlColumn[] = [];
    const indexes: JetDdlIndex[] = [];
    const relationships: JetRelationship[] = [];
    let unnamedIndex = 0;
    while (tokens[index.value] && tokens[index.value]!.text !== ')') {
        const lower = tokens[index.value]!.lower;
        if (lower === 'primary' && tokens[index.value + 1]?.lower === 'key') {
            index.value += 2;
            indexes.push({ name: 'PrimaryKey', columns: parseColumnList(tokens, index), primaryKey: true, unique: true, required: true });
            continue;
        }
        if (lower === 'unique') {
            index.value++;
            indexes.push({ name: `Unique${++unnamedIndex}`, columns: parseColumnList(tokens, index), unique: true });
            continue;
        }
        if (lower === 'constraint') {
            index.value++;
            const constraintName = stripDelims(tokens[index.value]?.text ?? '');
            if (!constraintName) {
                throw new AccessFileError('CONSTRAINT requires a name.');
            }
            index.value++;
            const kind = tokens[index.value]?.lower;
            if (kind === 'foreign') {
                index.value++;
                expect(tokens, index, 'key');
                const columnsList = parseColumnList(tokens, index);
                expect(tokens, index, 'references');
                const foreignTable = stripDelims(tokens[index.value]?.text ?? '');
                if (!foreignTable) {
                    throw new AccessFileError('FOREIGN KEY requires a referenced table.');
                }
                index.value++;
                relationships.push({
                    name: constraintName,
                    table: tableName,
                    columns: columnsList.map(column => column.name),
                    foreignTable,
                    foreignColumns: parseColumnList(tokens, index).map(column => column.name),
                });
                continue;
            }
            if (kind === 'primary') {
                index.value++;
                expect(tokens, index, 'key');
                indexes.push({ name: constraintName, columns: parseColumnList(tokens, index), primaryKey: true, unique: true, required: true });
                continue;
            }
            if (kind === 'unique') {
                index.value++;
                indexes.push({ name: constraintName, columns: parseColumnList(tokens, index), unique: true });
                continue;
            }
            throw new AccessFileError(`CONSTRAINT ${kind?.toUpperCase() ?? ''} is not supported.`);
        }
        const parsed = parseColumn(tokens, index);
        columns.push(parsed.column);
        if (parsed.primaryKey) {
            indexes.push({
                name: 'PrimaryKey',
                columns: [{ name: parsed.column.name, ascending: true }],
                primaryKey: true,
                unique: true,
                required: true,
            });
        }
        if (tokens[index.value]?.text === ',') {
            index.value++;
        }
    }
    expect(tokens, index, ')');
    createTable(channel, tableName, columns, indexes, relationships);
}

function parseCreateIndex(channel: JetPageChannel, tokens: Token[], index: { value: number }): void {
    let unique = false;
    let primaryKey = false;
    let required = false;
    if (tokens[index.value]?.lower === 'unique') {
        unique = true;
        index.value++;
    }
    expect(tokens, index, 'index');
    const name = stripDelims(tokens[index.value]?.text ?? '');
    if (!name) {
        throw new AccessFileError('CREATE INDEX requires an index name.');
    }
    index.value++;
    expect(tokens, index, 'on');
    const tableName = stripDelims(tokens[index.value]?.text ?? '');
    if (!tableName) {
        throw new AccessFileError('CREATE INDEX requires a table name.');
    }
    index.value++;
    expect(tokens, index, '(');
    const columns: { name: string; ascending: boolean }[] = [];
    while (tokens[index.value] && tokens[index.value]!.text !== ')') {
        const columnName = stripDelims(tokens[index.value]!.text);
        index.value++;
        let ascending = true;
        if (tokens[index.value]?.lower === 'asc') {
            index.value++;
        } else if (tokens[index.value]?.lower === 'desc') {
            ascending = false;
            index.value++;
        }
        columns.push({ name: columnName, ascending });
        if (tokens[index.value]?.text === ',') {
            index.value++;
        }
    }
    expect(tokens, index, ')');
    // optional WITH PRIMARY / DISALLOW NULL / IGNORE NULL
    while (tokens[index.value]) {
        const lower = tokens[index.value]!.lower;
        if (lower === 'with') {
            index.value++;
            continue;
        }
        if (lower === 'primary') {
            primaryKey = true;
            unique = true;
            required = true;
            index.value++;
            continue;
        }
        if (lower === 'disallow' && tokens[index.value + 1]?.lower === 'null') {
            required = true;
            index.value += 2;
            continue;
        }
        if (lower === 'ignore' && tokens[index.value + 1]?.lower === 'null') {
            index.value += 2;
            continue;
        }
        break;
    }
    addIndex(channel, tableName, { name, columns, unique, primaryKey, required });
}

function parseCreateView(channel: JetPageChannel, tokens: Token[], index: { value: number }): void {
    expect(tokens, index, 'view');
    const viewName = stripDelims(tokens[index.value]?.text ?? '');
    if (!viewName) {
        throw new AccessFileError('CREATE VIEW requires a view name.');
    }
    index.value++;
    expect(tokens, index, 'as');
    // reconstruct the SELECT from the remaining tokens
    const selectSql = tokens.slice(index.value).map(token => token.text).join(' ');
    createView(channel, viewName, selectSql);
}

function parseDrop(channel: JetPageChannel, tokens: Token[], index: { value: number }): void {
    const kind = tokens[index.value]?.lower;
    if (kind === 'table') {
        index.value++;
        const name = stripDelims(tokens[index.value]?.text ?? '');
        if (!name) {
            throw new AccessFileError('DROP TABLE requires a table name.');
        }
        dropTable(channel, name);
        return;
    }
    if (kind === 'index') {
        index.value++;
        const name = stripDelims(tokens[index.value]?.text ?? '');
        if (!name) {
            throw new AccessFileError('DROP INDEX requires an index name.');
        }
        index.value++;
        if (tokens[index.value]?.lower === 'on') {
            index.value++;
            const tableName = stripDelims(tokens[index.value]?.text ?? '');
            if (!tableName) {
                throw new AccessFileError('DROP INDEX requires a table name after ON.');
            }
            dropIndex(channel, tableName, name);
        } else {
            throw new AccessFileError('DROP INDEX requires "ON <table>".');
        }
        return;
    }
    if (kind === 'view') {
        index.value++;
        const name = stripDelims(tokens[index.value]?.text ?? '');
        if (!name) {
            throw new AccessFileError('DROP VIEW requires a view name.');
        }
        dropView(channel, name);
        return;
    }
    throw new AccessFileError(`DROP ${kind?.toUpperCase() ?? ''} is not supported.`);
}

function parseAlterTable(channel: JetPageChannel, tokens: Token[], index: { value: number }): void {
    expect(tokens, index, 'table');
    const tableName = stripDelims(tokens[index.value]?.text ?? '');
    if (!tableName) {
        throw new AccessFileError('ALTER TABLE requires a table name.');
    }
    index.value++;
    const action = tokens[index.value]?.lower;
    if (action === 'add') {
        index.value++;
        let name: string | undefined;
        if (tokens[index.value]?.lower === 'constraint') {
            index.value++;
            name = stripDelims(tokens[index.value]?.text ?? '');
            if (!name) {
                throw new AccessFileError('ADD CONSTRAINT requires a name.');
            }
            index.value++;
        }
        const kind = tokens[index.value]?.lower;
        if (kind === 'foreign') {
            index.value++;
            expect(tokens, index, 'key');
            const columnsList = parseColumnList(tokens, index);
            expect(tokens, index, 'references');
            const foreignTable = stripDelims(tokens[index.value]?.text ?? '');
            if (!foreignTable) {
                throw new AccessFileError('FOREIGN KEY requires a referenced table.');
            }
            index.value++;
            addRelationship(channel, {
                name: name ?? `FK_${tableName}_${columnsList.map(column => column.name).join('_')}`,
                table: tableName,
                columns: columnsList.map(column => column.name),
                foreignTable,
                foreignColumns: parseColumnList(tokens, index).map(column => column.name),
            });
            return;
        }
        if (kind === 'primary') {
            index.value++;
            expect(tokens, index, 'key');
            addIndex(channel, tableName, {
                name: name ?? 'PrimaryKey',
                columns: parseColumnList(tokens, index),
                primaryKey: true,
                unique: true,
                required: true,
            });
            return;
        }
        if (kind === 'unique') {
            index.value++;
            addIndex(channel, tableName, { name: name ?? 'Unique1', columns: parseColumnList(tokens, index), unique: true });
            return;
        }
        throw new AccessFileError(`ALTER TABLE ADD ${kind?.toUpperCase() ?? ''} is not supported.`);
    }
    if (action === 'drop') {
        index.value++;
        const dropKind = tokens[index.value]?.lower;
        if (dropKind === 'constraint') {
            index.value++;
            const constraintName = stripDelims(tokens[index.value]?.text ?? '');
            if (!constraintName) {
                throw new AccessFileError('DROP CONSTRAINT requires a name.');
            }
            index.value++;
            try {
                dropRelationship(channel, constraintName);
                return;
            } catch (error) {
                if (!(error instanceof AccessFileError) || !/does not exist/i.test(error.message)) {
                    throw error;
                }
            }
            dropIndex(channel, tableName, constraintName);
            return;
        }
        if (dropKind === 'column') {
            throw new AccessFileError('ALTER TABLE DROP COLUMN is not supported yet.');
        }
        throw new AccessFileError(`ALTER TABLE DROP ${dropKind?.toUpperCase() ?? ''} is not supported.`);
    }
    throw new AccessFileError(`ALTER TABLE ${action?.toUpperCase() ?? ''} is not supported.`);
}

/**
 * Parses and executes a single Access DDL statement against the given
 * (staged) page channel.
 */
export function applyDdlSql(channel: JetPageChannel, sql: string): void {
    const tokens = tokenize(sql);
    const index = { value: 0 };
    if (tokens.length === 0) {
        throw new AccessFileError('Empty DDL statement.');
    }
    const kind = tokens[0]!.lower;
    if (kind === 'create') {
        index.value++;
        const objType = tokens[index.value]?.lower;
        if (objType === 'table') {
            parseCreateTable(channel, tokens, index);
        } else if (objType === 'index') {
            parseCreateIndex(channel, tokens, index);
        } else if (objType === 'unique') {
            index.value++;
            parseCreateIndex(channel, tokens, index);
        } else if (objType === 'view') {
            parseCreateView(channel, tokens, index);
        } else {
            throw new AccessFileError(`CREATE ${objType?.toUpperCase() ?? ''} is not supported.`);
        }
        return;
    }
    if (kind === 'drop') {
        index.value++;
        parseDrop(channel, tokens, index);
        return;
    }
    if (kind === 'alter') {
        index.value++;
        parseAlterTable(channel, tokens, index);
        return;
    }
    throw new AccessFileError(`Statement type '${kind.toUpperCase()}' is not supported for DDL.`);
}
