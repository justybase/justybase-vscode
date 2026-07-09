import {
    MacroEnvironment,
    MacroPreprocessor,
    type MacroPreprocessResult,
} from './macroPreprocessor';

/**
 * SQL Variable Utilities
 * Handles SQL variable extraction, parsing inline declarations, and replacement.
 * Inline declarations are scoped to the current query/script execution; only
 * interactively prompted values are persisted as history by the resolver.
 */

export function normalizeVariableName(name: string): string {
    return name.trim().toUpperCase()
}

export function normalizeVariableValues(values?: Record<string, string>): Record<string, string> {
    const normalized: Record<string, string> = {}
    if (!values) {
        return normalized
    }

    for (const [name, value] of Object.entries(values)) {
        normalized[normalizeVariableName(name)] = value
    }

    return normalized
}

export function formatPutLogMessage(message: string): string {
    return `>>> %PUT: ${message}`;
}

/** Log %PUT, %INCLUDE, %IF branch, %EXPORT, and error events from macro preprocessing. */
export function logMacroPreprocessResult(
    result: Pick<MacroPreprocessResult, 'putMessages' | 'scriptEvents'>,
    logCallback?: (message: string) => void,
): void {
    if (!logCallback) {
        return;
    }

    // Preprocessor emits matching %PUT entries in both arrays; scriptEvents is the
    // superset used for logging (includes branch/include/export/error events).
    if (result.scriptEvents && result.scriptEvents.length > 0) {
        for (const event of result.scriptEvents) {
            logCallback(event.message);
        }
        return;
    }

    result.putMessages.forEach(message => logCallback(formatPutLogMessage(message)));
}

/**
 * Extract placeholder variable names from SQL.
 * Supports four formats:
 * - ${VAR_NAME} - variable in curly braces with dollar sign
 * - $VAR_NAME - variable with dollar sign only (must start with letter or underscore)
 * - &VAR_NAME - SAS-style macro variable reference
 * - {VAR_NAME} - variable in curly braces only (must start with letter or underscore)
 *
 * Variables are matched case-insensitively and normalized to upper case.
 * Variables inside comments or string literals are ignored.
 *
 * @param sql - The SQL string to scan for variables
 * @returns Set of variable names found in the SQL
 *
 * @example
 * extractVariables("SELECT * FROM ${TABLE} WHERE id = $ID")
 * // Returns: Set(['TABLE', 'ID'])
 *
 * @example
 * extractVariables("SELECT * FROM {TABLE} WHERE id = {ID}")
 * // Returns: Set(['TABLE', 'ID'])
 *
 * @example
 * extractVariables("-- SELECT $VAR\nSELECT * FROM ${TABLE}")
 * // Returns: Set(['TABLE']) - $VAR is in a comment
 *
 * @example
 * extractVariables("SELECT '$VAR' as col, ${TABLE}")
 * // Returns: Set(['TABLE']) - $VAR is in a string
 */
export function extractVariables(sql: string): Set<string> {
    const vars = new Set<string>();
    if (!sql) return vars;

    // Remove comments and strings before extracting variables
    const cleanedSql = removeCommentsAndStrings(sql);

    // Match ${VAR_NAME} format (letters, digits, underscores; optional inner whitespace)
    for (const m of cleanedSql.matchAll(/\$\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}/g)) {
        if (m[1]) vars.add(normalizeVariableName(m[1]));
    }

    // Match $VAR_NAME format (must start with letter or underscore)
    // Use negative lookbehind to avoid matching ${VAR} pattern
    // and negative lookahead to not match if followed by {
    for (const m of cleanedSql.matchAll(/\$([A-Za-z_][A-Za-z0-9_]*)(?!\s*\})/g)) {
        // Skip if this is part of ${...} pattern (check if preceded by ${ )
        const fullMatch = m[0];
        const idx = m.index!;
        // Check if previous char is { (would mean we're inside ${VAR})
        if (idx > 0 && cleanedSql[idx - 1] === '{') continue;
        // Check if next char after match is } (would mean ${VAR})
        const afterIdx = idx + fullMatch.length;
        if (afterIdx < cleanedSql.length && cleanedSql[afterIdx] === '}') continue;

        if (m[1]) vars.add(normalizeVariableName(m[1]));
    }

    // Match &VAR_NAME format (SAS-style macro variable reference)
    for (const m of cleanedSql.matchAll(/&([A-Za-z_][A-Za-z0-9_]*)/g)) {
        if (m[1]) vars.add(normalizeVariableName(m[1]));
    }

    // Match {VAR_NAME} format (must start with letter or underscore, no dollar sign)
    // This is processed after ${VAR} to avoid conflicts
    for (const m of cleanedSql.matchAll(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g)) {
        // Skip if this is part of ${...} pattern (check if preceded by $)
        const idx = m.index!;
        if (idx > 0 && cleanedSql[idx - 1] === '$') continue;

        if (m[1]) vars.add(normalizeVariableName(m[1]));
    }

    return vars;
}

