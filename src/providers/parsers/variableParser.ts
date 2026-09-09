/**
 * Parser for SQL variables (@SET VARIABLE = ...)
 */

import { normalizeVariableName } from '../../core/variableUtils';

/**
 * Parse script variable definitions from SQL text.
 * 
 * Example:
 * @SET VAR1 = 'value';
 * @SET VAR2 = 123;
 * @SET VAR3 = SELECT * FROM ...;
 */
export function parseVariables(text: string): string[] {
    const variables = new Set<string>();

    // Parse: @SET VARIABLE_NAME = value ;, %LET VARIABLE_NAME = value ;,
    // or DECLARE &VARIABLE_NAME = value ;.
    const varRegex = /(?:@SET\s+([a-zA-Z0-9_]+)|%LET\s+([A-Za-z_][A-Za-z0-9_]*)|DECLARE\s+&([A-Za-z_][A-Za-z0-9_]*))\s*=/gi;
    let match: RegExpExecArray | null;

    while ((match = varRegex.exec(text)) !== null) {
        const name = match[1] ?? match[2] ?? match[3];
        if (name) variables.add(normalizeVariableName(name));
    }

    return Array.from(variables).sort();
}
