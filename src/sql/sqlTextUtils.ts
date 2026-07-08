/**
 * SQL Text Utilities for processing source code
 * Used by Object Search to filter out comments and string literals
 */

import {
  stripComments,
  stripCommentsAndLiterals,
} from "./sqlSourceScan";

export { stripComments, stripCommentsAndLiterals };

/**
 * Checks if the search term exists in the SQL source code,
 * excluding comments and string literals.
 *
 * @param sql The SQL source code to search in
 * @param term The search term (case-insensitive)
 * @returns true if term is found in code (not in comments/literals)
 */
export function searchInCode(sql: string, term: string): boolean {
    const cleanedSql = stripCommentsAndLiterals(sql);
    return cleanedSql.toUpperCase().includes(term.toUpperCase());
}

/**
 * Search mode for source code search
 * - 'raw': Search in entire source (including comments and strings)
 * - 'noComments': Search excluding comments (-- and block comments)
 * - 'noCommentsNoLiterals': Search excluding comments and string literals
 */
export type SourceSearchMode = 'raw' | 'noComments' | 'noCommentsNoLiterals';

/**
 * Searches for a term in SQL source code using the specified mode.
 *
 * @param sql The SQL source code to search in
 * @param term The search term (case-insensitive)
 * @param mode The search mode: 'raw', 'noComments', or 'noCommentsNoLiterals'
 * @returns true if term is found according to the mode
 */
export function searchInCodeWithMode(sql: string, term: string, mode: SourceSearchMode): boolean {
    let searchText: string;

    switch (mode) {
        case 'raw':
            searchText = sql;
            break;
        case 'noComments':
            searchText = stripComments(sql);
            break;
        case 'noCommentsNoLiterals':
        default:
            searchText = stripCommentsAndLiterals(sql);
            break;
    }

    return searchText.toUpperCase().includes(term.toUpperCase());
}
