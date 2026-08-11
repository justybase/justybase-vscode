/**
 * Validation for user-edited CREATE TABLE DDL before migration execution.
 *
 * The row-load path (INSERT / COPY / external table) references the mapped
 * target column names, so users may freely adjust types, defaults and
 * constraints, but column names must stay present in the DDL.
 */

export interface CustomDdlValidationResult {
    valid: boolean;
    message: string;
}

export function validateCustomCreateTableDdl(
    ddl: string,
    targetColumnNames: readonly string[],
    expectedTargetQualifiedName?: string,
): CustomDdlValidationResult {
    const trimmed = ddl.trim();

    if (!trimmed) {
        return { valid: false, message: 'CREATE TABLE DDL is empty.' };
    }

    const createTableTargets = extractCreateTableTargets(trimmed);
    if (createTableTargets.length === 0) {
        return {
            valid: false,
            message: 'Edited DDL must start with a CREATE TABLE statement.',
        };
    }

    if (expectedTargetQualifiedName) {
        const expectedTarget = normalizeQualifiedIdentifier(expectedTargetQualifiedName);
        const actualTarget = createTableTargets.length === 1
            ? normalizeQualifiedIdentifier(createTableTargets[0])
            : undefined;
        if (!actualTarget || actualTarget !== expectedTarget) {
            return {
                valid: false,
                message: `CREATE TABLE target must remain ${expectedTargetQualifiedName}.`,
            };
        }
    }

    const upper = trimmed.toUpperCase();
    const missing = targetColumnNames.filter(
        columnName => !containsIdentifier(upper, columnName.toUpperCase()),
    );

    if (missing.length > 0) {
        return {
            valid: false,
            message: `Column names must stay unchanged. Missing from DDL: ${missing.join(', ')}.`,
        };
    }

    return { valid: true, message: '' };
}

/** Extract every CREATE TABLE target so a prepended or alternate CREATE cannot pass validation. */
function extractCreateTableTargets(ddl: string): string[] {
    const targets: string[] = [];
    const createTablePattern = /\bCREATE\s+(?:(?:OR\s+REPLACE|GLOBAL\s+TEMPORARY|LOCAL\s+TEMPORARY|TEMPORARY|TEMP)\s+)*TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([\s\S]*?)(?=\s*\(|\s+AS\b)/gi;
    for (const match of ddl.matchAll(createTablePattern)) {
        const target = match[1]?.trim();
        if (target) {
            targets.push(target);
        }
    }
    return targets;
}

function normalizeQualifiedIdentifier(value: string): string {
    const parts: string[] = [];
    let current = '';
    let quote: '"' | '`' | ']' | undefined;
    for (const character of value.trim()) {
        if (quote) {
            current += character;
            if (character === quote || (quote === ']' && character === ']')) {
                quote = undefined;
            }
            continue;
        }
        if (character === '"' || character === '`') {
            quote = character;
            current += character;
        } else if (character === '[') {
            quote = ']';
            current += character;
        } else if (character === '.') {
            parts.push(unquoteIdentifier(current.trim()));
            current = '';
        } else {
            current += character;
        }
    }
    if (current.trim() || parts.length > 0) {
        parts.push(unquoteIdentifier(current.trim()));
    }
    return parts.join('.').toUpperCase();
}

function unquoteIdentifier(value: string): string {
    if (value.length >= 2) {
        const first = value[0];
        const last = value[value.length - 1];
        if ((first === '"' && last === '"') || (first === '`' && last === '`')) {
            return value.slice(1, -1).replace(new RegExp(`\\${first}`, 'g'), first);
        }
        if (first === '[' && last === ']') {
            return value.slice(1, -1).replace(/\]\]/g, ']');
        }
    }
    return value;
}

function containsIdentifier(haystack: string, needle: string): boolean {
    if (!needle) {
        return true;
    }
    const quoted = `"${needle.replace(/"/g, '""')}"`;
    return haystack.includes(`"${needle}"`)
        || haystack.includes(quoted)
        || new RegExp(`(^|[^A-Z0-9_])${escapeRegExp(needle)}($|[^A-Z0-9_])`).test(haystack);
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
