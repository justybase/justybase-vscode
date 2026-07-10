import { type CstNode, type IToken } from 'chevrotain';
import {
    getChildNodesByKey,
    getIdentifierTokenByKey,
    getTokensByKey,
    isCstNode,
    isToken,
    normalizeTokenText,
} from '../providers/parsers/scope/cstNodeUtils';
import type { SqlTextRange } from './queryStructureAnalyzer';

export type TempTableMaterializationKind = 'TEMP' | 'GLOBAL_TEMP';

export interface CteToTempTableTransformPlan {
    replacementRange: SqlTextRange;
    outputSql: string;
    flattenedCteNames: string[];
}

interface FlattenedCteRecord {
    name: string;
    bodyText: string;
    leadingTrivia: string;
}

function collectTokens(node: CstNode, sink: IToken[]): void {
    const children = node.children ?? {};
    for (const value of Object.values(children)) {
        if (!Array.isArray(value)) {
            continue;
        }
        for (const child of value) {
            if (isToken(child)) {
                sink.push(child);
            } else if (isCstNode(child)) {
                collectTokens(child, sink);
            }
        }
    }
}

function getTokenEndOffset(token: IToken): number {
    if (token.endOffset !== undefined) {
        return token.endOffset + 1;
    }
    return (token.startOffset ?? 0) + token.image.length;
}

function getExclusiveNodeRange(node: CstNode | undefined): { start: number; end: number } | undefined {
    if (!node) {
        return undefined;
    }

    const tokens: IToken[] = [];
    collectTokens(node, tokens);
    if (tokens.length === 0) {
        return undefined;
    }

    tokens.sort((left, right) => (left.startOffset ?? 0) - (right.startOffset ?? 0));
    return {
        start: tokens[0].startOffset ?? 0,
        end: getTokenEndOffset(tokens[tokens.length - 1]),
    };
}

function isWithLikeNode(node: CstNode): boolean {
    return node.name === 'withStatement' || node.name === 'withAnyStatement';
}

function hasRecursiveModifier(withNode: CstNode): boolean {
    return getTokensByKey(withNode, 'Recursive').length > 0;
}

function getMainStatement(withNode: CstNode): CstNode | undefined {
    return getChildNodesByKey(withNode, 'selectStatement')[0];
}

function getCteBodyNode(cteDefinition: CstNode): CstNode | undefined {
    return getChildNodesByKey(cteDefinition, 'withStatement')[0]
        ?? getChildNodesByKey(cteDefinition, 'selectStatement')[0];
}

function getWithPrefixEndOffset(withNode: CstNode): number {
    const withToken = getTokensByKey(withNode, 'With')[0];
    const recursiveToken = getTokensByKey(withNode, 'Recursive')[0];
    if (recursiveToken?.endOffset !== undefined) {
        return recursiveToken.endOffset + 1;
    }
    if (withToken?.endOffset !== undefined) {
        return withToken.endOffset + 1;
    }
    const range = getExclusiveNodeRange(withNode);
    return range?.start ?? 0;
}

function sliceText(sql: string, startOffset: number, endOffset: number): string {
    return sql.slice(startOffset, endOffset);
}

function getCteInteriorRange(cteDefinition: CstNode): { start: number; end: number } | undefined {
    const lParen = getTokensByKey(cteDefinition, 'LParen')[0];
    const rParen = getTokensByKey(cteDefinition, 'RParen')[0];
    if (lParen?.endOffset === undefined || rParen?.startOffset === undefined) {
        return undefined;
    }

    return {
        start: lParen.endOffset + 1,
        end: rParen.startOffset,
    };
}

function sanitizeLeadingTrivia(trivia: string): string {
    return trivia
        .replace(/^(\s*),/u, '$1')
        .replace(/,(\s*)$/u, '$1');
}

function extendEndForTrailingSemicolon(sql: string, endOffset: number): number {
    const trailing = sql.slice(endOffset).match(/^\s*;/u);
    return trailing ? endOffset + trailing[0].length : endOffset;
}

function buildFinalQueryText(
    sql: string,
    mainStatementRange: { start: number; end: number },
    statementEndOffset: number,
): string {
    const queryText = sliceText(sql, mainStatementRange.start, mainStatementRange.end);
    const effectiveStatementEnd = extendEndForTrailingSemicolon(sql, statementEndOffset);
    const statementTail = sql.slice(mainStatementRange.end, effectiveStatementEnd);
    if (/^\s*;/u.test(statementTail) && !queryText.trimEnd().endsWith(';')) {
        return `${queryText};`;
    }
    return queryText;
}

function extendStatementRangeForTrailingSemicolon(
    sql: string,
    statementRange: SqlTextRange,
): SqlTextRange {
    const endOffset = extendEndForTrailingSemicolon(sql, statementRange.endOffset);
    if (endOffset === statementRange.endOffset) {
        return statementRange;
    }

    return {
        ...statementRange,
        endOffset,
    };
}

function normalizeBlockIndentation(text: string): string {
    const lines = text.replace(/\r\n/g, '\n').split('\n');

    while (lines.length > 0 && lines[0].trim().length === 0) {
        lines.shift();
    }
    while (lines.length > 0 && lines[lines.length - 1].trim().length === 0) {
        lines.pop();
    }

    const indentationWidths = lines
        .filter(line => line.trim().length > 0)
        .map(line => line.match(/^\s*/u)?.[0].length ?? 0);
    const minimumIndentation = indentationWidths.length > 0 ? Math.min(...indentationWidths) : 0;

    return lines
        .map(line => (line.trim().length > 0 ? line.slice(minimumIndentation) : ''))
        .join('\n');
}

