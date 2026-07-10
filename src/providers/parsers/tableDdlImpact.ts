import type { CstNode, IToken } from 'chevrotain';
import type { DatabaseKind } from '../../contracts/database';
import { parseSqlStatements } from '../../sqlParser/parsingRuntime';
import {
    getChildNodesByKey,
    getTokensByKey,
    isCstNode,
    isToken,
    normalizeTokenText,
} from './scope/cstNodeUtils';

export interface QualifiedTableTarget {
    database?: string;
    schema?: string;
    table: string;
}

export type CatalogTableType = 'TABLE' | 'GLOBAL TEMP TABLE';

export type TableDdlImpact =
    | {
        kind: 'create';
        target: QualifiedTableTarget;
        objectType: CatalogTableType;
    }
    | {
        kind: 'alter';
        target: QualifiedTableTarget;
        renamedTarget?: QualifiedTableTarget;
    }
    | {
        kind: 'drop';
        target: QualifiedTableTarget;
    };

export type TransactionControl = 'begin' | 'commit' | 'rollback';

export interface TableDdlStatementEffect {
    impacts: TableDdlImpact[];
    transactionControl?: TransactionControl;
}

function collectTokens(node: CstNode): IToken[] {
    const tokens: IToken[] = [];
    for (const value of Object.values(node.children ?? {})) {
        if (!Array.isArray(value)) {
            continue;
        }
        for (const child of value) {
            if (isToken(child)) {
                tokens.push(child);
            } else if (isCstNode(child)) {
                tokens.push(...collectTokens(child));
            }
        }
    }
    return tokens.sort((left, right) => (left.startOffset ?? 0) - (right.startOffset ?? 0));
}

function parseQualifiedName(node: CstNode | undefined): QualifiedTableTarget | undefined {
    if (!node) {
        return undefined;
    }

    const segments: Array<string | undefined> = [];
    let current: string | undefined;
    for (const token of collectTokens(node)) {
        if (token.image === '.') {
            segments.push(current);
            current = undefined;
            continue;
        }
        current = normalizeTokenText(token);
    }
    segments.push(current);

    if (segments.length === 1 && segments[0]) {
        return { table: segments[0] };
    }
    if (segments.length === 2 && segments[0] && segments[1]) {
        return { schema: segments[0], table: segments[1] };
    }
    if (segments.length === 3 && segments[0] && segments[2]) {
        return {
            database: segments[0],
            schema: segments[1],
            table: segments[2],
        };
    }
    return undefined;
}

function parseQualifiedTokens(tokens: readonly IToken[]): QualifiedTableTarget | undefined {
    const segments: Array<string | undefined> = [];
    let current: string | undefined;
    for (const token of tokens) {
        if (token.image === '.') {
            segments.push(current);
            current = undefined;
            continue;
        }
        current = normalizeTokenText(token);
    }
    segments.push(current);

    if (segments.length === 1 && segments[0]) {
        return { table: segments[0] };
    }
    if (segments.length === 2 && segments[0] && segments[1]) {
        return { schema: segments[0], table: segments[1] };
    }
    if (segments.length === 3 && segments[0] && segments[2]) {
        return { database: segments[0], schema: segments[1], table: segments[2] };
    }
    return undefined;
}

function parseCreateImpact(node: CstNode): TableDdlImpact | undefined {
    const target = parseQualifiedName(getChildNodesByKey(node, 'qualifiedName')[0]);
    if (!target) {
        return undefined;
    }

    const typeClause = getChildNodesByKey(node, 'tableTypeClause')[0];
    if (!typeClause) {
        return { kind: 'create', target, objectType: 'TABLE' };
    }

    const isGlobal = getTokensByKey(typeClause, 'Global').length > 0;
    if (!isGlobal) {
        // LOCAL TEMP/TEMPORARY tables are session objects, not schema-catalog entries.
        return undefined;
    }
    return { kind: 'create', target, objectType: 'GLOBAL TEMP TABLE' };
}

function parseDropImpacts(node: CstNode): TableDdlImpact[] {
    if (getTokensByKey(node, 'Table').length === 0) {
        return [];
    }
    const targetList = getChildNodesByKey(node, 'dropTargetList')[0];
    if (!targetList) {
        return [];
    }
    return getChildNodesByKey(targetList, 'dropTarget')
        .map(targetNode => parseQualifiedName(getChildNodesByKey(targetNode, 'qualifiedName')[0]))
        .filter((target): target is QualifiedTableTarget => target !== undefined)
        .map(target => ({ kind: 'drop' as const, target }));
}

