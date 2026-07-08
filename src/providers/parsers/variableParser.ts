/**
 * Parser for SQL variables (@SET VARIABLE = ...)
 */

import { normalizeVariableName } from '../../core/variableUtils';

/**
 * Parse @SET variable definitions from SQL text
 * 
 * Example:
 * @SET VAR1 = 'value';
 * @SET VAR2 = 123;
 * @SET VAR3 = SELECT * FROM ...;
 */
export function parseVariables(text: string): string[] {
    const variables = new Set<string>();

    // Parse: @SET VARIABLE_NAME = value ;
    const varRegex = /@SET\s+([a-zA-Z0-9_]+)\s*=/gi;
    let match: RegExpExecArray | null;

    while ((match = varRegex.exec(text)) !== null) {
        variables.add(normalizeVariableName(match[1]));
    }

    return Array.from(variables).sort();
}
