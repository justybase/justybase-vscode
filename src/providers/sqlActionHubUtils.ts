/**
 * SQL Action Hub - shared context logic for the Ctrl+. action surface.
 *
 * vscode-free helpers used by SqlExecutionCodeActionProvider. Every helper is
 * synchronous and side-effect free: providers must never hit the database
 * from provideCodeActions. Only in-memory parse/scope results are used.
 *
 * Actions that need a live connection (run, explain, reveal, refresh, ...)
 * reuse existing netezza.* / editor.action.* commands; this module only
 * decides *whether* an action applies and builds its arguments.
 */

import type { IToken } from 'chevrotain';
import type { DatabaseKind } from '../contracts/database';
import type { SchemaItemData } from '../commands/schema/itemTypes';
import { SqlParser } from '../sql/sqlParser';
import { SqlLexer } from '../sqlParser/lexer';
import { parseSqlStatements } from '../sqlParser/parsingRuntime';
import {
    resolveCatalogObjectAtOffset,
    type CatalogObjectRef,
} from '../server/catalogNavigation';
import { collectIdentifierOccurrences } from './parsers/identifierRoleCollector';
import { parseSemanticScopeWithParser } from './parsers/parserSqlContext';
import {
    EXPLAINABLE_STATEMENT_TOKENS,
    EXPORTABLE_STATEMENT_TOKENS,
    QUERY_FLOW_STATEMENT_TOKENS,
    RUNNABLE_STATEMENT_TOKENS,
    type StatementLensSupport,
} from './sqlCodeLensProvider';
import { formatQualifiedObjectName } from '../utils/identifierUtils';

/** Row limits offered by the Run Preview hub actions. */
export const HUB_PREVIEW_ROW_LIMITS = [100, 1000, 10000] as const;

export interface HubStatement {
    sql: string;
    startOffset: number;
    endOffset: number;
    support: StatementLensSupport;
}

export interface HubColumn {
    text: string;
    startOffset: number;
    endOffset: number;
    alreadyQualified: boolean;
    /** Owning alias when exactly one alias is visible (unambiguous). */
    singleAlias?: string;
}

export interface HubTextEdit {
    insertOffset: number;
    insertText: string;
}

/**
 * Statement support uses the same first-token sets as the per-statement
 * CodeLens so the hub never offers Run/Explain/Export/Visualize where the
 * CodeLens would not.
 */
export function getHubStatementSupport(statementSql: string): StatementLensSupport {
    const none: StatementLensSupport = {
        canRun: false,
        canExplain: false,
        canExport: false,
        canVisualize: false,
    };
    let tokens: IToken[];
    try {
        tokens = SqlLexer.tokenize(statementSql).tokens;
    } catch {
        return none;
    }
    if (tokens.length === 0) {
        return none;
    }
    const firstTokenName = tokens[0].tokenType.name;
    return {
        canRun: RUNNABLE_STATEMENT_TOKENS.has(firstTokenName),
        canExplain: EXPLAINABLE_STATEMENT_TOKENS.has(firstTokenName),
        canExport: EXPORTABLE_STATEMENT_TOKENS.has(firstTokenName),
        canVisualize: QUERY_FLOW_STATEMENT_TOKENS.has(firstTokenName),
    };
}

export function findHubStatement(text: string, offset: number): HubStatement | undefined {
    let statement: { sql: string; start: number; end: number } | null;
    try {
        statement = SqlParser.getStatementAtPosition(text, offset);
    } catch {
        return undefined;
    }
    if (!statement || !statement.sql.trim()) {
        return undefined;
    }
    return {
        sql: statement.sql,
        startOffset: statement.start,
        endOffset: statement.end,
        support: getHubStatementSupport(statement.sql),
    };
}

/**
 * Limited-preview SQL that reuses the existing run-statement execution path.
 * Only SELECT/WITH statements are wrappable; anything else returns undefined
 * so the caller omits the preview actions.
 */
export function buildPreviewSql(
    statementSql: string,
    limit: number,
    databaseKind?: DatabaseKind,
): string | undefined {
    if (!getHubStatementSupport(statementSql).canExport) {
        return undefined;
    }
    const inner = statementSql.trim().replace(/;+\s*$/, '');
    if (!inner) {
        return undefined;
    }
    if (databaseKind === 'mssql') {
        return `SELECT TOP (${limit}) * FROM (\n${inner}\n) AS justybase_preview`;
    }
    if (databaseKind === 'oracle') {
        return `SELECT * FROM (\n${inner}\n) justybase_preview FETCH FIRST ${limit} ROWS ONLY`;
    }
    return `SELECT * FROM (\n${inner}\n) AS justybase_preview LIMIT ${limit}`;
}

