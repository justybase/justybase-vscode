/**
 * Parser for SQL local definitions (CTEs, temp tables, subqueries)
 */

import { LocalDefinition } from '../types';

/**
 * Parse local definitions from SQL text including:
 * - Temp tables (CREATE TABLE ... AS)
 * - CTEs (WITH ... AS)
 * - Subqueries in JOINs (JOIN (SELECT ...) Alias)
 */
export function parseLocalDefinitions(text: string): LocalDefinition[] {
    const definitions: LocalDefinition[] = [];

    // 1. Temp Tables: CREATE TABLE TEMP_1 AS ( SELECT ... ) OR CREATE TABLE TEMP_1 AS SELECT ...
    parseTempTables(text, definitions);

    // 2. CTEs: WITH ABC AS ( ... ), DEF AS ( ... )
    parseCTEs(text, definitions);

    // 3. Subqueries in JOINs: JOIN (SELECT ...) Alias
    parseJoinSubqueries(text, definitions);

    return definitions;
}

/**
 * Parse temp table and CTAS definitions
 */
function parseTempTables(text: string, definitions: LocalDefinition[]): void {
    const qualifiedNamePattern =
        '(?:[\\w$#]+|"[^"]+")(?:\\s*\\.\\s*\\.?\\s*(?:[\\w$#]+|"[^"]+")){0,2}';
    const tempTableRegex = new RegExp(
        `CREATE\\s+(?:GLOBAL\\s+)?(?:(?:TEMP|TEMPORARY)\\s+)?TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?(${qualifiedNamePattern})\\s+AS\\b`,
        'gi',
    );
    const ctasRegex = new RegExp(
        `CREATE\\s+(?!(?:GLOBAL\\s+)?(?:(?:TEMP|TEMPORARY)\\s+))TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?(${qualifiedNamePattern})\\s+AS\\b`,
        'gi',
    );

    parseCreateTableAsMatches(text, tempTableRegex, definitions, (tableName, isGlobal) => ({
        name: normalizeQualifiedObjectName(tableName),
        type: isGlobal ? 'Global Temp Table' : 'Temp Table',
    }), (match) => /\bGLOBAL\b/i.test(match[0]));

    parseCreateTableAsMatches(text, ctasRegex, definitions, (tableName) => ({
        name: normalizeQualifiedObjectName(tableName),
        type: 'Table',
    }));
}

function normalizeQualifiedObjectName(name: string): string {
    return name
        .replace(/\s*\.\s*\.\s*/g, '..')
        .replace(/\s*\.\s*/g, '.')
        .trim();
}

function parseCreateTableAsMatches(
    text: string,
    regex: RegExp,
    definitions: LocalDefinition[],
    buildDefinition: (tableName: string, isGlobal: boolean) => Pick<LocalDefinition, 'name' | 'type'>,
    isGlobalMatch: (match: RegExpExecArray) => boolean = () => false,
): void {
    let match: RegExpExecArray | null;
    regex.lastIndex = 0;

    while ((match = regex.exec(text)) !== null) {
        const tableName = match[1];
        const afterAs = text.substring(match.index + match[0].length);
        const trimmedAfterAs = afterAs.trimStart();
        const { name, type } = buildDefinition(tableName, isGlobalMatch(match));

        if (trimmedAfterAs.startsWith('(')) {
            const openParenIndex = text.indexOf('(', match.index + match[0].length);
            const query = extractBalancedParenthesisContent(text, openParenIndex + 1);
            if (query) {
                const columns = extractColumnsFromQuery(query);
                definitions.push({ name, type, columns });
            }
            continue;
        }

        const endPos = afterAs.indexOf(';');
        const query = endPos !== -1 ? afterAs.substring(0, endPos) : afterAs;
        if (query.trim()) {
            const columns = extractColumnsFromQuery(query);
            definitions.push({ name, type, columns });
        }
    }
}

/**
 * Parse CTE (Common Table Expression) definitions
 */
