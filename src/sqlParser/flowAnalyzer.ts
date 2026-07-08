import { SqlLexer } from './lexer'
import { collectSqlSymbolUsages } from './symbols'

export type SqlLineageAction = 'read' | 'update' | 'delete' | 'drop' | 'truncate' | 'other'

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

export function analyzeSqlScriptFlow(sql: string): SqlScriptFlowAnalysis {
    const statementRanges = buildStatementRanges(sql)
    const symbolUsages = collectSqlSymbolUsages(sql)

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

function buildStatementRanges(sql: string): StatementRangeInfo[] {
    const lexResult = SqlLexer.tokenize(sql)
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
                        action: classifyStatementAction(statementText)
                    })
                }
                currentStart = undefined
                currentEnd = tokenEnd
            }
            return
        }

        if (currentStart === undefined) {
            currentStart = tokenStart
        }
        currentEnd = tokenEnd
    })

    if (currentStart !== undefined && currentEnd >= currentStart) {
        const statementText = sql.substring(currentStart, currentEnd).trim()
        if (statementText.length > 0) {
            ranges.push({
                index: ranges.length,
                startOffset: currentStart,
                endOffset: currentEnd,
                action: classifyStatementAction(statementText)
            })
        }
    }

    return ranges
}

function classifyStatementAction(statementText: string): SqlLineageAction {
    const normalized = statementText.trim().toUpperCase()
    if (normalized.startsWith('DROP ')) {
        return 'drop'
    }
    if (normalized.startsWith('TRUNCATE ')) {
        return 'truncate'
    }
    if (normalized.startsWith('UPDATE ')) {
        return 'update'
    }
    if (normalized.startsWith('DELETE ')) {
        return 'delete'
    }
    if (normalized.startsWith('SELECT ') || normalized.startsWith('WITH ') || normalized.startsWith('CREATE ')) {
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
