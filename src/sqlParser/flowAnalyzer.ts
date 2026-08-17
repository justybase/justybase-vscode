import type { DatabaseKind } from '../contracts/database'
import type { IToken } from 'chevrotain'
import { collectSqlSymbolUsages } from './symbols'
import { resolveSqlParsingRuntime } from './parsingRuntime'

export type SqlLineageAction = 'read' | 'insert' | 'update' | 'delete' | 'drop' | 'truncate' | 'other'

export interface SqlLineageEdge {
    objectName: string
    definitionStatementIndex: number
    referenceStatementIndex: number
    action: SqlLineageAction
}

export interface SqlUnusedSymbolInfo {
    kind: 'cte' | 'table_alias'
    name: string
    statementIndex: number
    startOffset: number
    endOffset: number
}

export interface SqlRefactorCandidate {
    type: 'inline_cte'
    cteName: string
    statementIndex: number
    reason: string
}

export interface SqlScriptFlowAnalysis {
    lineage: SqlLineageEdge[]
    unusedSymbols: SqlUnusedSymbolInfo[]
    refactorCandidates: SqlRefactorCandidate[]
}

interface StatementRangeInfo {
    index: number
    startOffset: number
    endOffset: number
    action: SqlLineageAction
}

export function analyzeSqlScriptFlow(sql: string, databaseKind?: DatabaseKind): SqlScriptFlowAnalysis {
    const statementRanges = buildStatementRanges(sql, databaseKind)
    const symbolUsages = collectSqlSymbolUsages(sql, databaseKind)

    const lineage: SqlLineageEdge[] = []
    const unusedSymbols: SqlUnusedSymbolInfo[] = []
    const refactorCandidates: SqlRefactorCandidate[] = []

    symbolUsages.forEach(symbol => {
        const definition = symbol.occurrences.find(occurrence => occurrence.role === 'definition')
        if (!definition) {
            return
        }

        const definitionStatementIndex = findStatementIndexForOffset(statementRanges, definition.startOffset)
        const references = symbol.occurrences.filter(occurrence => occurrence.role === 'reference')

        if (symbol.kind === 'table') {
            references.forEach(reference => {
                const referenceStatementIndex = findStatementIndexForOffset(statementRanges, reference.startOffset)
                lineage.push({
                    objectName: symbol.name,
                    definitionStatementIndex,
                    referenceStatementIndex,
                    action: findStatementAction(statementRanges, referenceStatementIndex)
                })
            })
            return
        }

        if ((symbol.kind === 'cte' || symbol.kind === 'table_alias') && references.length === 0) {
            unusedSymbols.push({
                kind: symbol.kind,
                name: symbol.name,
                statementIndex: definitionStatementIndex,
                startOffset: definition.startOffset,
                endOffset: definition.endOffset
            })
        }

        if (symbol.kind === 'cte' && references.length === 1) {
            refactorCandidates.push({
                type: 'inline_cte',
                cteName: symbol.name,
                statementIndex: definitionStatementIndex,
                reason: 'CTE has a single reference and can be inlined safely in most cases.'
            })
        }
    })

    return { lineage, unusedSymbols, refactorCandidates }
}

function buildStatementRanges(sql: string, databaseKind?: DatabaseKind): StatementRangeInfo[] {
    const lexResult = resolveSqlParsingRuntime({ databaseKind }).SqlLexer.tokenize(sql)
    if (lexResult.errors.length > 0 || lexResult.tokens.length === 0) {
        if (!sql.trim()) {
            return []
        }
        return [{
            index: 0,
            startOffset: 0,
            endOffset: sql.length,
            action: classifyStatementAction(sql)
        }]
    }

    const ranges: StatementRangeInfo[] = []
    let currentStart: number | undefined
    let currentEnd = 0
    let currentTokens: IToken[] = []

    lexResult.tokens.forEach(token => {
        const tokenName = token.tokenType.name
        const tokenStart = token.startOffset ?? 0
        const tokenEnd = token.endOffset !== undefined ? token.endOffset + 1 : tokenStart + token.image.length

        if (tokenName === 'Semicolon') {
            if (currentStart !== undefined) {
                const statementText = sql.substring(currentStart, tokenStart).trim()
                if (statementText.length > 0) {
                    ranges.push({
                        index: ranges.length,
                        startOffset: currentStart,
                        endOffset: tokenStart,
                        action: classifyStatementAction(statementText, currentTokens)
                    })
                }
                currentStart = undefined
                currentEnd = tokenEnd
                currentTokens = []
            }
            return
        }

        if (currentStart === undefined) {
            currentStart = tokenStart
        }
        currentEnd = tokenEnd
        currentTokens.push(token)
    })

    if (currentStart !== undefined && currentEnd >= currentStart) {
        const statementText = sql.substring(currentStart, currentEnd).trim()
        if (statementText.length > 0) {
            ranges.push({
                index: ranges.length,
                startOffset: currentStart,
                endOffset: currentEnd,
                action: classifyStatementAction(statementText, currentTokens)
            })
        }
    }

    return ranges
}

function classifyStatementAction(
    statementText: string,
    statementTokens: readonly IToken[] = [],
): SqlLineageAction {
    const normalized = statementText.trim().toUpperCase()
    const firstTokenName = statementTokens[0]?.tokenType.name
    if (firstTokenName === 'Drop' || /^DROP(?:\s|$)/.test(normalized)) {
        return 'drop'
    }
    if (firstTokenName === 'Truncate' || /^TRUNCATE(?:\s|$)/.test(normalized)) {
        return 'truncate'
    }
    if (firstTokenName === 'Update' || /^UPDATE(?:\s|$)/.test(normalized)) {
        return 'update'
    }
    if (firstTokenName === 'Insert' || /^INSERT(?:\s|$)/.test(normalized)) {
        return 'insert'
    }
    if (firstTokenName === 'Delete' || /^DELETE(?:\s|$)/.test(normalized)) {
        return 'delete'
    }
    if (firstTokenName === 'With') {
        let parenthesisDepth = 0
        for (const token of statementTokens.slice(1)) {
            const tokenName = token.tokenType.name
            if (tokenName === 'LParen') {
                parenthesisDepth += 1
                continue
            }
            if (tokenName === 'RParen') {
                parenthesisDepth = Math.max(0, parenthesisDepth - 1)
                continue
            }
            if (parenthesisDepth === 0 && tokenName === 'Insert') {
                return 'insert'
            }
        }
    }
    if (
        firstTokenName === 'Select' ||
        firstTokenName === 'With' ||
        firstTokenName === 'Create' ||
        /^SELECT(?:\s|$)/.test(normalized) ||
        /^WITH(?:\s|$)/.test(normalized) ||
        /^CREATE(?:\s|$)/.test(normalized)
    ) {
        return 'read'
    }
    return 'other'
}

function findStatementIndexForOffset(ranges: StatementRangeInfo[], offset: number): number {
    const match = ranges.find(range => offset >= range.startOffset && offset < range.endOffset)
    if (match) {
        return match.index
    }

    if (ranges.length === 0) {
        return 0
    }
    return ranges[ranges.length - 1].index
}

function findStatementAction(ranges: StatementRangeInfo[], statementIndex: number): SqlLineageAction {
    const match = ranges.find(range => range.index === statementIndex)
    return match?.action ?? 'other'
}