export function buildCreateTempTableStatement(
    name: string,
    body: string,
    kind: TempTableMaterializationKind,
): string {
    const tableKind = kind === 'GLOBAL_TEMP' ? 'CREATE GLOBAL TEMP TABLE' : 'CREATE TEMP TABLE';
    const normalizedBody = normalizeBlockIndentation(body);
    const indentedBody = normalizedBody
        .split('\n')
        .map(line => (line.trim().length > 0 ? `    ${line}` : ''))
        .join('\n');
    return `${tableKind} ${name} AS\n(\n${indentedBody}\n)DISTRIBUTE ON RANDOM;\n\n`;
}

function flattenWithClause(
    sql: string,
    withNode: CstNode,
    seenNames: Set<string>,
    output: FlattenedCteRecord[],
    previousBoundaryOffset: number,
): number | undefined {
    if (hasRecursiveModifier(withNode)) {
        return undefined;
    }

    const cteDefinitions = getChildNodesByKey(withNode, 'cteDefinition');
    let boundaryOffset = previousBoundaryOffset;

    for (const cteDefinition of cteDefinitions) {
        const definitionRange = getExclusiveNodeRange(cteDefinition);
        const nameToken = getIdentifierTokenByKey(cteDefinition);
        const bodyNode = getCteBodyNode(cteDefinition);

        if (!definitionRange || !nameToken || !bodyNode) {
            return undefined;
        }

        const cteName = normalizeTokenText(nameToken);
        const normalizedName = cteName.toUpperCase();

        const leadingTrivia = sliceText(sql, boundaryOffset, definitionRange.start);
        const nestedWith = getChildNodesByKey(cteDefinition, 'withStatement')[0];
        let bodyText: string;

        if (nestedWith) {
            const nestedMainStatement = getMainStatement(nestedWith);
            const nestedPrefixEnd = getWithPrefixEndOffset(nestedWith);
            const nestedBoundary = flattenWithClause(
                sql,
                nestedWith,
                seenNames,
                output,
                nestedPrefixEnd,
            );
            if (nestedBoundary === undefined) {
                return undefined;
            }

            if (!nestedMainStatement) {
                return undefined;
            }

            const nestedMainRange = getExclusiveNodeRange(nestedMainStatement);
            if (!nestedMainRange) {
                return undefined;
            }

            bodyText = sliceText(sql, nestedMainRange.start, nestedMainRange.end);
        } else {
            const interiorRange = getCteInteriorRange(cteDefinition);
            if (!interiorRange) {
                return undefined;
            }
            bodyText = sliceText(sql, interiorRange.start, interiorRange.end);
        }

        if (seenNames.has(normalizedName)) {
            return undefined;
        }

        seenNames.add(normalizedName);
        output.push({
            name: cteName,
            bodyText,
            leadingTrivia,
        });

        boundaryOffset = definitionRange.end;
    }

    return boundaryOffset;
}

export function buildCteToTempTableTransform(
    sql: string,
    withRootNode: CstNode,
    statementRange: SqlTextRange,
    kind: TempTableMaterializationKind,
): CteToTempTableTransformPlan | undefined {
    if (!isWithLikeNode(withRootNode) || hasRecursiveModifier(withRootNode)) {
        return undefined;
    }

    const mainStatement = getMainStatement(withRootNode);
    if (!mainStatement) {
        return undefined;
    }

    const mainStatementRange = getExclusiveNodeRange(mainStatement);
    const withRange = getExclusiveNodeRange(withRootNode);
    if (!mainStatementRange || !withRange) {
        return undefined;
    }

    const seenNames = new Set<string>();
    const flattenedRecords: FlattenedCteRecord[] = [];
    const prefixEnd = getWithPrefixEndOffset(withRootNode);
    const lastCteBoundary = flattenWithClause(
        sql,
        withRootNode,
        seenNames,
        flattenedRecords,
        prefixEnd,
    );

    if (lastCteBoundary === undefined) {
        return undefined;
    }

    const cteDefinitions = getChildNodesByKey(withRootNode, 'cteDefinition');
    const finalLeadingTrivia = cteDefinitions.length > 0
        ? sliceText(sql, lastCteBoundary, mainStatementRange.start)
        : sliceText(sql, prefixEnd, mainStatementRange.start);
    const finalQuery = buildFinalQueryText(sql, mainStatementRange, statementRange.endOffset);

    const outputParts: string[] = [];
    for (const record of flattenedRecords) {
        outputParts.push(sanitizeLeadingTrivia(record.leadingTrivia));
        outputParts.push(buildCreateTempTableStatement(record.name, record.bodyText, kind));
    }
    outputParts.push(sanitizeLeadingTrivia(finalLeadingTrivia));
    outputParts.push(finalQuery);

    return {
        replacementRange: extendStatementRangeForTrailingSemicolon(sql, statementRange),
        outputSql: outputParts.join(''),
        flattenedCteNames: flattenedRecords.map(record => record.name),
    };
}