/**
 * Remove comments and string literals from SQL to avoid extracting variables from them.
 * Handles:
 * - Single-line comments: -- comment
 * - Multi-line comments: /* comment *\/
 * - Single-quoted strings: 'text'
 * - Double-quoted strings: "text"
 *
 * @param sql - The SQL string to clean
 * @returns SQL string with comments and strings replaced with placeholders
 */
function removeCommentsAndStrings(sql: string): string {
    let result = '';
    let i = 0;

    while (i < sql.length) {
        // Check for single-line comment: --
        if (sql[i] === '-' && i + 1 < sql.length && sql[i + 1] === '-') {
            // Skip until end of line
            while (i < sql.length && sql[i] !== '\n') {
                i++;
            }
            // Keep the newline
            if (i < sql.length) {
                result += '\n';
                i++;
            }
            continue;
        }

        // Check for multi-line comment: /*
        if (sql[i] === '/' && i + 1 < sql.length && sql[i + 1] === '*') {
            i += 2;
            // Skip until */
            while (i + 1 < sql.length && !(sql[i] === '*' && sql[i + 1] === '/')) {
                i++;
            }
            i += 2; // Skip */
            continue;
        }

        // Check for single-quoted string: '...'
        if (sql[i] === "'") {
            result += ' '; // Replace with space to preserve positions
            i++;
            // Skip until closing quote (handle escaped quotes '')
            while (i < sql.length) {
                if (sql[i] === "'" && (i + 1 >= sql.length || sql[i + 1] !== "'")) {
                    break;
                }
                if (sql[i] === "'" && i + 1 < sql.length && sql[i + 1] === "'") {
                    // Escaped quote ''
                    i += 2;
                } else {
                    i++;
                }
            }
            if (i < sql.length) {
                i++; // Skip closing quote
            }
            continue;
        }

        // Check for double-quoted string: "..."
        if (sql[i] === '"') {
            result += ' '; // Replace with space to preserve positions
            i++;
            // Skip until closing quote (handle escaped quotes "")
            while (i < sql.length) {
                if (sql[i] === '"' && (i + 1 >= sql.length || sql[i + 1] !== '"')) {
                    break;
                }
                if (sql[i] === '"' && i + 1 < sql.length && sql[i + 1] === '"') {
                    // Escaped quote ""
                    i += 2;
                } else {
                    i++;
                }
            }
            if (i < sql.length) {
                i++; // Skip closing quote
            }
            continue;
        }

        // Keep regular characters
        result += sql[i];
        i++;
    }

    return result;
}

/**
 * Parsed result from inline variable declaration scanning
 */
export interface ParseSetResult {
    /** SQL with inline declaration lines removed */
    sql: string;
    /** Map of variable name to default value */
    setValues: Record<string, string>;
    /** Messages emitted by %PUT directives */
    putMessages?: string[];
}

/**
 * Parse lines like `@SET NAME = value` and `%let NAME = value;` (case-insensitive).
 * Removes those lines from SQL and returns execution-scoped defaults.
 * 
 * @param sql - The SQL string to parse
 * @returns Object with cleaned SQL and extracted set values
 * 
 * @example
 * parseSetVariables("@SET TABLE = users\nSELECT * FROM ${TABLE}")
 * // Returns: { sql: "SELECT * FROM ${TABLE}", setValues: { TABLE: "users" } }
 */
export function parseSetVariables(
    sql: string,
    initialValues: Record<string, string> = {},
): ParseSetResult {
    const result = new MacroPreprocessor().processScriptSync(sql, {
        environment: new MacroEnvironment(initialValues),
        replaceVariables: false,
        resolvePutMessages: true,
    });

    if (result.putMessages.length === 0) {
        return { sql: result.sql, setValues: result.variables };
    }

    return {
        sql: result.sql,
        setValues: result.variables,
        putMessages: result.putMessages,
    };
}