/** Table/view/procedure reference at the cursor, if the text resolves to one. */
export function resolveHubCatalogRef(
    sql: string,
    offset: number,
    databaseKind?: DatabaseKind,
    effectiveDatabase?: string,
): CatalogObjectRef | undefined {
    try {
        return resolveCatalogObjectAtOffset(sql, offset, databaseKind, effectiveDatabase, undefined);
    } catch {
        return undefined;
    }
}

/**
 * A FROM/JOIN name that matches a visible CTE is local, not a catalog
 * object - table actions must not be offered for it.
 */
export function isHubCteReference(
    sql: string,
    offset: number,
    name: string,
    databaseKind?: DatabaseKind,
): boolean {
    try {
        const scope = parseSemanticScopeWithParser(sql, offset, databaseKind);
        const upper = name.toUpperCase();
        return scope.visibleLocalDefinitions.some(
            (definition) => definition.type === 'CTE' && definition.name.toUpperCase() === upper,
        );
    } catch {
        return false;
    }
}

/** Serializable item data so existing SchemaItemData commands can be reused. */
export function buildHubSchemaItemData(
    ref: CatalogObjectRef,
    connectionName?: string,
): SchemaItemData {
    return {
        label: ref.name,
        rawLabel: ref.name,
        dbName: ref.database,
        schema: ref.schema,
        objType: ref.kind.toUpperCase(),
        connectionName,
    };
}

export function buildHubQualifiedName(
    ref: CatalogObjectRef,
    databaseKind?: DatabaseKind,
): string {
    return formatQualifiedObjectName(ref.database, ref.schema, ref.name, databaseKind);
}

/**
 * Reliably resolvable column at the cursor: the semantic role map must
 * classify the identifier as a column. Anything else (table, alias, unknown,
 * or no strict parse) yields undefined and the caller offers no column
 * actions.
 */
export function resolveHubColumn(
    sql: string,
    offset: number,
    databaseKind?: DatabaseKind,
): HubColumn | undefined {
    let occurrences;
    try {
        occurrences = collectIdentifierOccurrences(sql, databaseKind);
    } catch {
        return undefined;
    }
    let hit: { startOffset: number; endOffset: number } | undefined;
    for (const occurrence of occurrences.values()) {
        if (
            occurrence.role === 'column'
            && occurrence.startOffset <= offset
            && offset <= occurrence.endOffset
        ) {
            hit = occurrence;
            break;
        }
    }
    if (!hit) {
        return undefined;
    }
    const alreadyQualified = sql.slice(0, hit.startOffset).trimEnd().endsWith('.');

    let singleAlias: string | undefined;
    if (!alreadyQualified) {
        try {
            const scope = parseSemanticScopeWithParser(sql, offset, databaseKind);
            // Alias bindings also carry an implicit self-mapping (table name
            // -> itself). Qualification is only unambiguous for a single
            // underlying table reached through a single explicit alias:
            // with two tables (even when only one is aliased) the column
            // could belong to either side, and a re-parse cannot catch that.
            const entries = [...scope.aliasBindings.entries()];
            const distinctTables = new Set(
                entries.map(([, info]) => info.table.toUpperCase()),
            );
            const explicit = entries
                .filter(([alias, info]) => alias.toUpperCase() !== info.table.toUpperCase())
                .map(([alias]) => alias);
            if (distinctTables.size === 1 && explicit.length === 1) {
                singleAlias = explicit[0];
            }
        } catch {
            singleAlias = undefined;
        }
    }

    return {
        text: sql.slice(hit.startOffset, hit.endOffset),
        startOffset: hit.startOffset,
        endOffset: hit.endOffset,
        alreadyQualified,
        singleAlias,
    };
}

/**
 * Safety bar for hub text transforms (same bar as the refactor provider):
 * the proposal must lex and parse cleanly or the action is omitted.
 */
export function verifyHubSqlParses(sql: string, databaseKind?: DatabaseKind): boolean {
    try {
        const parsed = parseSqlStatements({ sql, databaseKind });
        return (
            parsed.lexResult.errors.length === 0
            && parsed.actionableParserErrors.length === 0
            && Boolean(parsed.cst)
        );
    } catch {
        return false;
    }
}

/** Qualify an unqualified column with its unambiguous owning alias. */
export function buildQualifyColumnEdit(column: HubColumn): HubTextEdit | undefined {
    if (column.alreadyQualified || !column.singleAlias) {
        return undefined;
    }
    return {
        insertOffset: column.startOffset,
        insertText: `${column.singleAlias}.`,
    };
}

