import type {
    PostgresqlAlterTableDesign,
    PostgresqlAlterTableDesignerColumn,
    PostgresqlAlterTableDesignerInitialContext,
} from '../../../src/contracts/webviews/postgresqlAlterTableDesignerContracts';
import {
    formatIdentifierForSql,
    formatQualifiedObjectName,
} from '../../../src/utils/identifierUtils';

function requireValue(value: string | undefined, label: string): string {
    const trimmed = value?.trim() ?? '';
    if (!trimmed) {
        throw new Error(`${label} is required.`);
    }
    return trimmed;
}

function identifierKey(value: string): string {
    const trimmed = value.trim();
    if (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) {
        return trimmed.slice(1, -1).replace(/""/g, '"').toLowerCase();
    }
    return trimmed.toLowerCase();
}

function escapeLiteral(value: string): string {
    return value.replace(/'/g, "''");
}

function requireColumnType(value: string): string {
    const type = requireValue(value, 'Column type');
    if (/[;]|--|\/\*|\*\//.test(type)) {
        throw new Error('Column type cannot contain SQL statement separators or comments.');
    }
    return type;
}

function requireTableOptionName(value: string, label: string): string {
    const name = requireValue(value, label);
    if (!/^[A-Za-z0-9_]+$/.test(name)) {
        throw new Error(`${label} can only contain letters, digits, and underscores.`);
    }
    return name;
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
    'LOCALTIMESTAMP',
    'LOCALTIME',
    'NOW',
    'NULL',
    'TRUE',
    'FALSE',
]);

