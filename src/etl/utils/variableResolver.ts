/**
 * Variable Resolver
 * Handles ${variable} and {variable} substitution in template strings
 */

import { IVariableResolver } from '../interfaces';

/**
 * Default implementation of variable resolver
 * Replaces ${variable} and {variable} patterns with values from the variables map
 */
export class VariableResolver implements IVariableResolver {
    /**
     * Resolve all variable references in a template string
     * Supports two formats:
     * - ${variable} - variable with dollar sign and braces
     * - {variable} - variable with braces only
     * @param template String containing ${variable} or {variable} patterns
     * @param variables Map of variable names to values
     * @returns String with all variables substituted
     */
    resolve(template: string, variables: Record<string, string>): string {
        if (!template || !variables || Object.keys(variables).length === 0) {
            return template;
        }

        let result = template;
        for (const [key, value] of Object.entries(variables)) {
            // First replace ${variable} format
            const patternWithDollar = new RegExp(`\\$\\{${this.escapeRegex(key)}\\}`, 'g');
            result = result.replace(patternWithDollar, value);

            // Then replace {variable} format (without dollar sign)
            const patternBracesOnly = new RegExp(`(?<!\\$)\\{${this.escapeRegex(key)}\\}`, 'g');
            result = result.replace(patternBracesOnly, value);
        }
        return result;
    }

    /**
     * Resolve multiple templates at once
     * @param templates Array of template strings
     * @param variables Map of variable names to values
     * @returns Array of resolved strings
     */
    resolveAll(templates: string[], variables: Record<string, string>): string[] {
        return templates.map(t => this.resolve(t, variables));
    }

    /**
     * Escape special regex characters in a string
     */
    private escapeRegex(str: string): string {
        return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
}

/**
 * Singleton instance for convenience
 */
export const variableResolver = new VariableResolver();
