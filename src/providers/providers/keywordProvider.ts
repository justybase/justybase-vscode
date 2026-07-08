/**
 * Provider for SQL keywords
 */

import * as vscode from 'vscode';

/**
 * Get SQL keyword completion items
 */
export function getKeywords(): vscode.CompletionItem[] {
    const keywords = [
        'SELECT', 'FROM', 'WHERE', 'GROUP BY', 'ORDER BY', 'LIMIT', 'INSERT', 'INTO', 'VALUES',
        'UPDATE', 'SET', 'DELETE', 'CREATE', 'DROP', 'TABLE', 'VIEW', 'DATABASE', 'JOIN',
        'INNER', 'LEFT', 'RIGHT', 'OUTER', 'ON', 'AND', 'OR', 'NOT', 'NULL', 'IS', 'NOTNULL', 'IN',
        'BETWEEN', 'LIKE', 'AS', 'DISTINCT', 'CASE', 'WHEN', 'THEN', 'ELSE', 'END', 'WITH',
        'UNION', 'ALL'
    ];
    
    return keywords.map(k => {
        const item = new vscode.CompletionItem(k, vscode.CompletionItemKind.Keyword);
        item.detail = 'SQL Keyword';
        return item;
    });
}
