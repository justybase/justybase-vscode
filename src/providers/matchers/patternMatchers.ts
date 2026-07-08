/**
 * Pattern matchers for SQL completion triggers
 */

import { JoinOnMatch, DbMatch, SchemaMatch, TableMatch } from '../types';

/**
 * Match JOIN ON pattern
 * Trigger: "JOIN ... ON " or "JOIN ... ON Alias.Col "
 */
export function matchJoinOn(linePrefix: string): JoinOnMatch | null {
    const match = linePrefix.match(/(?:JOIN)\s+([a-zA-Z0-9_.]+)(?:\s+(?:AS\s+)?([a-zA-Z0-9_]+))?\s+ON(?:\s+([a-zA-Z0-9_.]+))?\s+$/i);
    
    if (match) {
        return {
            tableRef: match[1],
            alias: match[2],
            typedPrefix: match[3]
        };
    }
    
    return null;
}

/**
 * Match FROM/JOIN with partial identifier
 * Trigger: "FROM ABC" or "JOIN TABLE_"
 */
export function matchFromJoinPartial(linePrefix: string): string | null {
    const match = linePrefix.match(/(?:FROM|JOIN)\s+([a-zA-Z0-9_]*)$/i);
    return match ? match[1] : null;
}

/**
 * Check if current line continues FROM/JOIN from previous line
 */
export function isMultiLineFromJoin(prevLine: string, linePrefix: string): boolean {
    return /(?:FROM|JOIN)\s*$/i.test(prevLine) && /^\s*([a-zA-Z0-9_]*)$/.test(linePrefix);
}

/**
 * Match database qualifier pattern
 * Trigger: "FROM DB." or "FROM DB.S"
 */
export function matchDatabase(linePrefix: string, prevLine?: string): DbMatch | null {
    // Same line pattern
    const sameLineMatch = linePrefix.match(/(?:FROM|JOIN)\s+([a-zA-Z0-9_]+)\.([a-zA-Z0-9_]*)$/i);
    if (sameLineMatch) {
        return {
            dbName: sameLineMatch[1],
            partial: sameLineMatch[2]
        };
    }
    
    // Multi-line pattern
    if (prevLine && /(?:FROM|JOIN)\s*$/i.test(prevLine)) {
        const currentMatch = linePrefix.match(/^\s*([a-zA-Z0-9_]+)\.([a-zA-Z0-9_]*)$/i);
        if (currentMatch) {
            return {
                dbName: currentMatch[1],
                partial: currentMatch[2]
            };
        }
    }
    
    return null;
}

/**
 * Match schema qualifier pattern
 * Trigger: "FROM DB.SCHEMA." or "FROM DB.SCHEMA.T"
 */
export function matchSchema(linePrefix: string, prevLine?: string): SchemaMatch | null {
    // Same line pattern
    const sameLineMatch = linePrefix.match(/(?:FROM|JOIN)\s+([a-zA-Z0-9_]+)\.([a-zA-Z0-9_]+)\.([a-zA-Z0-9_]*)$/i);
    if (sameLineMatch) {
        return {
            dbName: sameLineMatch[1],
            schemaName: sameLineMatch[2],
            partial: sameLineMatch[3]
        };
    }
    
    // Multi-line pattern
    if (prevLine && /(?:FROM|JOIN)\s*$/i.test(prevLine)) {
        const currentMatch = linePrefix.match(/^\s*([a-zA-Z0-9_]+)\.([a-zA-Z0-9_]+)\.([a-zA-Z0-9_]*)$/i);
        if (currentMatch) {
            return {
                dbName: currentMatch[1],
                schemaName: currentMatch[2],
                partial: currentMatch[3]
            };
        }
    }
    
    return null;
}

/**
 * Match double-dot pattern (no schema)
 * Trigger: "FROM DB.." or "FROM DB..T"
 */
export function matchDoubleDot(linePrefix: string, prevLine?: string): TableMatch | null {
    // Same line pattern
    const sameLineMatch = linePrefix.match(/(?:FROM|JOIN)\s+([a-zA-Z0-9_]+)\.\.([a-zA-Z0-9_]*)$/i);
    if (sameLineMatch) {
        return {
            dbName: sameLineMatch[1],
            partial: sameLineMatch[2]
        };
    }
    
    // Multi-line pattern
    if (prevLine && /(?:FROM|JOIN)\s*$/i.test(prevLine)) {
        const currentMatch = linePrefix.match(/^\s*([a-zA-Z0-9_]+)\.\.([a-zA-Z0-9_]*)$/i);
        if (currentMatch) {
            return {
                dbName: currentMatch[1],
                partial: currentMatch[2]
            };
        }
    }
    
    return null;
}

/**
 * Match column qualifier pattern
 * Trigger: "ALIAS." or "TABLE."
 */
export function matchColumnQualifier(linePrefix: string): string | null {
    if (!linePrefix.trim().endsWith('.')) {
        return null;
    }
    
    const match = linePrefix.match(/([a-zA-Z0-9_]+)\.$/);
    return match ? match[1] : null;
}

/**
 * Match column expansion pattern
 * Trigger: "ALIAS.*" for expanding to all columns
 */
export function matchColumnExpansion(linePrefix: string): string | null {
    if (!linePrefix.trim().endsWith('.*')) {
        return null;
    }
    
    const match = linePrefix.match(/([a-zA-Z0-9_]+)\.\*$/);
    return match ? match[1] : null;
}

/**
 * Match variable pattern
 * Trigger: "$" or "${" or "${VAR"
 */
export function matchVariable(linePrefix: string): boolean {
    return /\$\{?[a-zA-Z0-9_]*$/.test(linePrefix);
}

/**
 * Get variable insertion mode based on what user has typed
 */
export function getVariableInsertionMode(linePrefix: string): 'full' | 'partial' | 'name-only' {
    if (linePrefix.endsWith('${')) {
        return 'name-only'; // User typed '${' -> insert 'VAR_NAME}'
    } else if (linePrefix.endsWith('$')) {
        return 'partial'; // User typed '$' -> insert '{VAR_NAME}'
    } else {
        return 'full'; // No '$' typed -> insert '${VAR_NAME}'
    }
}