function isClauseImage(image: string, keyword: 'GROUP BY' | 'HAVING' | 'ORDER BY' | 'LIMIT'): boolean {
    if (keyword === 'GROUP BY') {
        return /^GROUP\s+BY$/i.test(image);
    }
    if (keyword === 'ORDER BY') {
        return /^ORDER\s+BY$/i.test(image);
    }
    return image.toUpperCase() === keyword;
}

/**
 * Append the column to an existing top-level GROUP BY list, or insert a new
 * GROUP BY clause before HAVING/ORDER BY/LIMIT (or at the statement end).
 * Paren-depth tracking keeps subquery clauses out of scope. Returns undefined
 * when the column is already grouped or no safe anchor exists.
 */
export function buildAddToGroupByEdit(
    sql: string,
    statement: Pick<HubStatement, 'startOffset' | 'endOffset'>,
    columnRef: string,
    databaseKind?: DatabaseKind,
): HubTextEdit | undefined {
    void databaseKind;
    let tokens: IToken[];
    try {
        tokens = SqlLexer.tokenize(sql).tokens;
    } catch {
        return undefined;
    }
    const inRange = tokens.filter((token) => {
        const start = token.startOffset ?? 0;
        return start >= statement.startOffset && start < statement.endOffset;
    });

    let depth = 0;
    let groupByEnd: number | undefined;
    let listEnd: number | undefined;
    let clauseAnchor: number | undefined;
    for (const token of inRange) {
        const tokenStart = token.startOffset ?? 0;
        if (token.image === '(') {
            depth += 1;
            continue;
        }
        if (token.image === ')') {
            depth = Math.max(0, depth - 1);
            continue;
        }
        if (depth !== 0) {
            continue;
        }
        if (token.image === ';') {
            listEnd ??= tokenStart;
            clauseAnchor ??= tokenStart;
            break;
        }
        if (isClauseImage(token.image, 'GROUP BY')) {
            groupByEnd = (token.endOffset ?? tokenStart + token.image.length) + 1;
            continue;
        }
        if (
            isClauseImage(token.image, 'HAVING')
            || isClauseImage(token.image, 'ORDER BY')
            || isClauseImage(token.image, 'LIMIT')
        ) {
            if (groupByEnd !== undefined && listEnd === undefined) {
                listEnd = tokenStart;
            } else if (groupByEnd === undefined) {
                clauseAnchor = tokenStart;
                break;
            }
        }
    }

    if (groupByEnd !== undefined) {
        const end = listEnd ?? trimStatementEnd(sql, statement.endOffset);
        const listText = sql.slice(groupByEnd, end);
        if (splitTopLevelListItems(listText).includes(columnRef.toUpperCase())) {
            return undefined;
        }
        return {
            insertOffset: end,
            insertText: listText.trim() === '' ? ` ${columnRef}` : `, ${columnRef}`,
        };
    }

    if (clauseAnchor !== undefined) {
        return { insertOffset: clauseAnchor, insertText: `GROUP BY ${columnRef} ` };
    }
    const end = trimStatementEnd(sql, statement.endOffset);
    if (end <= statement.startOffset) {
        return undefined;
    }
    return { insertOffset: end, insertText: ` GROUP BY ${columnRef}` };
}

function trimStatementEnd(sql: string, endOffset: number): number {
    let end = Math.min(endOffset, sql.length);
    while (end > 0 && /[\s;]/.test(sql.charAt(end - 1))) {
        end -= 1;
    }
    return end;
}

/**
 * Split a GROUP BY list on top-level commas so `ID` does not match `HIDE`
 * and commas inside function calls do not split. Comparison is exact per
 * item (case-insensitive); `C.ID` and `ID` are treated as different items.
 */
export function splitTopLevelListItems(listText: string): string[] {
    const items: string[] = [];
    let depth = 0;
    let current = '';
    for (const char of listText) {
        if (char === '(') {
            depth += 1;
        } else if (char === ')') {
            depth = Math.max(0, depth - 1);
        }
        if (char === ',' && depth === 0) {
            items.push(current.trim().toUpperCase());
            current = '';
            continue;
        }
        current += char;
    }
    if (current.trim() !== '') {
        items.push(current.trim().toUpperCase());
    }
    return items;
}

/** Apply a HubTextEdit to full document text (for verification + tests). */
export function applyHubTextEdit(sql: string, edit: HubTextEdit): string {
    return `${sql.slice(0, edit.insertOffset)}${edit.insertText}${sql.slice(edit.insertOffset)}`;
}
