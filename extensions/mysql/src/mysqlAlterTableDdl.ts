import type {
    MysqlAlterTableDesign,
    MysqlAlterTableDesignerColumn,
    MysqlAlterTableDesignerInitialContext,
} from '../../../src/contracts/webviews/mysqlAlterTableDesignerContracts';
import { formatIdentifierForSql } from '../../../src/utils/identifierUtils';
import { areMysqlIdentifiersEqual } from './mysqlDesignerDdl';
import { assertDesignerOperation } from '../../../src/views/designerOperationGuard';

function requireValue(value: string | undefined, label: string): string {
    const trimmed = value?.trim() ?? '';
    if (!trimmed) {
        throw new Error(`${label} is required.`);
    }
    return trimmed;
}

function identifierKey(value: string): string {
    const trimmed = value.trim();
    if (trimmed.startsWith('`') && trimmed.endsWith('`') && trimmed.length >= 2) {
        return trimmed.slice(1, -1).replace(/``/g, '`').toLowerCase();
    }
    return trimmed.toLowerCase();
}

function escapeLiteral(value: string): string {
    return value.replace(/'/g, "''");
}

function requireSimpleName(value: string, label: string): string {
    const name = requireValue(value, label);
    if (!/^[A-Za-z0-9_$]+$/.test(name)) {
        throw new Error(`${label} can only contain letters, digits, underscores, and dollar signs.`);
    }
    return name;
}

function requireColumnType(value: string): string {
    const type = requireValue(value, 'Column type');
    if (/[;]|--|\/\*|\*\/|#/.test(type)) {
        throw new Error('Column type cannot contain SQL statement separators or comments.');
    }
    return type;
}

function requirePositiveInteger(value: string, label: string): string {
    const trimmed = value.trim();
    if (!/^\d+$/.test(trimmed) || Number(trimmed) <= 0) {
        throw new Error(`${label} must be a positive integer.`);
    }
    return trimmed;
}

const FUNCTION_DEFAULT_KEYWORDS = new Set([
    'CURRENT_TIMESTAMP',
    'CURRENT_DATE',
    'CURRENT_TIME',
    'CURRENT_USER',
    'LOCALTIME',
    'LOCALTIMESTAMP',
    'LOCALTIME()',
    'LOCALTIMESTAMP()',
    'NOW',
    'SYSDATE',
    'UTC_TIMESTAMP',
    'UTC_DATE',
    'UTC_TIME',
    'USER',
]);

function isFunctionLikeDefault(value: string): boolean {
    const upper = value.toUpperCase();
    if (FUNCTION_DEFAULT_KEYWORDS.has(upper)) {
        return true;
    }
    if (/^[A-Z0-9_$]+\(/.test(upper)) {
        return true;
    }
    if (upper === 'NULL' || /^[-+]?(\d+\.?\d*|\.\d+)$/.test(value)) {
        return true;
    }
    if (/^0[xX][0-9A-Fa-f]+$/.test(value) || /^b'[01]+'$/.test(value)) {
        return true;
    }
    return false;
}

function isStringLikeType(type: string): boolean {
    const normalized = type.trim().toUpperCase();
    return /^(CHAR|VARCHAR|TEXT|ENUM|SET|DATE|TIME)/.test(normalized);
}

/**
 * Renders a DEFAULT clause value the way a user would write it in DDL.
 * Already-quoted and parenthesized expressions are passed through verbatim;
 * string-like types get single-quoted; numbers, NULL, and function calls stay raw.
 */
export function renderMysqlDefaultValue(value: string, type: string): string {
    const trimmed = value.trim();
    if (!trimmed) {
        return '';
    }
    if (trimmed.startsWith("'") || trimmed.startsWith('"') || trimmed.startsWith('(')) {
        return trimmed;
    }
    if (isFunctionLikeDefault(trimmed)) {
        return trimmed;
    }
    if (isStringLikeType(type)) {
        return `'${escapeLiteral(trimmed)}'`;
    }
    return trimmed;
}

/**
 * Builds the `\`name\` TYPE [NULL|NOT NULL] [DEFAULT ...] [AUTO_INCREMENT] [COMMENT '...']`
 * fragment used by both ADD COLUMN and MODIFY COLUMN clauses.
 */
export function buildMysqlColumnDefinitionSql(column: MysqlAlterTableDesignerColumn): string {
    const name = requireValue(column.name, 'Column name');
    const type = requireColumnType(column.type);
    let definition = `${formatIdentifierForSql(name, 'mysql')} ${type}`;

    if (column.notNull) {
        definition += ' NOT NULL';
    } else {
        definition += ' NULL';
    }

    const defaultValue = renderMysqlDefaultValue(column.defaultValue, type);
    if (defaultValue) {
        definition += ` DEFAULT ${defaultValue}`;
    }

    if (column.autoIncrement) {
        definition += ' AUTO_INCREMENT';
    }

    const comment = (column.comment ?? '').trim();
    if (comment) {
        definition += ` COMMENT '${escapeLiteral(comment)}'`;
    }

    return definition;
}

function normalizeDefaultValue(value: string): string {
    const trimmed = (value ?? '').trim();
    return trimmed.toUpperCase() === 'NULL' ? '' : trimmed;
}

function columnChanged(left: MysqlAlterTableDesignerColumn, right: MysqlAlterTableDesignerColumn): boolean {
    return left.type.trim() !== right.type.trim()
        || left.notNull !== right.notNull
        || left.autoIncrement !== right.autoIncrement
        || (left.comment ?? '').trim() !== (right.comment ?? '').trim()
        || normalizeDefaultValue(left.defaultValue) !== normalizeDefaultValue(right.defaultValue);
}

function charsetFromCollation(collation: string): string {
    const firstSegment = collation.trim().split('_')[0] ?? '';
    return /^[A-Za-z0-9]+$/.test(firstSegment) ? firstSegment : '';
}

/**
 * Diffs the proposed design against the initial context and produces a single
 * multi-clause `ALTER TABLE` statement. Returns an empty string when nothing changed.
 */
export function buildMysqlAlterTableSql(
    context: MysqlAlterTableDesignerInitialContext,
    design: MysqlAlterTableDesign,
): string {
    assertDesignerOperation('mysql', 'alterTable', 'alter');
    const originalColumns = new Map(context.columns.map(column => [identifierKey(column.name), column]));
    const designNames = new Set<string>();
    const clauses: string[] = [];

    for (const column of design.columns) {
        const key = identifierKey(column.name);
        if (designNames.has(key)) {
            throw new Error(`Column "${column.name}" is defined more than once.`);
        }
        designNames.add(key);
        requireValue(column.name, 'Column name');
        requireColumnType(column.type);

        const original = originalColumns.get(key);
        if (!original) {
            clauses.push(`ADD COLUMN ${buildMysqlColumnDefinitionSql(column)}`);
        } else if (columnChanged(original, column)) {
            clauses.push(`MODIFY COLUMN ${buildMysqlColumnDefinitionSql(column)}`);
        }
    }

    for (const original of context.columns) {
        if (designNames.has(identifierKey(original.name))) {
            continue;
        }
        if (original.isPrimaryKey) {
            throw new Error(`The PRIMARY KEY column "${original.name}" cannot be dropped from the Alter Table Designer.`);
        }
        clauses.push(`DROP COLUMN ${formatIdentifierForSql(original.name, 'mysql')}`);
    }

    const originalOptions = context.options;
    const options = design.options;

    if (!areMysqlIdentifiersEqual(options.engine.trim(), originalOptions.engine.trim())) {
        clauses.push(`ENGINE = ${requireSimpleName(options.engine, 'Engine')}`);
    }

    if (!areMysqlIdentifiersEqual(options.collation.trim(), originalOptions.collation.trim())) {
        clauses.push(`COLLATE = ${requireSimpleName(options.collation, 'Collation')}`);
    }

    if (!areMysqlIdentifiersEqual(options.charset.trim(), originalOptions.charset.trim())) {
        clauses.push(`DEFAULT CHARACTER SET = ${requireSimpleName(options.charset, 'Character set')}`);
    }

    const originalAutoIncrement = (originalOptions.autoIncrement ?? '').trim();
    const newAutoIncrement = options.autoIncrement.trim();
    if (newAutoIncrement && newAutoIncrement !== originalAutoIncrement) {
        clauses.push(`AUTO_INCREMENT = ${requirePositiveInteger(newAutoIncrement, 'AUTO_INCREMENT value')}`);
    }

    const originalComment = (originalOptions.comment ?? '').trim();
    const newComment = options.comment.trim();
    if (newComment !== originalComment) {
        clauses.push(`COMMENT = '${escapeLiteral(newComment)}'`);
    }

    if (clauses.length === 0) {
        return '';
    }

    return `ALTER TABLE ${context.qualifiedTable}\n    ${clauses.join(',\n    ')};`;
}

export function hasMysqlAlterTableChanges(
    context: MysqlAlterTableDesignerInitialContext,
    design: MysqlAlterTableDesign,
): boolean {
    return buildMysqlAlterTableSql(context, design) !== '';
}

export { charsetFromCollation };