const ALTER_ACTION_KEYWORDS = new Set([
    'ADD',
    'ALTER',
    'DROP',
    'MODIFY',
    'ORGANIZE',
    'OWNER',
    'RENAME',
    'SET',
]);

function parseAlterImpactFromTokens(tokens: readonly IToken[]): TableDdlImpact | undefined {
    let actionIndex = -1;
    for (let index = 2; index < tokens.length; index++) {
        const previous = tokens[index - 1]?.image;
        const upper = tokens[index].image.toUpperCase();
        if (previous !== '.' && ALTER_ACTION_KEYWORDS.has(upper)) {
            actionIndex = index;
            break;
        }
    }
    if (actionIndex < 0) {
        return undefined;
    }

    const target = parseQualifiedTokens(tokens.slice(2, actionIndex));
    if (!target) {
        return undefined;
    }
    const tail = tokens.slice(actionIndex);
    const upperTail = tail.map(token => token.image.toUpperCase());
    let renamedTarget: QualifiedTableTarget | undefined;

    if (upperTail[0] === 'RENAME' && upperTail[1] === 'TO' && tail[2]) {
        renamedTarget = {
            database: target.database,
            schema: target.schema,
            table: normalizeTokenText(tail[2]),
        };
    } else if (upperTail[0] === 'SET' && upperTail[1] === 'SCHEMA' && tail[2]) {
        renamedTarget = {
            database: target.database,
            schema: normalizeTokenText(tail[2]),
            table: target.table,
        };
    }

    return { kind: 'alter', target, renamedTarget };
}

function parseDropImpactsFromTokens(tokens: readonly IToken[]): TableDdlImpact[] {
    let index = 2;
    if (
        tokens[index]?.image.toUpperCase() === 'IF'
        && tokens[index + 1]?.image.toUpperCase() === 'EXISTS'
    ) {
        index += 2;
    }

    const impacts: TableDdlImpact[] = [];
    let targetTokens: IToken[] = [];
    const flush = (): void => {
        const target = parseQualifiedTokens(targetTokens);
        if (target) {
            impacts.push({ kind: 'drop', target });
        }
        targetTokens = [];
    };

    for (; index < tokens.length; index++) {
        const token = tokens[index];
        const upper = token.image.toUpperCase();
        if (token.image === ',') {
            flush();
            continue;
        }
        if (token.image === ';' || upper === 'CASCADE' || upper === 'RESTRICT') {
            break;
        }
        targetTokens.push(token);
    }
    flush();
    return impacts;
}

/**
 * Extract top-level table DDL effects from one successfully executed SQL statement.
 * Nested statements in procedure bodies are deliberately ignored.
 */
export function extractTableDdlStatementEffect(
    sql: string,
    databaseKind: DatabaseKind = 'netezza',
): TableDdlStatementEffect {
    const parseResult = parseSqlStatements({ sql, databaseKind });
    if (parseResult.lexResult.errors.length > 0) {
        return { impacts: [] };
    }

    const tokens = parseResult.lexResult.tokens;
    const first = tokens[0]?.image.toUpperCase();
    const second = tokens[1]?.image.toUpperCase();
    if (first === 'ALTER' && second === 'TABLE') {
        const impact = parseAlterImpactFromTokens(tokens);
        return { impacts: impact ? [impact] : [] };
    }
    if (first === 'DROP' && second === 'TABLE') {
        return { impacts: parseDropImpactsFromTokens(tokens) };
    }
    if (parseResult.actionableParserErrors.length > 0 || !parseResult.cst) {
        return { impacts: [] };
    }

    const statement = getChildNodesByKey(parseResult.cst, 'statement')[0];
    if (!statement) {
        return { impacts: [] };
    }
    if (getChildNodesByKey(statement, 'beginStatement').length > 0) {
        return { impacts: [], transactionControl: 'begin' };
    }
    if (getChildNodesByKey(statement, 'commitStatement').length > 0) {
        return { impacts: [], transactionControl: 'commit' };
    }
    if (getChildNodesByKey(statement, 'rollbackStatement').length > 0) {
        return { impacts: [], transactionControl: 'rollback' };
    }

    const createTable = getChildNodesByKey(statement, 'createTableStatement')[0];
    if (createTable) {
        const impact = parseCreateImpact(createTable);
        return { impacts: impact ? [impact] : [] };
    }

    const drop = getChildNodesByKey(statement, 'dropStatement')[0];
    return { impacts: drop ? parseDropImpacts(drop) : [] };
}
