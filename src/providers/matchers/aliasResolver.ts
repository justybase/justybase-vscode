/**
 * Utilities for resolving table aliases in SQL
 */

import { AliasInfo, TableReference } from '../types';

/**
 * Extract the current SQL statement context around cursor position
 * Finds text between semicolons (or document boundaries) that contains the cursor
 * 
 * Example:
 * SELECT * FROM TABLE1 T;
 * SELECT T.column FROM TABLE2 T;  <-- cursor here
 * SELECT * FROM TABLE3 T;
 * 
 * Returns: "SELECT T.column FROM TABLE2 T;"
 */
// export function extractCurrentStatement(fullText: string, cursorOffset: number): string {
//     // Find the previous semicolon (or start of document)
//     let startPos = fullText.lastIndexOf(';', cursorOffset - 1);
//     if (startPos === -1) {
//         startPos = 0;
//     } else {
//         startPos += 1; // Skip the semicolon itself
//     }

//     // Find the next semicolon (or end of document)
//     let endPos = fullText.indexOf(';', cursorOffset);
//     if (endPos === -1) {
//         endPos = fullText.length;
//     } else {
//         endPos += 1; // Include the semicolon
//     }

//     return fullText.substring(startPos, endPos).trim();
// }


// export function extractCurrentStatement(fullText: string, cursorOffset: number): string {
//   let s = fullText.lastIndexOf(';', cursorOffset - 1);
//   s = s < 0 ? 0 : s + 1;

//   let e = fullText.indexOf(';', cursorOffset);
//   if (e < 0) e = fullText.length;
//   else e++;

//   return fullText.slice(s, e).trim();
// }

import * as vscode from 'vscode';

export function getCurrentSqlStatementRange(
  document: vscode.TextDocument,
  position: vscode.Position
): vscode.Range {
  const text = document.getText();
  const cursorOffset = document.offsetAt(position);

  let start = cursorOffset;
  while (start > 0 && text.charCodeAt(start - 1) !== 59) {
    start--;
  }

  let end = cursorOffset;
  while (end < text.length && text.charCodeAt(end) !== 59) {
    end++;
  }

  if (end < text.length) end++; // include ;

  return new vscode.Range(
    document.positionAt(start),
    document.positionAt(end)
  );
}



/**
 * Find alias definition for a given identifier in the context before cursor
 * Searches BACKWARD from cursor position to find the most recent (contextually relevant) alias
 * 
 * Examples:
 * - "FROM DB.SCHEMA.TABLE T" -> T aliased to TABLE
 * - "FROM TABLE" -> TABLE is self-aliased
 * 
 * IMPORTANT: This searches from the END of text backwards to find the most recent alias definition
 * before the cursor position. This ensures we get the correct alias in multi-statement contexts.
 */
export function findAlias(text: string, alias: string): AliasInfo | null {
    // We need to find the LAST occurrence of this alias definition before the cursor
    // To do this, we collect ALL matches and return the last one
    
    const regex = new RegExp(`(?:FROM|JOIN)\\s+([a-zA-Z0-9_\\.]+)(?:\\s+(?:AS\\s+)?([a-zA-Z0-9_]+))?`, 'gi');
    let match;
    let lastMatch: AliasInfo | null = null;
    
    while ((match = regex.exec(text)) !== null) {
        const fullRef = match[1]; // DB.SCHEMA.TABLE
        const foundAlias = match[2]; // ALIAS (optional)

        if (foundAlias && foundAlias.toUpperCase() === alias.toUpperCase()) {
            lastMatch = parseTableReference(fullRef);
        } else if (!foundAlias) {
            // If no alias, the table name itself is the alias reference
            const parts = fullRef.split('.');
            const tableName = parts[parts.length - 1];
            if (tableName.toUpperCase() === alias.toUpperCase()) {
                lastMatch = parseTableReference(fullRef);
            }
        }
    }
    
    return lastMatch;
}






/**
 * Get all tables and their aliases before cursor position
 */
export function getTableAndAliasBeforeCursor(text: string): TableReference[] {
    const results: TableReference[] = [];
    
    // Extract all table references and their aliases
    // Matches: FROM table_ref, JOIN table_ref [AS] alias
    const regex = /(?:FROM|JOIN)\s+([a-zA-Z0-9_.]+)(?:\s+(?:AS\s+)?([a-zA-Z0-9_]+))?/gi;

    let match;
    while ((match = regex.exec(text)) !== null) {
        const tableRef = match[1];
        const alias = match[2];

        const parsed = parseTableReference(tableRef);
        results.push({ 
            ...parsed, 
            alias: alias || parsed.table 
        });
    }
    
    return results;
}

/**
 * Parse a table reference string into components
 * 
 * Examples:
 * - "TABLE" -> { table: "TABLE" }
 * - "SCHEMA.TABLE" -> { schema: "SCHEMA", table: "TABLE" }
 * - "DB.SCHEMA.TABLE" -> { db: "DB", schema: "SCHEMA", table: "TABLE" }
 */
function parseTableReference(fullRef: string): { db?: string; schema?: string; table: string } {
    const parts = fullRef.split('.');
    
    if (parts.length === 3) {
        return { db: parts[0], schema: parts[1], table: parts[2] };
    } else if (parts.length === 2) {
        return { schema: parts[0], table: parts[1] };
    } else {
        return { table: parts[0] };
    }
}