/**
 * Replace variable placeholders in SQL with provided values.
 * Supports four formats:
 * - ${VAR_NAME} - variable in curly braces with dollar sign
 * - $VAR_NAME - variable with dollar sign only
 * - &VAR_NAME - SAS-style macro variable reference
 * - {VAR_NAME} - variable in curly braces only
 * 
 * @param sql - The SQL string with placeholders
 * @param values - Record mapping variable names to their values
 * @returns SQL string with all placeholders replaced
 * 
 * @example
 * replaceVariablesInSql("SELECT * FROM ${TABLE} WHERE id = $ID", { TABLE: "users", ID: "42" })
 * // Returns: "SELECT * FROM users WHERE id = 42"
 * 
 * @example
 * replaceVariablesInSql("SELECT * FROM {TABLE} WHERE id = {ID}", { TABLE: "users", ID: "42" })
 * // Returns: "SELECT * FROM users WHERE id = 42"
 */
export function replaceVariablesInSql(sql: string, values: Record<string, string>): string {
    const normalizedValues = normalizeVariableValues(values)

    // First replace ${VAR_NAME} format
    let result = sql.replace(/\$\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}/g, (_match: string, name: string) => {
        return normalizedValues[normalizeVariableName(name)] ?? '';
    });

    // Then replace $VAR_NAME format (must start with letter or underscore)
    result = result.replace(
        /\$([A-Za-z_][A-Za-z0-9_]*)(?!\s*\})/g,
        (match: string, name: string, offset: number, fullText: string) => {
            if (offset > 0 && fullText[offset - 1] === '{') {
                return match
            }

            const afterMatchIndex = offset + match.length
            if (afterMatchIndex < fullText.length && fullText[afterMatchIndex] === '}') {
                return match
            }

            return normalizedValues[normalizeVariableName(name)] ?? match
        }
    )

    // Then replace &VAR_NAME format (SAS-style macro variable reference)
    result = result.replace(/&([A-Za-z_][A-Za-z0-9_]*)/g, (match: string, name: string) => {
        return normalizedValues[normalizeVariableName(name)] ?? match
    })

    // Finally replace {VAR_NAME} format (without dollar sign)
    result = result.replace(
        /\{([A-Za-z_][A-Za-z0-9_]*)\}/g,
        (match: string, name: string, offset: number, fullText: string) => {
            if (offset > 0 && fullText[offset - 1] === '$') {
                return match
            }

            return normalizedValues[normalizeVariableName(name)] ?? ''
        }
    )

    return result;
}

/**
 * Extract all unique variables from multiple SQL queries.
 * This is useful when you want to prompt for all variables once before executing multiple queries.
 * 
 * @param queries - Array of SQL query strings
 * @returns Set of all unique variable names found across all queries
 * 
 * @example
 * extractVariablesFromQueries(['SELECT $VAR1', 'SELECT ${VAR2}', 'SELECT $VAR1'])
 * // Returns: Set(['VAR1', 'VAR2'])
 */
export function extractVariablesFromQueries(queries: string[]): Set<string> {
    const allVars = new Set<string>();
    for (const query of queries) {
        const parsed = parseSetVariables(query);
        const vars = extractVariables(parsed.sql);
        vars.forEach(v => allVars.add(v));
    }
    return allVars;
}

/**
 * Full variable processing pipeline:
 * 1. Parse inline declarations
 * 2. Extract ${VAR} placeholders
 * 3. Merge defaults with provided overrides
 * 4. Replace all placeholders
 * 
 * @param sql - The SQL string to process
 * @param overrides - Optional overrides for variable values
 * @returns Processed SQL with all variables resolved
 */
export function processVariables(
    sql: string,
    overrides?: Record<string, string>
): { processedSql: string; unresolvedVars: string[] } {
    // Step 1: Parse inline declarations
    const parsed = parseSetVariables(sql);

    // Step 2: Extract variables from remaining SQL
    const vars = extractVariables(parsed.sql);

    // Step 3: Merge defaults with overrides
    const values: Record<string, string> = {
        ...parsed.setValues,
        ...normalizeVariableValues(overrides)
    };

    // Step 4: Find unresolved variables
    const unresolvedVars = Array.from(vars).filter(v => values[v] === undefined);

    // Step 5: Replace all resolvable placeholders
    const processedSql = replaceVariablesInSql(parsed.sql, values);

    return { processedSql, unresolvedVars };
}