function extractExplicitCteColumnNames(columnListText: string): string[] {
    return columnListText
        .split(',')
        .map((column) => column.trim().replace(/^["']|["']$/g, ''))
        .filter((column) => !!column);
}

function parseCTEs(text: string, definitions: LocalDefinition[]): void {
    const withRegex = /\bWITH\s+/gi;
    let match;

    while ((match = withRegex.exec(text)) !== null) {
        let currentIndex = match.index + match[0].length;

        // Loop to parse multiple CTEs separated by comma
        while (true) {
            // Expect: CTE_NAME [(col1, col2, ...)] AS (
            const cteHeaderRegex = /^\s*([a-zA-Z0-9_]+)(?:\s*\(([^)]*)\))?\s+AS\s*\(/i;
            const remainingText = text.substring(currentIndex);
            const cteMatch = remainingText.match(cteHeaderRegex);

            if (!cteMatch) {
                break; // No more CTEs in this WITH block
            }

            const cteName = cteMatch[1];
            const explicitColumnList = cteMatch[2];

            const relativeOpenParen =
                cteMatch.index! + cteMatch[0].length - 1;
            const absoluteOpenParen = currentIndex + relativeOpenParen;

            const query = extractBalancedParenthesisContent(text, absoluteOpenParen + 1);

            if (query) {
                const columns = explicitColumnList
                    ? extractExplicitCteColumnNames(explicitColumnList)
                    : extractColumnsFromQuery(query);
                definitions.push({ name: cteName, type: 'CTE', columns });

                // Move index past this CTE
                currentIndex = absoluteOpenParen + 1 + query.length + 1; // +1 for closing ')'

                // Check for comma
                const nextCharRegex = /^\s*,/;
                const nextText = text.substring(currentIndex);
                if (nextCharRegex.test(nextText)) {
                    // Found comma, continue to next CTE
                    const commaMatch = nextText.match(nextCharRegex);
                    currentIndex += commaMatch![0].length;
                } else {
                    // No comma, end of WITH block
                    break;
                }
            } else {
                break; // Failed to parse
            }
        }
    }
}

/**
 * Parse subqueries in JOIN clauses
 */
function parseJoinSubqueries(text: string, definitions: LocalDefinition[]): void {
    const joinRegex = /\bJOIN\s+\(/gi;
    let match;

    while ((match = joinRegex.exec(text)) !== null) {
        const startIndex = match.index + match[0].length;

        const query = extractBalancedParenthesisContent(text, startIndex);

        if (query && /^\s*SELECT\b/i.test(query)) {
            // Found a subquery. Now look for alias after the closing parenthesis.
            const afterParenIndex = startIndex + query.length + 1; // +1 for the closing ')'
            const afterParen = text.substring(afterParenIndex);

            // Expect: optional AS, then Alias
            const aliasMatch = afterParen.match(/^\s+(?:AS\s+)?([a-zA-Z0-9_]+)/i);
            if (aliasMatch) {
                const alias = aliasMatch[1];
                const columns = extractColumnsFromQuery(query);
                definitions.push({ name: alias, type: 'Subquery', columns });
            }
        }
    }
}

/**
 * Extract content between balanced parentheses
 */
export function extractBalancedParenthesisContent(text: string, startIndex: number): string | null {
    let balance = 1;
    let i = startIndex;
    for (; i < text.length; i++) {
        if (text[i] === '(') balance++;
        else if (text[i] === ')') balance--;

        if (balance === 0) {
            return text.substring(startIndex, i);
        }
    }
    return null;
}

/**
 * Extract column names from SELECT query
 */
export function extractColumnsFromQuery(query: string): string[] {
    // Naive parser for top-level SELECT list
    // SELECT col1, col2 AS alias, col3 ... FROM ...

    // 1. Isolate the SELECT list
    const selectMatch = query.match(/^\s*SELECT\s+/i);
    if (!selectMatch) return [];

    const start = selectMatch[0].length;
    let selectList: string;
    let balance = 0;
    let fromIndex = -1;

    for (let i = start; i < query.length; i++) {
        if (query[i] === '(') balance++;
        else if (query[i] === ')') balance--;

        if (balance === 0) {
            // Check for FROM
            if (query.substr(i).match(/^\s+FROM\b/i)) {
                fromIndex = i;
                break;
            }
        }
    }

    if (fromIndex !== -1) {
        selectList = query.substring(start, fromIndex);
    } else {
        // Maybe no FROM (e.g. SELECT 1)
        selectList = query.substring(start);
    }

    // 2. Split by comma, respecting parenthesis
    const columns: string[] = [];
    let current = '';
    balance = 0;

    for (let i = 0; i < selectList.length; i++) {
        const char = selectList[i];
        if (char === '(') balance++;
        else if (char === ')') balance--;

        if (char === ',' && balance === 0) {
            columns.push(current.trim());
            current = '';
        } else {
            current += char;
        }
    }
    if (current.trim()) columns.push(current.trim());

    // 3. Extract alias or name from each part
    return columns.map(col => {
        // "col AS alias" -> alias
        // "col alias" -> alias
        // "col" -> col
        // "table.col" -> col

        const asMatch = col.match(/\s+AS\s+([a-zA-Z0-9_]+)$/i);
        if (asMatch) return asMatch[1];

        const spaceMatch = col.match(/\s+([a-zA-Z0-9_]+)$/i);
        if (spaceMatch) return spaceMatch[1];

        // Just the name, maybe with dot
        const parts = col.split('.');
        return parts[parts.length - 1];
    });
}