function isFunctionLikeDefault(value: string): boolean {
    const upper = value.toUpperCase();
    if (FUNCTION_DEFAULT_KEYWORDS.has(upper)) {
        return true;
    }
    if (/^[A-Z0-9_$]+\(/.test(upper)) {
        return true;
    }
    if (/^[-+]?(\d+\.?\d*|\.\d+)$/.test(value)) {
        return true;
    }
    if (upper === "ARRAY[]::" || upper.startsWith('ARRAY[') || upper.startsWith('ROW(')) {
        return true;
    }
    return false;
}

function isStringLikeType(type: string): boolean {
    const normalized = type.trim().toLowerCase();
    return /^(character varying|varchar|character|char|text|date|time|timestamp)/.test(normalized);
}

/**
 * Renders a DEFAULT expression the way a user would type it. Already-quoted
 * literals, casts, numbers, booleans, and function calls pass through verbatim;
 * bare words on string-like types get single-quoted.
 */
export function renderPostgresqlDefaultValue(value: string, type: string): string {
    const trimmed = value.trim();
    if (!trimmed) {
        return '';
    }
    if (trimmed.startsWith("'") || trimmed.startsWith('(') || trimmed.startsWith('"')) {
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

function renderDefaultClause(column: PostgresqlAlterTableDesignerColumn): string {
    const rendered = renderPostgresqlDefaultValue(column.defaultValue, column.type);
    return rendered ? ` DEFAULT ${rendered}` : '';
}

export function buildPostgresqlAddColumnSql(
    schema: string,
    tableName: string,
    column: PostgresqlAlterTableDesignerColumn,
): string {
    const name = requireValue(column.name, 'Column name');
    const type = requireColumnType(column.type);
    let definition = `${formatIdentifierForSql(name, 'postgresql')} ${type}`;
    if (column.notNull) {
        definition += ' NOT NULL';
    }
    definition += renderDefaultClause(column);
    return `ALTER TABLE ${formatQualifiedObjectName(undefined, schema, tableName, 'postgresql')} ADD COLUMN ${definition};`;
}

function columnChanged(left: PostgresqlAlterTableDesignerColumn, right: PostgresqlAlterTableDesignerColumn): boolean {
    return left.type.trim() !== right.type.trim()
        || left.notNull !== right.notNull
        || (left.defaultValue ?? '').trim() !== (right.defaultValue ?? '').trim()
        || (left.comment ?? '').trim() !== (right.comment ?? '').trim();
}

/**
 * Diffs the proposed design against the initial context. Returns an empty
 * string when nothing changed; otherwise one or more statements (ALTER TABLE
 * actions followed by COMMENT statements) separated by blank lines.
 */
export function buildPostgresqlAlterTableSql(
    context: PostgresqlAlterTableDesignerInitialContext,
    design: PostgresqlAlterTableDesign,
): string {
    const qualifiedTable = formatQualifiedObjectName(undefined, context.schema, context.tableName, 'postgresql');
    const originalColumns = new Map(context.columns.map(column => [identifierKey(column.name), column]));
    const designNames = new Set<string>();
    const statements: string[] = [];

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
            statements.push(buildPostgresqlAddColumnSql(context.schema, context.tableName, column));
            const comment = (column.comment ?? '').trim();
            if (comment) {
                statements.push(`COMMENT ON COLUMN ${qualifiedTable}.${formatIdentifierForSql(column.name, 'postgresql')} IS '${escapeLiteral(comment)}';`);
            }
            continue;
        }
        if (!columnChanged(original, column)) {
            continue;
        }

        const actions: string[] = [];
        if (original.type.trim() !== column.type.trim()) {
            actions.push(`ALTER COLUMN ${formatIdentifierForSql(column.name, 'postgresql')} TYPE ${requireColumnType(column.type)}`);
        }
        if (original.notNull !== column.notNull) {
            actions.push(`ALTER COLUMN ${formatIdentifierForSql(column.name, 'postgresql')} ${column.notNull ? 'SET' : 'DROP'} NOT NULL`);
        }
        const originalDefault = (original.defaultValue ?? '').trim();
        const newDefault = (column.defaultValue ?? '').trim();
        if (originalDefault !== newDefault) {
            actions.push(newDefault
                ? `ALTER COLUMN ${formatIdentifierForSql(column.name, 'postgresql')} SET DEFAULT ${renderPostgresqlDefaultValue(column.defaultValue, column.type)}`
                : `ALTER COLUMN ${formatIdentifierForSql(column.name, 'postgresql')} DROP DEFAULT`);
        }
        if (actions.length > 0) {
            statements.push(`ALTER TABLE ${qualifiedTable}\n    ${actions.join(',\n    ')};`);
        }

        if ((original.comment ?? '').trim() !== (column.comment ?? '').trim()) {
            statements.push(`COMMENT ON COLUMN ${qualifiedTable}.${formatIdentifierForSql(column.name, 'postgresql')} IS ${column.comment.trim() ? `'${escapeLiteral(column.comment.trim())}'` : 'NULL'};`);
        }
    }

    for (const original of context.columns) {
        if (designNames.has(identifierKey(original.name))) {
            continue;
        }
        if (original.isPrimaryKey) {
            throw new Error(`The PRIMARY KEY column "${original.name}" cannot be dropped from the Alter Table Designer.`);
        }
        statements.push(`ALTER TABLE ${qualifiedTable} DROP COLUMN ${formatIdentifierForSql(original.name, 'postgresql')};`);
    }

    const originalOptions = context.options;
    const options = design.options;
    const optionStatements: string[] = [];

    const newTablespace = options.tablespace.trim();
    const originalTablespace = originalOptions.tablespace.trim();
    if (newTablespace && newTablespace !== originalTablespace) {
        optionStatements.push(`ALTER TABLE ${qualifiedTable} SET TABLESPACE ${formatIdentifierForSql(requireTableOptionName(newTablespace, 'Tablespace'), 'postgresql')};`);
    }

    const newFillfactor = options.fillfactor.trim();
    const originalFillfactor = originalOptions.fillfactor.trim();
    if (newFillfactor && newFillfactor !== originalFillfactor) {
        optionStatements.push(`ALTER TABLE ${qualifiedTable} SET (fillfactor = ${requirePositiveInteger(newFillfactor, 'Fillfactor')});`);
    } else if (!newFillfactor && originalFillfactor) {
        optionStatements.push(`ALTER TABLE ${qualifiedTable} RESET (fillfactor);`);
    }

    const originalComment = originalOptions.comment.trim();
    const newComment = options.comment.trim();
    if (newComment !== originalComment) {
        optionStatements.push(`COMMENT ON TABLE ${qualifiedTable} IS ${newComment ? `'${escapeLiteral(newComment)}'` : 'NULL'};`);
    }

    return [...statements, ...optionStatements].join('\n\n');
}

export function hasPostgresqlAlterTableChanges(
    context: PostgresqlAlterTableDesignerInitialContext,
    design: PostgresqlAlterTableDesign,
): boolean {
    return buildPostgresqlAlterTableSql(context, design) !== '';
}