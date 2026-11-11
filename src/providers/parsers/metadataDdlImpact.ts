/**
 * Extract metadata-affecting DDL that is not covered by the table DDL
 * synchronizer: COMMENT ON, views, procedures and synonyms.
 *
 * The parser is intentionally used only for candidates whose first tokens are
 * DDL keywords. Ordinary queries never pay for a CST parse here.
 */

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

export interface MetadataDdlTarget {
    database?: string;
    schema?: string;
    table: string;
}

export type MetadataDdlObjectType = 'TABLE' | 'VIEW' | 'COLUMN' | 'PROCEDURE' | 'SYNONYM';

export type MetadataDdlImpact =
    | {
        kind: 'comment';
        objectType: MetadataDdlObjectType;
        target: MetadataDdlTarget;
        column?: string;
        comment: string;
    }
    | {
        kind: 'create' | 'alter' | 'drop';
        objectType: 'VIEW' | 'PROCEDURE' | 'SYNONYM';
        target: MetadataDdlTarget;
    };

export interface MetadataDdlStatementEffect {
    impacts: MetadataDdlImpact[];
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

function parseQualifiedName(node: CstNode | undefined): MetadataDdlTarget | undefined {
    if (!node) {
        return undefined;
    }
    return parsePathTokens(collectTokens(node));
}

function parsePathTokens(
    tokens: readonly IToken[],
    stopWords?: ReadonlySet<string>,
): MetadataDdlTarget | undefined {
    const segments: Array<string | undefined> = [];
    let current: string | undefined;
    for (const token of tokens) {
        if (token.image === ')') {
            break;
        }
        if (stopWords?.has(token.image.toUpperCase())) {
            break;
        }
        if (token.image === '.') {
            segments.push(current);
            current = undefined;
            continue;
        }
        if (token.image === '(') {
            break;
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

function parseCommentPath(
    tokens: readonly IToken[],
    isColumn: boolean,
): {
    target: MetadataDdlTarget;
    column?: string;
} | undefined {
    const segments: Array<string | undefined> = [];
    let current: string | undefined;
    for (const token of tokens) {
        if (token.image === '.') {
            segments.push(current);
            current = undefined;
            continue;
        }
        if (token.image === '(' || token.image === ')') {
            break;
        }
        current = normalizeTokenText(token);
    }
    segments.push(current);

    if (isColumn) {
        if (segments.length === 2 && segments[0] && segments[1]) {
            return { target: { table: segments[0] }, column: segments[1] };
        }
        if (segments.length === 3 && segments[0] && segments[1] && segments[2]) {
            return {
                target: { schema: segments[0], table: segments[1] },
                column: segments[2],
            };
        }
        if (segments.length === 4 && segments[2] && segments[3]) {
            return {
                target: {
                    database: segments[0],
                    schema: segments[1],
                    table: segments[2],
                },
                column: segments[3],
            };
        }
        return undefined;
    }

    if (segments.length === 1 && segments[0]) {
        return { target: { table: segments[0] } };
    }
    if (segments.length === 2 && segments[0] && segments[1]) {
        return { target: { schema: segments[0], table: segments[1] } };
    }
    if (segments.length === 3 && segments[0] && segments[2]) {
        return {
            target: {
                database: segments[0],
                schema: segments[1],
                table: segments[2],
            },
        };
    }
    if (segments.length === 3 && segments[0] && segments[1]) {
        return { target: { database: segments[0], table: segments[1] } };
    }
    return undefined;
}

function normalizeStringLiteral(image: string): string {
    if (image.startsWith("'") && image.endsWith("'") && image.length >= 2) {
        return image.slice(1, -1).replace(/''/g, "'");
    }
    return image;
}

function parseCommentFromTokens(tokens: readonly IToken[]): MetadataDdlImpact | undefined {
    const first = tokens[0]?.image.toUpperCase();
    const second = tokens[1]?.image.toUpperCase();
    if (first !== 'COMMENT' || second !== 'ON') {
        return undefined;
    }
    const objectToken = tokens[2]?.image.toUpperCase();
    if (!objectToken || !['TABLE', 'VIEW', 'COLUMN', 'PROCEDURE'].includes(objectToken)) {
        return undefined;
    }

    let index = 3;
    const targetTokens: IToken[] = [];
    while (index < tokens.length && tokens[index].image.toUpperCase() !== 'IS') {
        targetTokens.push(tokens[index]);
        index += 1;
    }
    if (index >= tokens.length) {
        return undefined;
    }
    const valueToken = tokens[index + 1];
    if (!valueToken) {
        return undefined;
    }
    if (objectToken === 'PROCEDURE') {
        const openParen = targetTokens.findIndex(token => token.image === '(');
        if (openParen >= 0) {
            targetTokens.length = openParen;
        }
    }
    const parsed = parseCommentPath(targetTokens, objectToken === 'COLUMN');
    if (!parsed) {
        return undefined;
    }

    const comment = valueToken.image.toUpperCase() === 'NULL'
        ? ''
        : normalizeStringLiteral(valueToken.image);
    if (objectToken === 'COLUMN' && !parsed.column) {
        return undefined;
    }
    return {
        kind: 'comment',
        objectType: objectToken as MetadataDdlObjectType,
        target: parsed.target,
        column: parsed.column,
        comment,
    };
}

function parseDropFromCst(
    dropNode: CstNode,
    databaseKind: DatabaseKind,
): MetadataDdlImpact[] {
    const objectType = getTokensByKey(dropNode, 'View').length > 0
        ? 'VIEW'
        : getTokensByKey(dropNode, 'Procedure').length > 0
            ? 'PROCEDURE'
            : getTokensByKey(dropNode, 'Synonym').length > 0 && databaseKind === 'netezza'
                ? 'SYNONYM'
                : undefined;
    if (!objectType) {
        return [];
    }
    const targetList = getChildNodesByKey(dropNode, 'dropTargetList')[0];
    if (!targetList) {
        return [];
    }
    return getChildNodesByKey(targetList, 'dropTarget')
        .map(targetNode => parseQualifiedName(getChildNodesByKey(targetNode, 'qualifiedName')[0]))
        .filter((target): target is MetadataDdlTarget => target !== undefined)
        .map(target => ({ kind: 'drop' as const, objectType, target }));
}

/**
 * Token-level fallback for statements the dialect grammar does not model yet
 * (for example `ALTER VIEW ... RENAME TO`). It never invents targets: an
 * unparsable path yields no impact.
 */
function parseDdlFromTokens(tokens: readonly IToken[]): MetadataDdlImpact[] {
    let index = 0;
    const first = tokens[index]?.image.toUpperCase();
    let kind: 'create' | 'alter' | 'drop';
    if (first === 'CREATE') {
        kind = 'create';
        index += 1;
        if (tokens[index]?.image.toUpperCase() === 'OR'
            && tokens[index + 1]?.image.toUpperCase() === 'REPLACE') {
            index += 2;
        }
        if (tokens[index]?.image.toUpperCase() === 'MATERIALIZED') {
            return [];
        }
    } else if (first === 'ALTER') {
        kind = 'alter';
        index += 1;
    } else if (first === 'DROP') {
        kind = 'drop';
        index += 1;
    } else {
        return [];
    }

    const objectType = tokens[index]?.image.toUpperCase();
    if (objectType !== 'VIEW' && objectType !== 'PROCEDURE' && objectType !== 'SYNONYM') {
        return [];
    }
    index += 1;
    const target = parsePathTokens(
        tokens.slice(index),
        new Set(['AS', 'IS', 'RENAME', 'OWNER', 'TO']),
    );
    return target ? [{ kind, objectType, target }] : [];
}

/**
 * Extract non-table metadata DDL impacts from one successfully executed
 * statement. Returns an empty list for SELECT/DML and for statements already
 * handled by `extractTableDdlStatementEffect`.
 */
export function extractMetadataDdlStatementEffect(
    sql: string,
    databaseKind: DatabaseKind = 'netezza',
): MetadataDdlStatementEffect {
    const parseResult = parseSqlStatements({ sql, databaseKind });
    if (parseResult.lexResult.errors.length > 0) {
        return { impacts: [] };
    }

    const first = parseResult.lexResult.tokens[0]?.image.toUpperCase();
    if (first === 'COMMENT') {
        const comment = parseCommentFromTokens(parseResult.lexResult.tokens);
        return { impacts: comment ? [comment] : [] };
    }

    if (parseResult.actionableParserErrors.length > 0 || !parseResult.cst) {
        // The dialect grammar does not model every object DDL form (for
        // example ALTER VIEW). Fall back to tokens so the metadata cache is
        // still invalidated for recognized keywords.
        return { impacts: parseDdlFromTokens(parseResult.lexResult.tokens) };
    }
    const statement = getChildNodesByKey(parseResult.cst, 'statement')[0];
    if (!statement) {
        return { impacts: parseDdlFromTokens(parseResult.lexResult.tokens) };
    }

    const commentNode = getChildNodesByKey(statement, 'commentStatement')[0];
    if (commentNode) {
        const comment = parseCommentFromTokens(parseResult.lexResult.tokens);
        return { impacts: comment ? [comment] : [] };
    }

    const createView = getChildNodesByKey(statement, 'createViewStatement')[0];
    if (createView) {
        const target = parseQualifiedName(getChildNodesByKey(createView, 'qualifiedName')[0]);
        return target
            ? { impacts: [{ kind: 'create', objectType: 'VIEW', target }] }
            : { impacts: [] };
    }

    const createProcedure = getChildNodesByKey(statement, 'createProcedureStatement')[0];
    if (createProcedure) {
        const target = parseQualifiedName(getChildNodesByKey(createProcedure, 'qualifiedName')[0]);
        return target
            ? { impacts: [{ kind: 'create', objectType: 'PROCEDURE', target }] }
            : { impacts: [] };
    }

    const createSynonym = getChildNodesByKey(statement, 'createSynonymStatement')[0];
    if (createSynonym) {
        const target = parseQualifiedName(getChildNodesByKey(createSynonym, 'qualifiedName')[0]);
        return target
            ? { impacts: [{ kind: 'create', objectType: 'SYNONYM', target }] }
            : { impacts: [] };
    }

    const drop = getChildNodesByKey(statement, 'dropStatement')[0];
    const impacts = drop ? parseDropFromCst(drop, databaseKind) : [];
    return impacts.length > 0
        ? { impacts }
        : { impacts: parseDdlFromTokens(parseResult.lexResult.tokens) };
}
